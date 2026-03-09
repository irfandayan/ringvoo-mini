# 📞 Ringvoo Mini Clone

Full browser-based calling app using Twilio Client JS SDK.

## What's New vs Mini Project

| Feature | Mini Project | Ringvoo Clone |
|---|---|---|
| Calling | Server-initiated only | Browser → Phone ✅ |
| Inbound | TwiML only | Rings in browser ✅ |
| Browser→Browser | ❌ | ✅ |
| Real-time | ❌ | ✅ |
| Access Tokens | ❌ | ✅ |

---

## Setup (3 extra steps vs mini project)

### Step 1: Create API Key
```
Twilio Console → Account → API Keys & Tokens → Create API Key
Type: Standard
```
Copy **SID** → `TWILIO_API_KEY`  
Copy **Secret** (shown ONCE) → `TWILIO_API_SECRET`

### Step 2: Create TwiML App
```
Twilio Console → Voice → TwiML Apps → Create new TwiML App
Friendly Name: Ringvoo
Voice Request URL: https://your-ngrok-url.ngrok.io/twiml/voice
Method: HTTP POST
```
Copy **TwiML App SID** → `TWILIO_TWIML_APP_SID`

### Step 3: Fill .env
```
cp .env.example .env
# Fill in all 7 values
```

### Step 4: Run
```bash
npm install
npm run dev
# In another terminal:
ngrok http 3001
# Update SERVER_URL in .env + restart
```

### Step 5: Open frontend
Open `frontend/index.html` in browser  
Enter a username → Click **Go Online**  
Dial a number → Click **Call** 🎉

---

## How Browser Calling Works

```
1. Browser → GET /token?identity=user1
2. Server → returns JWT access token
3. Browser → Twilio.Device(token) → connects to Twilio
4. User dials +971XXXXXXXXX → device.connect({ To: '+971XXXXXXXXX' })
5. Twilio → POST /twiml/voice (hits your server)
6. Server → returns TwiML with <Dial><Number>+971XXXXXXXXX</Number></Dial>
7. Twilio → connects browser audio to real phone ✅
```
