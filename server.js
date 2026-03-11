/**
 * ============================================================
 * RINGVOO - FULL FEATURED BACKEND
 * ============================================================
 * Features:
 * 1. Access Token (browser calling)
 * 2. Outbound calls (browser → phone)
 * 3. Inbound calls (phone → browser) ← NEW
 * 4. Browser → Browser calls
 * 5. Send SMS ← NEW
 * 6. Receive SMS webhook ← NEW
 * 7. SMS history ← NEW
 * 8. Call logs
 * 9. Account balance
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
const twilioNumber = process.env.TWILIO_PHONE_NUMBER;
const serverUrl    = process.env.SERVER_URL;

const client = twilio(accountSid, authToken);

// In-memory stores (use DB in production)
const activeUsers = new Map();
const inboundSms  = [];


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
    incomingAllow: true,  // Allow browser to RECEIVE inbound calls
  });

  const token = new AccessToken(accountSid, apiKey, apiSecret, {
    identity,
    ttl: 3600,
  });

  token.addGrant(voiceGrant);
  activeUsers.set(identity, { identity, joinedAt: new Date() });
  console.log(`🎫 Token generated for: ${identity}`);

  res.json({ token: token.toJwt(), identity });
});


// ============================================================
// ROUTE 2: OUTGOING CALL TWIML
// POST /twiml/voice  ← Set this as TwiML App Voice URL
// ============================================================
app.post('/twiml/voice', (req, res) => {
  const to       = req.body.To;
  const from     = req.body.From;
  const callerId = twilioNumber;

  console.log(`📞 Outgoing: ${from} → ${to}`);

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

  res.type('text/xml');
  res.send(twiml.toString());
});


// ============================================================
// ROUTE 3: INBOUND CALL HANDLER
// POST /twiml/inbound
//
// ⚠️ SETUP REQUIRED:
// Twilio Console → Phone Numbers → Active Numbers → your number
// Voice & Fax → A Call Comes In → Webhook
// URL: https://your-ngrok-url/twiml/inbound
// Method: HTTP POST
//
// When someone calls +18153678725 → Twilio hits this URL
// ============================================================
app.post('/twiml/inbound', (req, res) => {
  const { From, To, CallSid } = req.body;
  console.log(`📥 Inbound call | From: ${From} | SID: ${CallSid}`);

  const twiml = new twilio.twiml.VoiceResponse();

  if (activeUsers.size > 0) {
    const firstUser = [...activeUsers.values()][0];
    twiml.say({ voice: 'alice' }, 'Please hold while we connect you.');

    const dial = twiml.dial({
      callerId: From,
      statusCallback: `${serverUrl}/call/status`,
      statusCallbackMethod: 'POST',
    });

    // Route to browser user - this makes the incoming call popup appear!
    dial.client(firstUser.identity);
    console.log(`🔀 Routing to browser: ${firstUser.identity}`);

  } else {
    // No one online → voicemail
    twiml.say({ voice: 'alice' },
      'Thank you for calling Ringvoo. No one is available. Please leave a message after the beep.'
    );
    twiml.record({
      maxLength: 60,
      action: `${serverUrl}/twiml/voicemail-done`,
    });
  }

  res.type('text/xml');
  res.send(twiml.toString());
});


// ============================================================
// ROUTE 4: VOICEMAIL DONE
// POST /twiml/voicemail-done
// ============================================================
app.post('/twiml/voicemail-done', (req, res) => {
  const { RecordingUrl, From, RecordingDuration } = req.body;
  console.log(`🎙️ Voicemail | From: ${From} | Duration: ${RecordingDuration}s`);
  console.log(`   URL: ${RecordingUrl}`);

  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say({ voice: 'alice' }, 'Your message has been saved. Thank you. Goodbye!');
  twiml.hangup();

  res.type('text/xml').send(twiml.toString());
});


// ============================================================
// ROUTE 5: CALL STATUS WEBHOOK
// POST /call/status
// ============================================================
app.post('/call/status', (req, res) => {
  const { CallSid, CallStatus, Duration, To, From } = req.body;
  console.log(`📊 ${From} → ${To} | ${CallStatus} | ${Duration || 0}s`);
  res.sendStatus(200);
});


// ============================================================
// ROUTE 6: SEND SMS
// POST /sms/send
// Body: { to: "+971XXXXXXXXX", message: "Hello!" }
//
// ⚠️ NOTE: In trial mode SMS can only go to verified numbers
// After upgrade: send to anyone!
// ============================================================
app.post('/sms/send', async (req, res) => {
  const { to, message } = req.body;

  if (!to || !message) {
    return res.status(400).json({ success: false, error: 'to and message required' });
  }

  try {
    /**
     * client.messages.create() = The Twilio SMS API
     * Super simple compared to voice calls!
     */
    const msg = await client.messages.create({
      to:   to,
      from: twilioNumber,
      body: message,
    });

    console.log(`📤 SMS sent → ${to} | SID: ${msg.sid} | Status: ${msg.status}`);

    res.json({
      success: true,
      sid:     msg.sid,
      to:      msg.to,
      from:    msg.from,
      status:  msg.status,
      body:    msg.body,
    });

  } catch (e) {
    console.error(`❌ SMS failed: ${e.message}`);
    res.status(400).json({ success: false, error: e.message });
  }
});


// ============================================================
// ROUTE 7: RECEIVE INBOUND SMS
// POST /sms/inbound
//
// ⚠️ SETUP REQUIRED:
// Twilio Console → Phone Numbers → Active Numbers → your number
// Messaging → A Message Comes In → Webhook
// URL: https://your-ngrok-url/sms/inbound
// Method: HTTP POST
//
// When someone texts +18153678725 → Twilio hits this URL
// ============================================================
app.post('/sms/inbound', (req, res) => {
  const { From, To, Body, MessageSid } = req.body;

  console.log(`📩 Inbound SMS | From: ${From} | Message: "${Body}"`);

  // Store in memory
  inboundSms.unshift({
    sid:       MessageSid,
    from:      From,
    to:        To,
    body:      Body,
    direction: 'inbound',
    status:    'received',
    dateSent:  new Date().toISOString(),
  });

  if (inboundSms.length > 50) inboundSms.pop();

  /**
   * Return TwiML - you can auto-reply or just return empty
   * Uncomment the message() line to send an auto-reply
   */
  const twiml = new twilio.twiml.MessagingResponse();
  // twiml.message('Thanks for your message! We will reply soon. - Ringvoo');

  res.type('text/xml').send(twiml.toString());
});


// ============================================================
// ROUTE 8: GET SMS LOGS
// GET /sms/logs
// Returns sent + received messages from Twilio
// ============================================================
app.get('/sms/logs', async (req, res) => {
  try {
    const messages = await client.messages.list({ limit: 30 });

    const formatted = messages.map(m => ({
      sid:       m.sid,
      to:        m.to,
      from:      m.from,
      body:      m.body,
      status:    m.status,
      direction: m.direction,
      price:     m.price,
      dateSent:  m.dateSent,
    }));

    res.json({ success: true, count: formatted.length, messages: formatted });

  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});


// ============================================================
// ROUTE 9: ACTIVE USERS
// GET /users/active
// ============================================================
app.get('/users/active', (req, res) => {
  res.json({ success: true, count: activeUsers.size, users: [...activeUsers.values()] });
});


// ============================================================
// ROUTE 10: USER OFFLINE
// DELETE /users/:identity
// ============================================================
app.delete('/users/:identity', (req, res) => {
  activeUsers.delete(req.params.identity);
  console.log(`👋 Offline: ${req.params.identity}`);
  res.json({ success: true });
});


// ============================================================
// ROUTE 11: CALL LOGS
// GET /calls/logs
// ============================================================
app.get('/calls/logs', async (req, res) => {
  try {
    const calls = await client.calls.list({ limit: 20 });
    res.json({
      success: true,
      calls: calls.map(c => ({
        sid:       c.sid,
        to:        c.to,
        from:      c.from,
        status:    c.status,
        direction: c.direction,
        duration:  c.duration,
        price:     c.price,
        startTime: c.startTime,
      }))
    });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});


// ============================================================
// ROUTE 12: ACCOUNT BALANCE
// GET /account/balance
// ============================================================
app.get('/account/balance', async (req, res) => {
  try {
    const balance = await client.balance.fetch();
    res.json({ success: true, balance: balance.balance, currency: balance.currency });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});


// Start server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🚀 Ringvoo running on port ${PORT}`);
  console.log(`\n📖 API Endpoints:`);
  console.log(`   GET    /token           → Browser access token`);
  console.log(`   POST   /twiml/voice     → Outgoing call TwiML (TwiML App URL)`);
  console.log(`   POST   /twiml/inbound   → Inbound call webhook`);
  console.log(`   POST   /sms/send        → Send SMS`);
  console.log(`   POST   /sms/inbound     → Inbound SMS webhook`);
  console.log(`   GET    /sms/logs        → SMS history`);
  console.log(`   GET    /calls/logs      → Call history`);
  console.log(`   GET    /account/balance → Balance`);
  console.log(`\n⚠️  Update these in Twilio Console → Phone Numbers → ${twilioNumber}:`);
  console.log(`   Voice Webhook:     ${serverUrl}/twiml/inbound`);
  console.log(`   Messaging Webhook: ${serverUrl}/sms/inbound\n`);
});
