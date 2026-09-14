import { Router } from "express";
import { asyncHandler } from "../asyncHandler.js";
import { getSession } from "../sessionStore.js";
import { transferToPartner } from "../callOrchestrator.js";

export const transferRouter = Router();

// Human-triggered equivalent of the "transfer_to_partner" tool call: press a
// button on the dashboard to start dialing the third party, whisper included.
transferRouter.post("/transfer", asyncHandler(async (req, res) => {
  const { sessionId } = req.body as { sessionId: string };
  const session = getSession(sessionId);
  if (!session) return res.status(404).json({ error: "Unknown session" });

  await transferToPartner(session);
  res.json({ status: "dialing" });
}));

transferRouter.get("/session/:sessionId", (req, res) => {
  const session = getSession(req.params.sessionId);
  if (!session) return res.status(404).json({ error: "Unknown session" });
  res.json(session);
});
