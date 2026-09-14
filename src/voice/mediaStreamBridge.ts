import type { WebSocket } from "ws";
import { getSession } from "../sessionStore.js";
import { getLiveGeminiSession, handleGeminiToolCall, registerGeminiSession, unregisterGeminiSession } from "../callOrchestrator.js";
import { GeminiSession } from "./geminiSession.js";
import { buildSystemInstruction } from "./script.js";
import { geminiPcm16Base64ToTwilioMuLawPayload, muLawBufferToPcm16, pcmStats, twilioMuLawPayloadToGeminiPcm16Base64 } from "./audioCodec.js";

// One of these runs per Twilio Conference Media Stream connection, i.e. one
// per active AI-mode call session. The connection carries no sessionId of
// its own (Twilio's <Stream> url can't have a query string) — it only shows
// up once the "start" event arrives with start.customParameters.sessionId,
// set via the <Parameter> we return from /twiml/gemini-agent.
export function handleMediaStreamConnection(twilioWs: WebSocket): void {
  console.log("[media-stream] Twilio stream connected, awaiting start event");

  let sessionId: string | undefined;
  let streamSid: string | undefined;
  let gemini: GeminiSession | undefined;
  let framesIn = 0;
  let framesOut = 0;

  twilioWs.on("message", (raw) => {
    let message: any;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (message.event) {
      case "start": {
        streamSid = message.start?.streamSid;
        sessionId = message.start?.customParameters?.sessionId;
        console.log(`[media-stream] start, streamSid=${streamSid}, sessionId=${sessionId}`);

        if (!sessionId) {
          console.error("[media-stream] no sessionId in start.customParameters — closing");
          twilioWs.close(1008, "Missing sessionId");
          return;
        }
        const session = getSession(sessionId);
        if (!session) {
          console.error(`[media-stream:${sessionId}] unknown session — closing`);
          twilioWs.close(1008, "Unknown session");
          return;
        }

        gemini = new GeminiSession(
          buildSystemInstruction({ leadName: session.leadName, offer: session.offer }),
          sessionId,
        );
        registerGeminiSession(sessionId, gemini);

        gemini.on("audio", (base64Pcm, sampleRate) => {
          if (!streamSid || twilioWs.readyState !== twilioWs.OPEN) return;
          framesOut++;
          twilioWs.send(
            JSON.stringify({
              event: "media",
              streamSid,
              media: { payload: geminiPcm16Base64ToTwilioMuLawPayload(base64Pcm, sampleRate) },
            }),
          );
        });

        gemini.on("toolCall", (name, args, callId) => {
          handleGeminiToolCall(sessionId!, name, args, callId, gemini!);
        });

        gemini.on("error", (err) => {
          console.error(`[media-stream:${sessionId}] gemini error:`, err.message);
        });
        break;
      }
      case "media": {
        framesIn++;
        if (framesIn === 1) console.log(`[media-stream:${sessionId}] first inbound audio frame received`);
        // Diagnostic: log signal level every ~1s of audio (50 frames @ 20ms)
        // so we can tell whether real speech is actually arriving on this
        // leg, vs. near-silence — without needing to listen to it.
        if (framesIn % 50 === 0) {
          const raw = Buffer.from(message.media.payload, "base64");
          const { peak, avgAbs, silenceRatio } = pcmStats(muLawBufferToPcm16(raw));
          console.log(
            `[media-stream:${sessionId}] inbound signal @ frame ${framesIn}: peak=${peak} avgAbs=${avgAbs.toFixed(1)} silence=${(silenceRatio * 100).toFixed(0)}%`,
          );
        }
        gemini?.sendAudioChunk(twilioMuLawPayloadToGeminiPcm16Base64(message.media.payload));
        break;
      }
      case "stop":
        console.log(`[media-stream:${sessionId}] stop (frames in=${framesIn}, out=${framesOut})`);
        gemini?.close();
        break;
      default:
        break;
    }
  });

  twilioWs.on("error", (err) => {
    console.error(`[media-stream:${sessionId ?? "?"}] twilio ws error:`, err);
  });

  twilioWs.on("close", () => {
    console.log(`[media-stream:${sessionId ?? "?"}] Twilio stream closed (frames in=${framesIn}, out=${framesOut})`);
    if (sessionId && gemini && getLiveGeminiSession(sessionId) === gemini) unregisterGeminiSession(sessionId);
    gemini?.close();
  });
}
