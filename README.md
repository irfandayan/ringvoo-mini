# 📞 Ringvoo Mini Clone

Full browser-based calling, SMS and number-management app using the Twilio JS + Node SDK.

---

## Overview

Ringvoo Mini gives you a **single-page dashboard** for:

- **Browser calling**
  - Browser → Phone
  - Phone → Browser (inbound)
  - Browser → Browser calls
- **Custom caller ID**
  - User verifies their own phone via OTP call
  - Verified number is used as caller ID for outgoing calls
- **SMS**
  - Send SMS from the dashboard
  - View recent inbound/outbound SMS logs
- **Pricing + account**
  - Live country call rates from Twilio Pricing API
  - Ringvoo markup = `2 × Twilio rate`
  - Show Twilio account balance
- **Numbers**
  - Search available US/CA Twilio numbers
  - Purchase a number and auto-wire voice/SMS webhooks
  - List numbers owned by the account

---

## Stack

- **Backend**
  - Node.js + Express
  - Twilio Node SDK
  - In-memory storage (Maps/arrays) for demo purposes
- **Frontend**
  - Plain HTML + CSS + vanilla JS
  - Twilio Voice JS SDK (`Twilio.Device`)

---

## Setup

### 1. Create API Key
```text
Twilio Console → Account → API Keys & Tokens → Create API Key
Type: Standard
```
Copy **SID** → `TWILIO_API_KEY`  
Copy **Secret** (shown ONCE) → `TWILIO_API_SECRET`

### 2. Create TwiML App
```text
Twilio Console → Voice → TwiML Apps → Create new TwiML App
Friendly Name: Ringvoo
Voice Request URL: https://your-ngrok-url.ngrok.io/twiml/voice
Method: HTTP POST
```
Copy **TwiML App SID** → `TWILIO_TWIML_APP_SID`

### 3. Environment

Create `.env` and fill (example values shown as placeholders):

```env
# Core Twilio account credentials
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# API Key used for generating browser access tokens
TWILIO_API_KEY=SKxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_API_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# TwiML App SID for browser calling
TWILIO_TWIML_APP_SID=APxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Main Twilio voice number
# - Used as default caller ID for outgoing calls
# - Also used as SMS sender if TWILIO_SMS_NUMBER is not set
TWILIO_PHONE_NUMBER=+1XXXXXXXXXX

# Optional dedicated SMS number
# - Must be a Twilio number with SMS capability
# - Messages tab will send FROM this number if set
TWILIO_SMS_NUMBER=+1YYYYYYYYYY

# Public URL (e.g. ngrok) pointing to this backend
# - No trailing slash
# - Twilio webhooks are derived from this (e.g. /twiml/inbound, /sms/inbound)
SERVER_URL=https://your-ngrok-url.ngrok.io

# Local port for the Express server
PORT=3001
```

### 4. Run backend

```bash
npm install
npm run dev

# In another terminal:
ngrok http 3001
# Update SERVER_URL in .env to your ngrok URL and restart
```

### 5. Open frontend

Open `index.html` directly in your browser (or via a simple static server).  

Basic flow:

- Enter a username → **Go Online**
- Check the status chip (top-right) turns **Online**
- Dial a number → **Call**

Use the tabs on the right for:

- **Calls** – balance, active users, call history
- **Messages** – send SMS + recent messages
- **Caller ID** – verify/remove custom caller ID
- **Rates** – live call rates per country
- **Numbers** – search/buy/list Twilio numbers

---

## How Browser Calling Works (high level)

```text
1. Browser → GET /token?identity=user1
2. Server → returns JWT access token with Voice grant
3. Browser → Twilio.Device(token) → connects to Twilio
4. User dials +971XXXXXXXXX → device.connect({ params: { To: '+971XXXXXXXXX' } })
5. Twilio → POST /twiml/voice (to your server)
6. Server → returns TwiML <Dial><Number>+971XXXXXXXXX</Number></Dial>
7. Twilio → connects browser audio to the real phone ✅
```

The same pattern is used for:

- Browser ↔ Phone
- Browser ↔ Browser (client to client)
- Phone → Browser (inbound to `/twiml/inbound`)
