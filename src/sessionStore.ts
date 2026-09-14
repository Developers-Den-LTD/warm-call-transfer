export type TransferMode = "ai" | "human";

export interface CallSession {
  sessionId: string; // also used as the Twilio Conference friendly name
  leadNumber: string;
  leadName: string;
  offer: string;
  thirdPartyNumber: string;
  mode: TransferMode;
  leadCallSid?: string;
  conferenceSid?: string;
  botCallSid?: string; // the AI's own Conference Participant call leg, when mode === "ai"
  thirdPartyCallSid?: string;
  thirdPartyJoined: boolean;
  createdAt: number;
}

const sessions = new Map<string, CallSession>();

export function createSession(input: {
  sessionId: string;
  leadNumber: string;
  leadName: string;
  offer: string;
  thirdPartyNumber: string;
  mode: TransferMode;
}): CallSession {
  const session: CallSession = { ...input, thirdPartyJoined: false, createdAt: Date.now() };
  sessions.set(session.sessionId, session);
  return session;
}

export function getSession(sessionId: string): CallSession | undefined {
  return sessions.get(sessionId);
}

export function findSessionByConferenceSid(conferenceSid: string): CallSession | undefined {
  for (const session of sessions.values()) {
    if (session.conferenceSid === conferenceSid) return session;
  }
  return undefined;
}

export function updateSession(sessionId: string, patch: Partial<CallSession>): void {
  const session = sessions.get(sessionId);
  if (!session) throw new Error(`Unknown session: ${sessionId}`);
  Object.assign(session, patch);
}
