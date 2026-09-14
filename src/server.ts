import { createServer } from "node:http";
import { URL } from "node:url";
import express, { type ErrorRequestHandler } from "express";
import { WebSocketServer } from "ws";
import { config } from "./config.js";
import { outboundRouter } from "./routes/outbound.js";
import { transferRouter } from "./routes/transfer.js";
import { twimlRouter } from "./routes/twiml.js";
import { handleMediaStreamConnection } from "./voice/mediaStreamBridge.js";

const app = express();
app.use(express.urlencoded({ extended: false })); // Twilio webhooks
app.use(express.json()); // our own API
app.use(express.static("public"));

// Cheap but essential during POC debugging — without this, a request that
// never reaches a route handler (bad path, upstream rejects it, etc.)
// leaves zero trace in this process's own output.
app.use((req, _res, next) => {
  console.log(`[http] ${req.method} ${req.path}`);
  next();
});

app.use("/calls", outboundRouter);
app.use("/api", transferRouter);
app.use("/twiml", twimlRouter);

// Express's default error handler doesn't reliably print to this process's
// console — route errors were disappearing silently before this was added.
const logErrors: ErrorRequestHandler = (err, _req, res, _next) => {
  console.error("[error]", err);
  res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
};
app.use(logErrors);

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "", "http://localhost");
  if (url.pathname !== "/media-stream/gemini") {
    console.warn(`[upgrade] rejecting unknown path: ${url.pathname}`);
    socket.destroy();
    return;
  }
  // sessionId isn't in the URL (Twilio's <Stream> url can't carry a query
  // string) — it arrives in the WS "start" message's customParameters
  // instead, handled inside handleMediaStreamConnection.
  wss.handleUpgrade(req, socket, head, (ws) => handleMediaStreamConnection(ws));
});

server.listen(config.port, () => {
  console.log(`POC server listening on :${config.port} (public: ${config.publicBaseUrl})`);
});
