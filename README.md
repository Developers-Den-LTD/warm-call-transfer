# Warm-Transfer Voice POC (Gemini Live + Twilio)

Minimal POC for: dial a lead, run an AI (or human) pre-qualification chat, then
warm-transfer into a third-party number with a whisper announcement, while
recording continues through the whole thing.

## How it works

1. **Lead is dialed** via Twilio's **Conference Participants REST API**
   (`conferences(sessionId).participants.create(...)`), which both places the
   call and creates a named Conference on first join — no separate TwiML
   "answer" webhook needed. Recording (`conferenceRecord: "record-from-start"`)
   is turned on here too, so it covers the conference's whole life, including
   after the AI leg leaves later.
2. For AI mode, the server immediately adds a **second Conference Participant**
   whose `to` is `app:{TwiMLApplicationSid}?sessionId=...` — a TwiML
   Application, not a phone number, so Twilio doesn't dial anything; it just
   invokes that App's Voice Request URL (`/twiml/gemini-agent`). That route
   returns `<Connect><Stream>`, which bridges this leg's audio, bidirectionally
   and in real time, to our Gemini Live session. Because this leg is a genuine
   conference participant, whatever audio we send back over that WebSocket is
   mixed into the conference for everyone else — exactly like a real caller
   speaking. This is Twilio's documented pattern for adding a voice AI agent to
   a live conference; see
   [Use a TwiML Application to Connect your Voice AI Agent to a Twilio Conference](https://www.twilio.com/en-us/blog/developers/tutorials/product/connect-twiml-app-twilio-conference).
3. That bridge (`src/voice/mediaStreamBridge.ts`) drives a **Gemini Live**
   session (`src/voice/geminiSession.ts`) running the qualification script
   (`src/voice/script.ts`), which can call a `transfer_to_partner` tool once
   the lead confirms interest.
4. `transfer_to_partner` dials the third-party number the traditional way
   (`calls.create` + TwiML), with a **whisper** step first
   (`/twiml/whisper`: "new lead, press 1 to join") before they land in the
   same conference — so they never barge in cold. (The Participants API
   doesn't have a whisper-before-join primitive, so this leg uses plain
   TwiML `<Dial><Conference>` instead.)
5. Meanwhile the AI keeps asking stalling/qualifying questions — this falls
   out naturally, since it's still bridged to the live conference audio the
   whole time.
6. A conference status callback detects the third party's join and tells
   Gemini (via an injected text turn) to deliver the handoff line, then call
   `leave_call`, which hangs up the AI's own call leg — leaving lead + partner
   talking, still recorded.
7. **Human-in-the-loop mode** is the same flow with the AI's Participant leg
   swapped for a human agent's own phone (`POST /calls/agent-join`, a plain
   phone-number Participant) and the tool call swapped for a dashboard button
   (`POST /api/transfer`). See `public/dashboard.html`.

## Setup

```bash
npm install
cp .env.example .env   # fill in TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
                        # TWILIO_FROM_NUMBER, GEMINI_API_KEY, and PUBLIC_BASE_URL
```

You'll need a public HTTPS URL Twilio can reach for webhooks — during POC
testing, run `ngrok http 3000` and put that URL in `PUBLIC_BASE_URL`.

Then create the TwiML Application the AI's conference leg uses (one-time,
re-run if `PUBLIC_BASE_URL` changes since ngrok URLs aren't stable):

```bash
npm run setup:app
```

Copy the printed SID into `TWILIO_GEMINI_AGENT_APP_SID` in `.env`, then:

```bash
npm run dev
```

Open `http://localhost:3000/dashboard.html` (or POST to `/calls/outbound`
directly) to place a test call.

## Things to double-check before your first live test

This was written without live credentials, so a few surfaces are worth
confirming against current docs/your account the first time you run it:

- **Gemini Live wire protocol** (`src/voice/geminiSession.ts`): message
  shapes for `setup`, `realtimeInput`, `serverContent`, and `toolCall` are
  implemented against the documented `BidiGenerateContent` protocol. If
  Google has since moved to a different message envelope or your model name
  differs, this is the file to adjust.
- **Audio quality**: the mu-law/PCM resampler in `audioCodec.ts` is linear
  interpolation — good enough to prove the flow out, not tuned for quality.
- **Twilio account capabilities**: Conference Participants with `to: "app:..."`
  requires the TwiML Applications resource to be available on your account
  (standard on all Twilio accounts, but confirm if you're on a trial/rate-limited
  number).
- **Compliance**: outbound dialing (TCPA), call recording consent (varies by
  state/country — several require all-party consent), and telling the lead a
  third party is joining are legal/regulatory questions for the client to
  sign off on, not something this POC decides for you.

## Not in scope for this POC

No database (session state is an in-memory `Map`, lost on restart), no auth
on the API routes, no retry/error-recovery logic, no outbound dialing
scheduler — all reasonable next steps once the core flow is validated.
