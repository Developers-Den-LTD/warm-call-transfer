//pushing again

import Twilio from "twilio";
import { config } from "./config.js";

export const twilioClient = Twilio(config.twilio.accountSid, config.twilio.authToken);

export const VoiceResponse = Twilio.twiml.VoiceResponse;
