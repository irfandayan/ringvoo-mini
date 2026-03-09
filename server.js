/**
 * ============================================================
 * YADAPHONE MINI CLONE - FULL BROWSER CALLING BACKEND
 * ============================================================
 * 
 * WHAT'S NEW vs mini project:
 * 1. Access Token generation (needed for browser SDK)
 * 2. TwiML App routing (browser → phone)
 * 3. Browser → Phone calls
 * 4. Phone → Browser (inbound to browser)
 * 5. Browser → Browser (two users)
 * 6. Call queuing & identity system
 * ============================================================
 */

const express = require('express');
const twilio  = require('twilio');
const cors    = require('cors');
require('dotenv').config();

const path = require('path');





const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());



app.use(express.static(path.join(__dirname, '.')));
// ============================================================
// TWILIO SETUP
// ============================================================
const accountSid    = process.env.TWILIO_ACCOUNT_SID;
const authToken     = process.env.TWILIO_AUTH_TOKEN;
const apiKey        = process.env.TWILIO_API_KEY;        // NEW: needed for Access Tokens
const apiSecret     = process.env.TWILIO_API_SECRET;     // NEW: needed for Access Tokens
const twimlAppSid   = process.env.TWILIO_TWIML_APP_SID;  // NEW: TwiML App SID
const twilioNumber  = process.env.TWILIO_PHONE_NUMBER;
const serverUrl     = process.env.SERVER_URL;

const client = twilio(accountSid, authToken);

// In-memory store for active users (use Redis/DB in production)
const activeUsers = new Map(); // identity → { identity, joinedAt }


// ============================================================
// ROUTE 1: GENERATE ACCESS TOKEN
// GET /token?identity=username
// 
// THIS IS THE KEY CONCEPT FOR BROWSER CALLING!
// Your server generates a short-lived token.
// The browser uses this token to connect to Twilio.
// 
// Flow: Browser → GET /token → your server → returns JWT token
//       Browser → uses token → connects to Twilio directly
// ============================================================
app.get('/token', (req, res) => {
  const identity = req.query.identity || `user_${Date.now()}`;

  /**
   * AccessToken = JWT that gives browser permission to use Twilio
   * 
   * You need:
   * - accountSid   (from console)
   * - apiKey       (create in console → API Keys)
   * - apiSecret    (shown once when creating API key)
   * - twimlAppSid  (create in console → TwiML Apps)
   */
  const AccessToken = twilio.jwt.AccessToken;
  const VoiceGrant  = AccessToken.VoiceGrant;

  // Create voice grant - this gives permission to make/receive calls
  const voiceGrant = new VoiceGrant({
    outgoingApplicationSid: twimlAppSid,  // Which TwiML App handles outgoing calls
    incomingAllow: true,                   // Allow this browser to RECEIVE calls
  });

  // Create the token
  const token = new AccessToken(accountSid, apiKey, apiSecret, {
    identity: identity,   // Who is this token for (username)
    ttl: 3600,            // Token expires in 1 hour
  });

  token.addGrant(voiceGrant);

  // Track active user
  activeUsers.set(identity, { identity, joinedAt: new Date() });

  console.log(`🎫 Token generated for: ${identity}`);

  res.json({
    token: token.toJwt(),   // Send JWT to browser
    identity: identity,
  });
});


// ============================================================
// ROUTE 2: TWIML APP WEBHOOK - Handle OUTGOING calls from browser
// POST /twiml/voice
// 
// When browser makes a call, Twilio hits THIS URL asking "what to do?"
// We check: is the 'To' a phone number or another browser user?
// ============================================================
app.post('/twiml/voice', (req, res) => {
  const to       = req.body.To;       // Who to call
  const from     = req.body.From;     // Caller identity
  const callerId = twilioNumber;      // Your Twilio number shows as caller ID

  console.log(`📞 Outgoing call: ${from} → ${to}`);

  const twiml = new twilio.twiml.VoiceResponse();

  if (!to) {
    twiml.say('No destination specified. Goodbye.');
    twiml.hangup();
    res.type('text/xml');
    res.send(twiml.toString());
    return;
  }

  const dial = twiml.dial({ callerId });

  if (to.startsWith('+') || to.match(/^\d+$/)) {
    /**
     * CASE 1: Calling a REAL PHONE NUMBER
     * to = "+971527459432"
     * Use <Number> to dial a real phone
     */
    dial.number(to);
    console.log(`📱 Routing to phone: ${to}`);

  } else {
    /**
     * CASE 2: Calling another BROWSER USER
     * to = "username" (another person using the app)
     * Use <Client> to dial another browser
     */
    dial.client(to);
    console.log(`💻 Routing to browser client: ${to}`);
  }

  res.type('text/xml');
  res.send(twiml.toString());
});


// ============================================================
// ROUTE 3: INBOUND CALL HANDLER
// POST /twiml/inbound
// When someone calls your Twilio number from a real phone
// Route it to a browser user
// ============================================================
app.post('/twiml/inbound', (req, res) => {
  const from = req.body.From;
  console.log(`📥 Inbound call from: ${from}`);

  const twiml = new twilio.twiml.VoiceResponse();

  // Check if any browser users are online
  if (activeUsers.size > 0) {
    const firstUser = [...activeUsers.values()][0];

    twiml.say({ voice: 'alice' }, `Connecting you now.`);

    const dial = twiml.dial({ callerId: from });
    /**
     * <Client> routes the call to a browser user by their identity
     * This is how "Phone → Browser" works!
     */
    dial.client(firstUser.identity);

    console.log(`🔀 Routing inbound to: ${firstUser.identity}`);
  } else {
    // No one online - play voicemail
    twiml.say({ voice: 'alice' },
      'No agents are available right now. Please leave a message after the beep.'
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
  const { RecordingUrl, CallSid, From } = req.body;
  console.log(`🎙️ Voicemail from ${From}: ${RecordingUrl}`);

  // In production: save to DB, send email notification, etc.

  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say({ voice: 'alice' }, 'Your message has been saved. Thank you. Goodbye!');
  twiml.hangup();

  res.type('text/xml');
  res.send(twiml.toString());
});


// ============================================================
// ROUTE 5: CALL STATUS WEBHOOK
// POST /call/status
// ============================================================
app.post('/call/status', (req, res) => {
  const { CallSid, CallStatus, Duration, To, From } = req.body;
  console.log(`📊 ${CallSid} | ${From} → ${To} | ${CallStatus} | ${Duration || 0}s`);
  res.sendStatus(200);
});


// ============================================================
// ROUTE 6: GET ACTIVE USERS
// GET /users/active
// Who is currently online in the browser
// ============================================================
app.get('/users/active', (req, res) => {
  const users = [...activeUsers.values()];
  res.json({ success: true, count: users.length, users });
});


// ============================================================
// ROUTE 7: USER GOES OFFLINE
// DELETE /users/:identity
// ============================================================
app.delete('/users/:identity', (req, res) => {
  activeUsers.delete(req.params.identity);
  console.log(`👋 User offline: ${req.params.identity}`);
  res.json({ success: true });
});


// ============================================================
// ROUTE 8: CALL LOGS
// GET /calls/logs
// ============================================================
app.get('/calls/logs', async (req, res) => {
  try {
    const calls = await client.calls.list({ limit: 20 });
    res.json({
      success: true,
      calls: calls.map(c => ({
        sid: c.sid,
        to: c.to,
        from: c.from,
        status: c.status,
        direction: c.direction,
        duration: c.duration,
        price: c.price,
        startTime: c.startTime,
      }))
    });
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});


// ============================================================
// ROUTE 9: ACCOUNT BALANCE
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


const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🚀 Yadaphone Clone running on port ${PORT}`);
  console.log(`\n📖 Endpoints:`);
  console.log(`   GET  /token              → Generate browser access token`);
  console.log(`   POST /twiml/voice        → TwiML App webhook (outgoing)`);
  console.log(`   POST /twiml/inbound      → Inbound call handler`);
  console.log(`   GET  /users/active       → Online users`);
  console.log(`   GET  /calls/logs         → Call history`);
  console.log(`   GET  /account/balance    → Balance\n`);
});
