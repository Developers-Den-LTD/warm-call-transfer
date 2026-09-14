import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { config } from "../config.js";
import { leaveCallToolDeclaration, transferToolDeclaration } from "./script.js";

// Thin wrapper around Gemini Live's documented WebSocket wire protocol
// (BidiGenerateContent). Implemented against the raw protocol rather than a
// specific SDK version so it's easy to read/debug during the POC — check the
// current Gemini Live API docs (https://ai.google.dev/api/live) if message
// shapes have moved on by the time you run this.
const GEMINI_LIVE_WS_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

const DEFAULT_OUTPUT_SAMPLE_RATE = 24000;

function parseSampleRate(mimeType: string | undefined): number {
  const match = mimeType?.match(/rate=(\d+)/);
  return match ? Number(match[1]) : DEFAULT_OUTPUT_SAMPLE_RATE;
}

export interface GeminiSessionEvents {
  open: [];
  audio: [base64Pcm: string, sampleRate: number];
  toolCall: [name: string, args: Record<string, unknown>, id: string];
  turnComplete: [];
  close: [code: number, reason: string];
  error: [Error];
}

export declare interface GeminiSession {
  on<E extends keyof GeminiSessionEvents>(
    event: E,
    listener: (...args: GeminiSessionEvents[E]) => void,
  ): this;
  emit<E extends keyof GeminiSessionEvents>(event: E, ...args: GeminiSessionEvents[E]): boolean;
}

export class GeminiSession extends EventEmitter {
  private ws: WebSocket;
  private ready = false;
  private pendingAudioChunks: string[] = [];
  private sessionLabel: string;

  constructor(systemInstruction: string, sessionLabel = "gemini") {
    super();
    this.sessionLabel = sessionLabel;
    this.ws = new WebSocket(`${GEMINI_LIVE_WS_URL}?key=${config.gemini.apiKey}`);

    this.ws.on("open", () => {
      console.log(`[${this.sessionLabel}] ws open, sending setup (model=${config.gemini.model})`);
      this.ws.send(
        JSON.stringify({
          setup: {
            model: `models/${config.gemini.model}`,
            generationConfig: {
              responseModalities: ["AUDIO"],
            },
            systemInstruction: {
              parts: [{ text: systemInstruction }],
            },
            tools: [
              {
                functionDeclarations: [transferToolDeclaration, leaveCallToolDeclaration],
              },
            ],
          },
        }),
      );
    });

    this.ws.on("message", (data) => this.handleMessage(data.toString()));

    this.ws.on("close", (code, reasonBuf) => {
      const reason = reasonBuf.toString() || "(no reason given)";
      console.log(`[${this.sessionLabel}] ws closed: code=${code} reason=${reason}`);
      this.emit("close", code, reason);
    });

    this.ws.on("error", (err) => {
      console.error(`[${this.sessionLabel}] ws error:`, err);
      this.emit("error", err instanceof Error ? err : new Error(String(err)));
    });
  }

  private handleMessage(raw: string): void {
    let message: any;
    try {
      message = JSON.parse(raw);
    } catch (err) {
      console.error(`[${this.sessionLabel}] failed to parse message:`, raw.slice(0, 500), err);
      return;
    }

    if (message.setupComplete) {
      this.ready = true;
      console.log(`[${this.sessionLabel}] setup complete, flushing ${this.pendingAudioChunks.length} buffered chunk(s)`);
      this.emit("open");
      for (const chunk of this.pendingAudioChunks) this.sendAudioChunkNow(chunk);
      this.pendingAudioChunks = [];
      return;
    }

    // Live API surfaces async errors (e.g. rejected setup, quota, bad model
    // name) as a top-level `error` frame rather than always closing the
    // socket — log it loudly since a silently-ignored one looks identical
    // to "the model just isn't saying anything."
    if (message.error) {
      console.error(`[${this.sessionLabel}] server error frame:`, JSON.stringify(message.error));
      this.emit("error", new Error(message.error.message ?? JSON.stringify(message.error)));
      return;
    }

    const serverContent = message.serverContent;
    if (serverContent?.modelTurn?.parts) {
      for (const part of serverContent.modelTurn.parts) {
        if (part.inlineData?.data) {
          this.emit("audio", part.inlineData.data, parseSampleRate(part.inlineData.mimeType));
        } else if (part.text) {
          // The model responded in text instead of audio — usually means
          // responseModalities wasn't honored. Surfacing it makes that
          // failure mode visible instead of just "no audio, no idea why."
          console.warn(`[${this.sessionLabel}] got TEXT part instead of audio: ${part.text}`);
        }
      }
    }
    if (serverContent?.turnComplete) this.emit("turnComplete");

    const toolCall = message.toolCall;
    if (toolCall?.functionCalls) {
      for (const call of toolCall.functionCalls) {
        console.log(`[${this.sessionLabel}] tool call: ${call.name}`, call.args);
        this.emit("toolCall", call.name, call.args ?? {}, call.id);
      }
    }

    // Periodic housekeeping frames — expected, not evidence of anything
    // wrong, just noisy if logged every time.
    if (message.sessionResumptionUpdate || message.goAway || message.usageMetadata) return;

    if (!message.setupComplete && !serverContent && !toolCall && !message.error) {
      console.log(`[${this.sessionLabel}] unhandled message shape:`, Object.keys(message));
    }
  }

  sendAudioChunk(base64Pcm16k: string): void {
    if (!this.ready) {
      this.pendingAudioChunks.push(base64Pcm16k);
      return;
    }
    this.sendAudioChunkNow(base64Pcm16k);
  }

  private sendAudioChunkNow(base64Pcm16k: string): void {
    this.ws.send(
      JSON.stringify({
        realtimeInput: {
          // `audio` (a Blob) is the current field — `mediaChunks` is
          // deprecated and may be ignored by the API.
          audio: { data: base64Pcm16k, mimeType: "audio/pcm;rate=16000" },
        },
      }),
    );
  }

  // Injects a text turn "as the system", e.g. to tell the model the partner
  // has joined the call and it should deliver the handoff line now.
  sendSystemNote(text: string): void {
    this.ws.send(
      JSON.stringify({
        clientContent: {
          turns: [{ role: "user", parts: [{ text: `[system] ${text}` }] }],
          turnComplete: true,
        },
      }),
    );
  }

  respondToToolCall(id: string, name: string, response: Record<string, unknown>): void {
    this.ws.send(
      JSON.stringify({
        toolResponse: {
          functionResponses: [{ id, name, response }],
        },
      }),
    );
  }

  close(): void {
    this.ws.close();
  }
}
