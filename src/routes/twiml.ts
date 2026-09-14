import { Router } from "express";
import { VoiceResponse } from "../twilioClient.js";
import { config } from "../config.js";
import { getSession, findSessionByConferenceSid } from "../sessionStore.js";
import { handleThirdPartyJoined } from "../callOrchestrator.js";

// Derived from the configured (known-https) public URL rather than
// req.protocol/req.get("host") — behind ngrok (or any reverse proxy) Express
// sees the plain-HTTP local hop unless "trust proxy" is set, so req.protocol
// reports "http" and produces a ws:// URL. Twilio's Media Streams require a
// secure wss:// URL and will fail the call almost immediately if given ws://
// — the TwiML fetch itself still succeeds (200), which makes this bug easy
// to mistake for "everything's fine" when it isn't.
const mediaStreamWsBaseUrl = config.publicBaseUrl.replace(/^http/, "ws");

export const twimlRouter = Router();

function sessionIdFrom(req: import("express").Request): string {
  // Twilio forwards custom query params from an `app:APxxxx?sessionId=...`
  // participant `to` value as POST body fields; querystring params on a
  // normal webhook URL (e.g. /twiml/whisper?sessionId=...) also land here.
  return String(req.body.sessionId ?? req.query.sessionId ?? "");
}

// Voice Request URL of the Gemini-agent TwiML Application (see
// scripts/create-twiml-app.ts). Twilio invokes this once the AI's Conference
// Participant leg is created; handing control to <Connect><Stream> bridges
// this leg's audio (both directions) to our Gemini Live WS bridge. Because
// this leg was added to the conference via the Participants API, whatever we
// send back over that WebSocket is mixed into the conference for everyone
// else, exactly like a real caller speaking.
twimlRouter.post("/gemini-agent", (req, res) => {
  const sessionId = sessionIdFrom(req);
  const twiml = new VoiceResponse();
  const connect = twiml.connect();
  // <Stream>'s `url` does NOT support query strings — Twilio silently never
  // attempts the connection if you put one there (no error, the call just
  // sits open and silent). Custom data has to go through nested <Parameter>
  // elements instead, which Twilio delivers in the WS "start" event's
  // start.customParameters.
  const stream = connect.stream({ url: `${mediaStreamWsBaseUrl}/media-stream/gemini` });
  stream.parameter({ name: "sessionId", value: sessionId });
  res.type("text/xml").send(twiml.toString());
});

// Third party's first webhook: whisper heads-up + press 1 to join.
twimlRouter.post("/whisper", (req, res) => {
  const sessionId = sessionIdFrom(req);
  const twiml = new VoiceResponse();

  twiml.say("You have a new lead ready to be qualified.");
  const gather = twiml.gather({
    numDigits: 1,
    action: `/twiml/whisper-gather?sessionId=${sessionId}`,
    method: "POST",
  });
  gather.say("Press 1 to join the call now.");
  // No input: join anyway rather than stranding the lead on hold.
  twiml.redirect({ method: "POST" }, `/twiml/whisper-join?sessionId=${sessionId}`);

  res.type("text/xml").send(twiml.toString());
});

twimlRouter.post("/whisper-gather", (req, res) => {
  const sessionId = sessionIdFrom(req);
  const twiml = new VoiceResponse();
  twiml.redirect({ method: "POST" }, `/twiml/whisper-join?sessionId=${sessionId}`);
  res.type("text/xml").send(twiml.toString());
});

twimlRouter.post("/whisper-join", (req, res) => {
  const sessionId = sessionIdFrom(req);
  const twiml = new VoiceResponse();
  const dial = twiml.dial();
  dial.conference({ startConferenceOnEnter: true, endConferenceOnExit: false }, sessionId);
  res.type("text/xml").send(twiml.toString());
});

// Twilio conference status callbacks (form-encoded): StatusCallbackEvent,
// ConferenceSid, CallSid, etc. Registered on the lead's Participant create
// call (only the first participant's callback registration is honored).
twimlRouter.post("/conference-events", async (req, res) => {
  const sessionId = sessionIdFrom(req);
  const session = getSession(sessionId) ?? findSessionByConferenceSid(req.body.ConferenceSid);
  res.sendStatus(204);
  if (!session) return;

  const event = req.body.StatusCallbackEvent as string;
  if (event === "participant-join" && req.body.CallSid === session.thirdPartyCallSid) {
    // Response is already sent above (Twilio doesn't wait on this webhook) —
    // catch rather than throw, since there's no response left to send an
    // error on and an unhandled rejection here would crash the process.
    try {
      await handleThirdPartyJoined(session);
    } catch (err) {
      console.error(`[conference-events:${sessionId}]`, err);
    }
  }
});
