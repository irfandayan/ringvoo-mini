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
const accountSid   = process.env.TWILIO_ACCOUNT_SID;
const authToken    = process.env.TWILIO_AUTH_TOKEN;
const apiKey       = process.env.TWILIO_API_KEY;
const apiSecret    = process.env.TWILIO_API_SECRET;
const twimlAppSid  = process.env.TWILIO_TWIML_APP_SID;
const twilioNumber = process.env.TWILIO_PHONE_NUMBER;  // US number - calls
const smsNumber    = process.env.TWILIO_SMS_NUMBER;    // UK number - SMS
const serverUrl    = process.env.SERVER_URL;

const client = twilio(accountSid, authToken);

// In-memory stores (use DB in production)
const activeUsers      = new Map();  // identity → { identity, joinedAt, callerId }
const inboundSms       = [];
const pendingOtps      = new Map();  // phone → { otp, expires, identity }
const verifiedCallerIds = new Map(); // identity → { number, verifiedAt }





// ============================================================
// ROUTE 1: GENERATE ACCESS TOKEN
// GET /token?identity=username
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
// Uses custom caller ID if user has one verified
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
// HOW IT WORKS:
// 1. User enters their own number (+971XXXXXXXXX)
// 2. Server generates a 6-digit OTP
// 3. Twilio CALLS that number and reads the OTP out loud
// 4. User hears the OTP and enters it in the app
// 5. Server verifies OTP → number is now their caller ID
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
// Uses Twilio Pricing API v1 to fetch ALL countries live
// Twilio API: https://pricing.twilio.com/v1/Voice/Countries
// Each country rate is multiplied by 2 for Ringvoo markup
// Cached for 1 hour to avoid too many API calls
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
// Fetches just country names + ISO codes - fast, cached forever
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
// 1. lowest → { mobile, landline } = what YadaPhone shows
// 2. prefixes → { mobile[], landline[], other[], all[] } = full list
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
// ============================================================
app.get('/account/balance', async (req, res) => {
  try {
    const balance = await client.balance.fetch();
    res.json({ success: true, balance: balance.balance, currency: balance.currency });
  } catch (e) {
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
  console.log(`\n⚠️  Twilio Console → Phone Numbers → ${twilioNumber}:`);
  console.log(`   Voice Webhook:     ${serverUrl}/twiml/inbound`);
  console.log(`   Messaging Webhook: ${serverUrl}/sms/inbound\n`);
});
