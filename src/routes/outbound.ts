import { randomUUID } from "node:crypto";
import { Router } from "express";
import { asyncHandler } from "../asyncHandler.js";
import { createSession } from "../sessionStore.js";
import { addAgentToConference, startLeadCall } from "../callOrchestrator.js";

export const outboundRouter = Router();

// Kicks off the whole flow: dial the lead into a new conference. `mode: "ai"`
// also adds the Gemini agent as a second participant on the same call.
// `mode: "human"` expects a human to separately call POST /calls/agent-join
// with the returned sessionId to get their own leg into the conference.
outboundRouter.post("/outbound", asyncHandler(async (req, res) => {
  const { leadNumber, leadName, offer, thirdPartyNumber, mode } = req.body as {
    leadNumber: string;
    leadName: string;
    offer: string;
    thirdPartyNumber: string;
    mode: "ai" | "human";
  };

  if (!leadNumber || !leadName || !offer || !thirdPartyNumber || !mode) {
    return res.status(400).json({ error: "leadNumber, leadName, offer, thirdPartyNumber, mode are required" });
  }

  const sessionId = randomUUID();
  const session = createSession({ sessionId, leadNumber, leadName, offer, thirdPartyNumber, mode });

  await startLeadCall(session);

  res.json({ sessionId });
}));

// Human-mode only: bring the agent's own phone into the conference.
outboundRouter.post("/agent-join", asyncHandler(async (req, res) => {
  const { sessionId, agentNumber } = req.body as { sessionId: string; agentNumber: string };
  if (!sessionId || !agentNumber) {
    return res.status(400).json({ error: "sessionId and agentNumber are required" });
  }

  const agentCallSid = await addAgentToConference(sessionId, agentNumber);
  res.json({ agentCallSid });
}));
