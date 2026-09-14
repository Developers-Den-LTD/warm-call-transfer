import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3000),
  publicBaseUrl: required("PUBLIC_BASE_URL").replace(/\/$/, ""),
  twilio: {
    accountSid: required("TWILIO_ACCOUNT_SID"),
    authToken: required("TWILIO_AUTH_TOKEN"),
    fromNumber: required("TWILIO_FROM_NUMBER"),
    // TwiML Application (APxxxx) whose Voice Request URL is
    // {PUBLIC_BASE_URL}/twiml/gemini-agent — see scripts/create-twiml-app.ts.
    geminiAgentAppSid: required("TWILIO_GEMINI_AGENT_APP_SID"),
  },
  gemini: {
    apiKey: required("GEMINI_API_KEY"),
    // Verify this is still current at https://ai.google.dev/gemini-api/docs/models
    // before assuming a silent failure is a bug elsewhere — Live API model
    // names churn quickly, and an unrecognized name is a likely cause of
    // "connects but never says anything."
    model: process.env.GEMINI_MODEL ?? "gemini-3.1-flash-live-preview",
  },
};
