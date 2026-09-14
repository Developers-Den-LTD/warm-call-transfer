import { config } from "./config.js";
import { twilioClient } from "./twilioClient.js";
import { CallSession, getSession, updateSession } from "./sessionStore.js";
import { GeminiSession } from "./voice/geminiSession.js";

// Live GeminiSession instances keyed by sessionId, so REST/webhook handlers
// (running outside the WS connection's scope) can talk to an in-progress
// bridge — e.g. to tell the model "the partner just joined, wrap up."
const liveGeminiSessions = new Map<string, GeminiSession>();

export function registerGeminiSession(sessionId: string, session: GeminiSession): void {
  liveGeminiSessions.set(sessionId, session);
}

export function unregisterGeminiSession(sessionId: string): void {
  liveGeminiSessions.delete(sessionId);
}

export function getLiveGeminiSession(sessionId: string): GeminiSession | undefined {
  return liveGeminiSessions.get(sessionId);
}

// Dials the lead and, for AI mode, adds the Gemini agent as a second
// Conference Participant in the same call — both via the Conference
// Participants REST API, which creates the named conference on first join.
// See: https://www.twilio.com/en-us/blog/developers/tutorials/product/connect-twiml-app-twilio-conference
export async function startLeadCall(session: CallSession): Promise<void> {
  const leadParticipant = await twilioClient.conferences(session.sessionId).participants.create({
    to: session.leadNumber,
    from: config.twilio.fromNumber,
    startConferenceOnEnter: true,
    endConferenceOnExit: false,
    conferenceRecord: "record-from-start",
    conferenceStatusCallback: `${config.publicBaseUrl}/twiml/conference-events?sessionId=${session.sessionId}`,
    conferenceStatusCallbackEvent: ["start", "join", "leave", "end"],
  });

  updateSession(session.sessionId, {
    leadCallSid: leadParticipant.callSid,
    conferenceSid: leadParticipant.conferenceSid,
  });

  if (session.mode === "ai") {
    await addGeminiAgentToConference(session.sessionId);
  }
}

// Adds the AI as a participant backed by a TwiML Application (no PSTN leg —
// Twilio invokes the App's Voice Request URL, which returns <Connect><Stream>
// bridging this leg to our Gemini WS bridge). Used both at call start and if
// re-adding the bot is ever needed.
export async function addGeminiAgentToConference(sessionId: string): Promise<void> {
  const botParticipant = await twilioClient.conferences(sessionId).participants.create({
    to: `app:${config.twilio.geminiAgentAppSid}?sessionId=${sessionId}`,
    from: config.twilio.fromNumber,
    startConferenceOnEnter: true,
    endConferenceOnExit: false,
  });
  updateSession(sessionId, { botCallSid: botParticipant.callSid });
}

// Human-mode only: bring the agent's own phone into the conference the same
// way the lead joined.
export async function addAgentToConference(sessionId: string, agentNumber: string): Promise<string> {
  const participant = await twilioClient.conferences(sessionId).participants.create({
    to: agentNumber,
    from: config.twilio.fromNumber,
    startConferenceOnEnter: true,
    endConferenceOnExit: false,
  });
  return participant.callSid;
}

// Ends the AI's participation once the handoff line has been delivered,
// simply by hanging up its own call leg — the lead and third party stay in
// the (still-recording) conference.
export async function endGeminiAgentParticipation(session: CallSession): Promise<void> {
  if (session.botCallSid) {
    await twilioClient.calls(session.botCallSid).update({ status: "completed" });
  }
  const live = getLiveGeminiSession(session.sessionId);
  live?.close();
  unregisterGeminiSession(session.sessionId);
}

// Dials the third party into the conference, whispering a heads-up first.
// Shared by both the AI path (tool call) and the human-triggered path (API).
export async function transferToPartner(session: CallSession): Promise<void> {
  const call = await twilioClient.calls.create({
    to: session.thirdPartyNumber,
    from: config.twilio.fromNumber,
    url: `${config.publicBaseUrl}/twiml/whisper?sessionId=${session.sessionId}`,
    machineDetection: "Enable",
  });
  updateSession(session.sessionId, { thirdPartyCallSid: call.sid });
}

export async function handleThirdPartyJoined(session: CallSession): Promise<void> {
  updateSession(session.sessionId, { thirdPartyJoined: true });

  if (session.mode === "ai") {
    const live = getLiveGeminiSession(session.sessionId);
    live?.sendSystemNote(
      "The partner has just joined the call. Deliver your short handoff line now, then call leave_call.",
    );
  }
  // Human mode: the dashboard simply shows "partner joined" so the agent can
  // say the handoff line themselves and click "leave call" when ready.
}

export function handleGeminiToolCall(
  sessionId: string,
  name: string,
  _args: Record<string, unknown>,
  callId: string,
  live: GeminiSession,
): void {
  const session = getSession(sessionId);
  if (!session) return;

  if (name === "transfer_to_partner") {
    live.respondToToolCall(callId, name, { status: "dialing" });
    transferToPartner(session).catch((err) => console.error(`[transfer:${sessionId}]`, err));
    return;
  }

  if (name === "leave_call") {
    live.respondToToolCall(callId, name, { status: "ok" });
    // Give the audio a moment to flush to Twilio before hanging up the leg.
    setTimeout(() => {
      endGeminiAgentParticipation(session).catch((err) => console.error(`[leave_call:${sessionId}]`, err));
    }, 4000);
  }
}
