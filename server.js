/**
 * ============================================================
 * RINGVOO - FULL FEATURED BACKEND
 * ============================================================
 * Features:
 * 1. Access Token (browser calling)
 * 2. Outbound calls (browser → phone)
 * 3. Inbound calls (phone → browser)
 * 4. Browser → Browser calls
 * 5. Send SMS
 * 6. Receive SMS webhook
 * 7. SMS history
 * 8. Call logs
 * 9. Account balance
 * 10. Custom Caller ID with OTP verification ← NEW
 * 11. Country rates (Twilio cost + Ringvoo markup x2) ← NEW
 * ============================================================
 */

const express  = require('express');
const twilio   = require('twilio');
const cors     = require('cors');
const path     = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());
app.use(express.static(path.join(__dirname, '.')));

// ============================================================
// TWILIO SETUP
// ============================================================
// Core Twilio credentials + config, loaded from .env
const accountSid   = process.env.TWILIO_ACCOUNT_SID;
const authToken    = process.env.TWILIO_AUTH_TOKEN;
const apiKey       = process.env.TWILIO_API_KEY;         // used only for JWT access tokens
const apiSecret    = process.env.TWILIO_API_SECRET;      // used only for JWT access tokens
const twimlAppSid  = process.env.TWILIO_TWIML_APP_SID;   // TwiML App for browser calls
const twilioNumber = process.env.TWILIO_PHONE_NUMBER;    // main Twilio voice number (outgoing/incoming)
const smsNumber    = process.env.TWILIO_SMS_NUMBER;      // optional dedicated SMS number
const serverUrl    = process.env.SERVER_URL;             // public URL (ngrok) used in TwiML + webhooks

const client = twilio(accountSid, authToken);

// In-memory "database" used for demo purposes only.
// In production you would persist these in a proper DB (Redis/Postgres/etc).
const activeUsers       = new Map();   // identity → { identity, joinedAt, callerId }
const inboundSms        = [];          // latest inbound SMS messages (capped)
const pendingOtps       = new Map();   // phone → { otp, expires, identity } for caller ID verification
const verifiedCallerIds = new Map();   // identity → { number, verifiedAt }





// ============================================================
// ROUTE 1: GENERATE ACCESS TOKEN
// GET /token?identity=username
//
// Generates a short‑lived JWT access token that the frontend
// uses to create a Twilio.Device instance (browser calling).
// Also tracks the user in the in‑memory activeUsers map.
// ============================================================
app.get('/token', (req, res) => {
  const identity = req.query.identity || `user_${Date.now()}`;

  const AccessToken = twilio.jwt.AccessToken;
  const VoiceGrant  = AccessToken.VoiceGrant;

  const voiceGrant = new VoiceGrant({
    outgoingApplicationSid: twimlAppSid,
    incomingAllow: true,
  });

  const token = new AccessToken(accountSid, apiKey, apiSecret, {
    identity,
    ttl: 3600,
  });

  token.addGrant(voiceGrant);

  // Get caller ID if user has one verified
  const callerIdInfo = verifiedCallerIds.get(identity);

  activeUsers.set(identity, {
    identity,
    joinedAt: new Date(),
    callerId: callerIdInfo ? callerIdInfo.number : null,
  });

  console.log(`🎫 Token generated for: ${identity}`);
  res.json({
    token: token.toJwt(),
    identity,
    callerId: callerIdInfo ? callerIdInfo.number : null,
  });
});


// ============================================================
// ROUTE 2: OUTGOING CALL TWIML
// POST /twiml/voice
//
// Twilio hits this endpoint when the browser starts an
// outgoing call. We respond with TwiML that tells Twilio
// whether to dial a real phone number or another Twilio
// client, and which caller ID to use.
// ============================================================
app.post('/twiml/voice', (req, res) => {
  const to         = req.body.To;
  const from       = req.body.From;        // identity of caller
  const customCid  = req.body.CallerId;    // custom caller ID if passed

  // Use custom caller ID if provided, otherwise use Twilio number
  const callerId = customCid || twilioNumber;

  console.log(`📞 Outgoing: ${from} → ${to} | CallerID: ${callerId}`);

  const twiml = new twilio.twiml.VoiceResponse();

  if (!to) {
    twiml.say('No destination. Goodbye.');
    twiml.hangup();
    return res.type('text/xml').send(twiml.toString());
  }

  const dial = twiml.dial({
    callerId,
    statusCallback: `${serverUrl}/call/status`,
    statusCallbackMethod: 'POST',
    statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
  });

  if (to.startsWith('+') || to.match(/^\d+$/)) {
    dial.number(to);
    console.log(`📱 → Phone: ${to}`);
  } else {
    dial.client(to);
    console.log(`💻 → Browser: ${to}`);
  }

  res.type('text/xml').send(twiml.toString());
});


// ============================================================
// ROUTE 3: INBOUND CALL
// POST /twiml/inbound
//
// Handles calls that arrive on your Twilio phone number.
// If at least one user is online, we connect the caller
// to the first active identity. Otherwise we drop the
// caller into a simple voicemail flow.
// ============================================================
app.post('/twiml/inbound', (req, res) => {
  const { From, CallSid } = req.body;
  console.log(`📥 Inbound | From: ${From} | SID: ${CallSid}`);

  const twiml = new twilio.twiml.VoiceResponse();

  if (activeUsers.size > 0) {
    const firstUser = [...activeUsers.values()][0];
    twiml.say({ voice: 'alice' }, 'Please hold while we connect you.');
    const dial = twiml.dial({
      callerId: From,
      statusCallback: `${serverUrl}/call/status`,
      statusCallbackMethod: 'POST',
    });
    dial.client(firstUser.identity);
    console.log(`🔀 Routing to: ${firstUser.identity}`);
  } else {
    twiml.say({ voice: 'alice' },
      'Thank you for calling Ringvoo. No one is available. Please leave a message after the beep.'
    );
    twiml.record({ maxLength: 60, action: `${serverUrl}/twiml/voicemail-done` });
  }

  res.type('text/xml').send(twiml.toString());
});


// ============================================================
// ROUTE 4: VOICEMAIL DONE
//
// Called by Twilio after the caller finishes recording a
// voicemail. We just play a short confirmation message and
// hang up.
// ============================================================
app.post('/twiml/voicemail-done', (req, res) => {
  const { RecordingUrl, From, RecordingDuration } = req.body;
  console.log(`🎙️ Voicemail | From: ${From} | ${RecordingDuration}s | ${RecordingUrl}`);
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say({ voice: 'alice' }, 'Your message has been saved. Thank you. Goodbye!');
  twiml.hangup();
  res.type('text/xml').send(twiml.toString());
});


// ============================================================
// ROUTE 5: CALL STATUS
//
// Generic status callback for both inbound and outbound
// calls. This only logs events and returns 200, but you
// could extend it to persist analytics in a database.
// ============================================================
app.post('/call/status', (req, res) => {
  const { CallSid, CallStatus, Duration, To, From } = req.body;
  console.log(`📊 ${From} → ${To} | ${CallStatus} | ${Duration || 0}s`);
  res.sendStatus(200);
});


// ============================================================
// ROUTE 6: SEND OTP TO VERIFY CUSTOM CALLER ID
// POST /callerid/send-otp
// Body: { phone: "+971XXXXXXXXX", identity: "user1" }
//
// Flow:
// 1. User enters their own phone number in the frontend.
// 2. Backend generates a random 6‑digit OTP and stores it
//    in pendingOtps with a 10‑minute expiry.
// 3. Twilio places a voice call to that number and reads
//    the OTP out loud using <Say> TwiML.
// 4. User types the OTP into the app to prove ownership.
// ============================================================
app.post('/callerid/send-otp', async (req, res) => {
  const { phone, identity } = req.body;

  if (!phone || !identity) {
    return res.status(400).json({ success: false, error: 'phone and identity required' });
  }

  // Generate 6-digit OTP
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  const expires = Date.now() + (10 * 60 * 1000); // expires in 10 minutes

  // Store OTP
  pendingOtps.set(phone, { otp, expires, identity });

  try {
    /**
     * Call the user's number and READ the OTP out loud
     * This proves they OWN that number (only they can answer)
     * This is the standard way to verify caller ID ownership!
     */
    const call = await client.calls.create({
      to:   phone,
      from: twilioNumber,
      twiml: `
        <Response>
          <Say voice="alice" language="en-US">
            Hello! Your Ringvoo verification code is:
            ${otp.split('').join('. ')}.
            I repeat:
            ${otp.split('').join('. ')}.
            This code expires in 10 minutes.
          </Say>
          <Pause length="1"/>
          <Say voice="alice">Thank you. Goodbye!</Say>
        </Response>
      `,
    });

    console.log(`📞 OTP call sent to ${phone} | OTP: ${otp} | SID: ${call.sid}`);

    res.json({
      success: true,
      message: `Verification call sent to ${phone}. You will receive a call with your 6-digit code.`,
      callSid: call.sid,
      // Remove otp from response in production! Only for testing:
      debug_otp: otp,
    });

  } catch (e) {
    console.error(`❌ OTP call failed: ${e.message}`);
    pendingOtps.delete(phone);
    res.status(400).json({ success: false, error: e.message });
  }
});


// ============================================================
// ROUTE 7: VERIFY OTP AND SAVE CUSTOM CALLER ID
// POST /callerid/verify-otp
// Body: { phone: "+971XXXXXXXXX", otp: "123456", identity: "user1" }
//
// Validates the OTP from pendingOtps, then stores the
// verified number in verifiedCallerIds and attaches it to
// the active user so future calls can use it as caller ID.
// ============================================================
app.post('/callerid/verify-otp', (req, res) => {
  const { phone, otp, identity } = req.body;

  if (!phone || !otp || !identity) {
    return res.status(400).json({ success: false, error: 'phone, otp and identity required' });
  }

  const pending = pendingOtps.get(phone);

  if (!pending) {
    return res.status(400).json({ success: false, error: 'No pending verification for this number. Request a new code.' });
  }

  if (Date.now() > pending.expires) {
    pendingOtps.delete(phone);
    return res.status(400).json({ success: false, error: 'OTP expired. Please request a new code.' });
  }

  if (pending.otp !== otp) {
    return res.status(400).json({ success: false, error: 'Invalid OTP. Please try again.' });
  }

  if (pending.identity !== identity) {
    return res.status(400).json({ success: false, error: 'Identity mismatch.' });
  }

  // OTP is correct! Save verified caller ID
  verifiedCallerIds.set(identity, {
    number: phone,
    verifiedAt: new Date(),
  });

  // Update active user's caller ID
  if (activeUsers.has(identity)) {
    const user = activeUsers.get(identity);
    user.callerId = phone;
    activeUsers.set(identity, user);
  }

  // Clean up OTP
  pendingOtps.delete(phone);

  console.log(`✅ Caller ID verified: ${identity} → ${phone}`);

  res.json({
    success: true,
    message: `${phone} verified successfully! This number will now show as your caller ID.`,
    callerId: phone,
  });
});


// ============================================================
// ROUTE 8: GET VERIFIED CALLER ID
// GET /callerid/:identity
//
// Simple helper for the frontend to show the currently
// verified caller ID for a given identity.
// ============================================================
app.get('/callerid/:identity', (req, res) => {
  const info = verifiedCallerIds.get(req.params.identity);
  res.json({
    success: true,
    callerId: info ? info.number : null,
    verifiedAt: info ? info.verifiedAt : null,
  });
});


// ============================================================
// ROUTE 9: REMOVE CUSTOM CALLER ID
// DELETE /callerid/:identity
//
// Clears the verified caller ID for an identity, both from
// verifiedCallerIds and from the activeUsers map.
// ============================================================
app.delete('/callerid/:identity', (req, res) => {
  verifiedCallerIds.delete(req.params.identity);
  if (activeUsers.has(req.params.identity)) {
    const user = activeUsers.get(req.params.identity);
    user.callerId = null;
    activeUsers.set(req.params.identity, user);
  }
  console.log(`🗑️ Caller ID removed for: ${req.params.identity}`);
  res.json({ success: true, message: 'Custom caller ID removed.' });
});


// ============================================================
// ROUTE 10: GET COUNTRY RATES - LIVE FROM TWILIO PRICING API
// GET /rates
// GET /rates?search=UAE
//
// Uses Twilio Pricing API v1 to fetch outbound call prices
// per country. The frontend then:
// - shows "lowest" mobile + landline rates (what end users see)
// - shows full prefix breakdown for power users
//
// Business rule: Ringvoo rate = 2 × Twilio rate (markup).
// ============================================================

// Country list cache (just names + ISO codes - tiny, load once)
let countriesCache = null;

// Country flag emoji map
const FLAG_MAP = {
  US:'🇺🇸',CA:'🇨🇦',GB:'🇬🇧',DE:'🇩🇪',FR:'🇫🇷',IT:'🇮🇹',ES:'🇪🇸',NL:'🇳🇱',
  SE:'🇸🇪',NO:'🇳🇴',DK:'🇩🇰',FI:'🇫🇮',CH:'🇨🇭',AT:'🇦🇹',BE:'🇧🇪',PT:'🇵🇹',
  IE:'🇮🇪',PL:'🇵🇱',CZ:'🇨🇿',HU:'🇭🇺',RO:'🇷🇴',BG:'🇧🇬',HR:'🇭🇷',SK:'🇸🇰',
  AE:'🇦🇪',SA:'🇸🇦',PK:'🇵🇰',QA:'🇶🇦',KW:'🇰🇼',BH:'🇧🇭',OM:'🇴🇲',JO:'🇯🇴',
  LB:'🇱🇧',IQ:'🇮🇶',TR:'🇹🇷',IN:'🇮🇳',CN:'🇨🇳',JP:'🇯🇵',SG:'🇸🇬',MY:'🇲🇾',
  PH:'🇵🇭',ID:'🇮🇩',BD:'🇧🇩',LK:'🇱🇰',NP:'🇳🇵',TH:'🇹🇭',VN:'🇻🇳',KR:'🇰🇷',
  HK:'🇭🇰',AU:'🇦🇺',NZ:'🇳🇿',ZA:'🇿🇦',NG:'🇳🇬',KE:'🇰🇪',EG:'🇪🇬',GH:'🇬🇭',
  MX:'🇲🇽',BR:'🇧🇷',AR:'🇦🇷',CO:'🇨🇴',CL:'🇨🇱',RU:'🇷🇺',UA:'🇺🇦',IL:'🇮🇱',
  GR:'🇬🇷',RS:'🇷🇸',AF:'🇦🇫',PY:'🇵🇾',UY:'🇺🇾',PE:'🇵🇪',EC:'🇪🇨',BO:'🇧🇴',
  VE:'🇻🇪',TZ:'🇹🇿',UG:'🇺🇬',ET:'🇪🇹',TN:'🇹🇳',MA:'🇲🇦',
};

const authHeader = () => 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64');

// ============================================================
// ROUTE 10a: GET ALL COUNTRIES LIST (for dropdown)
// GET /rates/countries
//
// Fetches just country name + ISO code + flag emoji.
// This is used to populate the country <select> on the
// Rates tab. Response is cached in memory for speed.
// ============================================================
app.get('/rates/countries', async (req, res) => {
  try {
    if (countriesCache) {
      return res.json({ success: true, countries: countriesCache });
    }

    const r = await fetch('https://pricing.twilio.com/v1/Voice/Countries?PageSize=300', {
      headers: { 'Authorization': authHeader() }
    });
    const data = await r.json();

    countriesCache = (data.countries || [])
      .map(c => ({
        name:    c.country,
        isoCode: c.iso_country,
        flag:    FLAG_MAP[c.iso_country] || '🌍',
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    console.log(`📋 Loaded ${countriesCache.length} countries for dropdown`);
    res.json({ success: true, countries: countriesCache });

  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});


// ============================================================
// ROUTE 10b: GET RATE FOR ONE SPECIFIC COUNTRY
// GET /rates/country/:isoCode
//
// Returns TWO sections:
// 1. lowest  → { mobile, landline }  (simple card view)
// 2. prefixes→ { mobile[], landline[], other[], all[] } (full breakdown)
// ============================================================

const MOBILE_KEYWORDS   = ['mobile', 'cell', 'wireless', 'gsm'];
const LANDLINE_KEYWORDS = ['local', 'fixed', 'national', 'landline', 'geographic', 'standard'];

app.get('/rates/country/:isoCode', async (req, res) => {
  const iso = req.params.isoCode.toUpperCase();

  try {
    const r = await fetch(`https://pricing.twilio.com/v1/Voice/Countries/${iso}`, {
      headers: { 'Authorization': authHeader() }
    });
    const data = await r.json();

    if (!data.outbound_prefix_prices || data.outbound_prefix_prices.length === 0) {
      return res.json({ success: false, error: 'No pricing available for this country' });
    }

    // Build full prefix list sorted by price
    const allPrefixes = data.outbound_prefix_prices
      .map(p => ({
        description: p.friendly_name || 'Standard',
        prefixes:    p.prefixes ? p.prefixes.join(', ') : '',
        twilioRate:  parseFloat(p.base_price || p.current_price || 0),
        ringvooRate: parseFloat(p.base_price || p.current_price || 0) * 2,
      }))
      .filter(p => p.twilioRate > 0)
      .sort((a, b) => a.twilioRate - b.twilioRate);

    // ── Categorize into Mobile vs Landline ──
    let mobileRates   = [];
    let landlineRates = [];
    let otherRates    = [];

    allPrefixes.forEach(p => {
      const name = p.description.toLowerCase();
      if (MOBILE_KEYWORDS.some(k => name.includes(k))) {
        mobileRates.push(p);
      } else if (LANDLINE_KEYWORDS.some(k => name.includes(k))) {
        landlineRates.push(p);
      } else {
        otherRates.push(p);
      }
    });

    // Fallback: if no mobile found use lowest overall
    if (mobileRates.length === 0) mobileRates = [allPrefixes[0]];
    // Fallback: if no landline found use second lowest or same
    if (landlineRates.length === 0) {
      landlineRates = allPrefixes.length > 1 ? [allPrefixes[1]] : [allPrefixes[0]];
    }

    const lowestMobile   = Math.min(...mobileRates.map(p => p.twilioRate));
    const lowestLandline = Math.min(...landlineRates.map(p => p.twilioRate));

    console.log(`💰 ${iso} | 📱 Mobile: $${lowestMobile} | ☎️ Landline: $${lowestLandline}`);

    res.json({
      success: true,
      country: data.country,
      isoCode: iso,
      flag:    FLAG_MAP[iso] || '🌍',

      // ── SECTION 1: Lowest rates (simple view like YadaPhone) ──
      lowest: {
        mobile: {
          twilioRate:  lowestMobile,
          ringvooRate: lowestMobile * 2,
          profit:      lowestMobile,
        },
        landline: {
          twilioRate:  lowestLandline,
          ringvooRate: lowestLandline * 2,
          profit:      lowestLandline,
        },
      },

      // ── SECTION 2: Full prefix breakdown ──
      prefixes: {
        mobile:   mobileRates,
        landline: landlineRates,
        other:    otherRates,
        all:      allPrefixes,
      },
    });

  } catch(e) {
    res.status(500).json({ success: false, error: e.message });
  }
});


// ============================================================
// ROUTE 11: SEND SMS
// POST /sms/send
//
// Sends an outgoing SMS using either the dedicated SMS
// number (smsNumber) or, if not configured, the main
// voice number (twilioNumber) as the sender.
// ============================================================
app.post('/sms/send', async (req, res) => {
  const { to, message } = req.body;
  if (!to || !message) {
    return res.status(400).json({ success: false, error: 'to and message required' });
  }
  try {
    const msg = await client.messages.create({
      to,
      from: smsNumber || twilioNumber,
      body: message,
    });
    console.log(`📤 SMS → ${to} | ${msg.sid}`);
    res.json({ success: true, sid: msg.sid, to: msg.to, from: msg.from, status: msg.status, body: msg.body });
  } catch (e) {
    console.error(`❌ SMS failed: ${e.message}`);
    res.status(400).json({ success: false, error: e.message });
  }
});


// ============================================================
// ROUTE 12: INBOUND SMS WEBHOOK
// POST /sms/inbound
//
// Twilio calls this webhook whenever your number receives
// an SMS. We push the message into an in‑memory list so
// the frontend can display a short inbox.
// ============================================================
app.post('/sms/inbound', (req, res) => {
  const { From, To, Body, MessageSid } = req.body;
  console.log(`📩 Inbound SMS | From: ${From} | "${Body}"`);
  inboundSms.unshift({ sid: MessageSid, from: From, to: To, body: Body, direction: 'inbound', status: 'received', dateSent: new Date().toISOString() });
  if (inboundSms.length > 50) inboundSms.pop();
  const twiml = new twilio.twiml.MessagingResponse();
  res.type('text/xml').send(twiml.toString());
});


// ============================================================
// ROUTE 13: SMS LOGS
// GET /sms/logs
//
// Fetches recent messages directly from Twilio so you can
// see both inbound and outbound SMS history in the UI.
// ============================================================
app.get('/sms/logs', async (req, res) => {
  try {
    const messages = await client.messages.list({ limit: 30 });
    res.json({
      success: true,
      count: messages.length,
      messages: messages.map(m => ({
        sid: m.sid, to: m.to, from: m.from, body: m.body,
        status: m.status, direction: m.direction, price: m.price, dateSent: m.dateSent,
      }))
    });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});


// ============================================================
// ROUTE 14: ACTIVE USERS
//
// Simple helpers to see/remove the identities that have
// recently requested an access token.
// ============================================================
app.get('/users/active', (req, res) => {
  res.json({ success: true, count: activeUsers.size, users: [...activeUsers.values()] });
});

app.delete('/users/:identity', (req, res) => {
  activeUsers.delete(req.params.identity);
  res.json({ success: true });
});


// ============================================================
// ROUTE 15: CALL LOGS
//
// Lists recent calls for analytics/debugging in the Calls
// tab. Data comes from Twilio's Calls API.
// ============================================================
app.get('/calls/logs', async (req, res) => {
  try {
    const calls = await client.calls.list({ limit: 20 });
    res.json({
      success: true,
      calls: calls.map(c => ({
        sid: c.sid, to: c.to, from: c.from, status: c.status,
        direction: c.direction, duration: c.duration, price: c.price, startTime: c.startTime,
      }))
    });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});


// ============================================================
// ROUTE 16: ACCOUNT BALANCE
//
// Shows the current Twilio account balance + currency so
// you can keep an eye on credit while testing.
// ============================================================
app.get('/account/balance', async (req, res) => {
  try {
    const balance = await client.balance.fetch();
    res.json({ success: true, balance: balance.balance, currency: balance.currency });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});


// ============================================================
// ROUTE 17: SEARCH AVAILABLE NUMBERS
// GET /numbers/search
// Query: country=US|CA, type=local|mobile|tollfree, areaCode, limit
//
// Uses Twilio's Available Phone Numbers API to search for
// numbers that match the filters. We only return numbers
// that support voice or SMS so they are actually usable.
// ============================================================
app.get('/numbers/search', async (req, res) => {
  const country  = (req.query.country || '').toUpperCase();
  const typeRaw  = (req.query.type || 'local').toLowerCase();
  const areaCode = req.query.areaCode;
  const limit    = parseInt(req.query.limit, 10) || 10;

  if (!['US', 'CA'].includes(country)) {
    return res.status(400).json({ success: false, error: 'country must be US or CA' });
  }

  const type = ['local', 'mobile', 'tollfree'].includes(typeRaw) ? typeRaw : 'local';

  console.log(`🔎 Searching numbers | country=${country} | type=${type} | areaCode=${areaCode || 'any'} | limit=${limit}`);

  try {
    let search;
    const commonFilters = {
      limit,
      voiceEnabled: true,
      smsEnabled: true,
    };

    if (type === 'local') {
      // Standard geographic numbers
      search = client.availablePhoneNumbers(country).local;
    } else if (type === 'mobile') {
      /**
       * Twilio only exposes the "Mobile" sub-resource for certain countries.
       * For US/CA mobile numbers are returned under the "local" resource with
       * smsEnabled=true. To keep this demo simple, we:
       * - use the dedicated .mobile resource when it exists (non‑US/CA),
       * - but for US/CA we just search local numbers and rely on smsEnabled.
       */
      if (['US', 'CA'].includes(country)) {
        search = client.availablePhoneNumbers(country).local;
      } else {
        search = client.availablePhoneNumbers(country).mobile;
      }
    } else {
      // Toll-free numbers
      search = client.availablePhoneNumbers(country).tollFree;
    }

    const opts = { ...commonFilters };
    if (areaCode && country === 'US') {
      opts.areaCode = areaCode;
    }

    const numbers = await search.list(opts);

    const filtered = numbers
      .filter(n => {
        const caps = n.capabilities || {};
        const voice = caps.voice === true || caps.Voice === true;
        const sms   = caps.sms === true   || caps.SMS === true;
        return voice || sms;
      })
      .map(n => ({
        phoneNumber: n.phoneNumber,
        friendlyName: n.friendlyName,
        locality: n.locality,
        region: n.region,
        capabilities: {
          voice: !!(n.capabilities && (n.capabilities.voice || n.capabilities.Voice)),
          sms:   !!(n.capabilities && (n.capabilities.sms   || n.capabilities.SMS)),
          mms:   !!(n.capabilities && (n.capabilities.mms   || n.capabilities.MMS)),
        },
      }));

    res.json({
      success: true,
      country,
      count: filtered.length,
      numbers: filtered,
    });

  } catch (e) {
    console.error(`❌ Number search failed: ${e.message}`);
    res.status(400).json({ success: false, error: e.message });
  }
});


// ============================================================
// ROUTE 18: PURCHASE NUMBER
// POST /numbers/buy
// Body: { "phoneNumber": "+14155551234" }
//
// Actually buys a phone number from Twilio and wires
// voiceUrl + smsUrl so inbound calls/SMS are routed back
// into this same Express server.
// ============================================================
app.post('/numbers/buy', async (req, res) => {
  const { phoneNumber } = req.body;

  if (!phoneNumber) {
    return res.status(400).json({ success: false, error: 'phoneNumber is required' });
  }

  console.log(`🛒 Purchasing number: ${phoneNumber}`);

  try {
    const purchased = await client.incomingPhoneNumbers.create({
      phoneNumber,
      voiceUrl: `${serverUrl}/twiml/inbound`,
      smsUrl:   `${serverUrl}/sms/inbound`,
    });

    console.log(`📞 Number purchased: ${purchased.phoneNumber} | SID: ${purchased.sid}`);

    res.json({
      success: true,
      sid: purchased.sid,
      phoneNumber: purchased.phoneNumber,
    });

  } catch (e) {
    console.error(`❌ Number purchase failed: ${e.message}`);
    res.status(400).json({ success: false, error: e.message });
  }
});


// ============================================================
// ROUTE 19: LIST OWNED NUMBERS
// GET /numbers/list
//
// Convenience endpoint for the Numbers tab to show all
// Twilio phone numbers currently owned by this account.
// ============================================================
app.get('/numbers/list', async (req, res) => {
  console.log('📱 Owned numbers loaded');

  try {
    const numbers = await client.incomingPhoneNumbers.list();

    const formatted = numbers.map(n => ({
      sid: n.sid,
      phoneNumber: n.phoneNumber,
      friendlyName: n.friendlyName,
      voiceUrl: n.voiceUrl,
      smsUrl: n.smsUrl,
    }));

    console.log(`📱 Owned numbers loaded: ${formatted.length}`);

    res.json({
      success: true,
      count: formatted.length,
      numbers: formatted,
    });

  } catch (e) {
    console.error(`❌ Failed to load owned numbers: ${e.message}`);
    res.status(400).json({ success: false, error: e.message });
  }
});


const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🚀 Ringvoo running on port ${PORT}`);
  console.log(`\n📖 API Endpoints:`);
  console.log(`   GET    /token                → Browser access token`);
  console.log(`   POST   /twiml/voice          → Outgoing call TwiML`);
  console.log(`   POST   /twiml/inbound        → Inbound call webhook`);
  console.log(`   POST   /callerid/send-otp    → Send OTP to verify caller ID`);
  console.log(`   POST   /callerid/verify-otp  → Verify OTP + save caller ID`);
  console.log(`   GET    /callerid/:identity   → Get verified caller ID`);
  console.log(`   DELETE /callerid/:identity   → Remove caller ID`);
  console.log(`   GET    /rates                → Country rates`);
  console.log(`   GET    /rates?search=UAE     → Search rates`);
  console.log(`   POST   /sms/send             → Send SMS`);
  console.log(`   POST   /sms/inbound          → Inbound SMS webhook`);
  console.log(`   GET    /sms/logs             → SMS history`);
  console.log(`   GET    /calls/logs           → Call history`);
  console.log(`   GET    /account/balance      → Balance`);
  console.log(`   GET    /numbers/search       → Find available numbers`);
  console.log(`   POST   /numbers/buy          → Purchase number`);
  console.log(`   GET    /numbers/list         → List owned numbers`);
  console.log(`\n⚠️  Twilio Console → Phone Numbers → ${twilioNumber}:`);
  console.log(`   Voice Webhook:     ${serverUrl}/twiml/inbound`);
  console.log(`   Messaging Webhook: ${serverUrl}/sms/inbound\n`);
});
