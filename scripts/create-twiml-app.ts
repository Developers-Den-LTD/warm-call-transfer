// One-time setup: creates the TwiML Application whose Voice Request URL
// backs the Gemini agent's Conference Participant leg. Run after
// PUBLIC_BASE_URL is set in .env, then copy the printed SID into
// TWILIO_GEMINI_AGENT_APP_SID. Safe to re-run — it always creates a new App;
// delete old ones in the Twilio console if you accumulate test cruft.
import "dotenv/config";
import Twilio from "twilio";

async function main() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const publicBaseUrl = process.env.PUBLIC_BASE_URL;

  if (!accountSid || !authToken || !publicBaseUrl) {
    throw new Error("Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and PUBLIC_BASE_URL in .env first.");
  }

  const client = Twilio(accountSid, authToken);
  const app = await client.applications.create({
    friendlyName: "Gemini Voice Agent POC",
    voiceUrl: `${publicBaseUrl.replace(/\/$/, "")}/twiml/gemini-agent`,
    voiceMethod: "POST",
  });

  console.log(`Created TwiML Application: ${app.sid}`);
  console.log(`Add this to .env: TWILIO_GEMINI_AGENT_APP_SID=${app.sid}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
