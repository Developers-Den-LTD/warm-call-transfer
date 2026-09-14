// Minimal codec utilities to bridge Twilio Media Streams (8kHz mu-law) with
// Gemini Live (16kHz PCM16 in, 24kHz PCM16 out). No external deps — a POC-grade
// implementation, not tuned for audio quality.

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

export function muLawByteToPcm16(byte: number): number {
  byte = ~byte & 0xff;
  const sign = byte & 0x80;
  const exponent = (byte >> 4) & 0x07;
  const mantissa = byte & 0x0f;
  let sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
  sample -= MULAW_BIAS;
  return sign ? -sample : sample;
}

export function pcm16SampleToMuLaw(sample: number): number {
  let s = Math.max(-MULAW_CLIP, Math.min(MULAW_CLIP, sample));
  const sign = s < 0 ? 0x80 : 0;
  if (sign) s = -s;
  s += MULAW_BIAS;

  let exponent = 7;
  for (let mask = 0x4000; (s & mask) === 0 && exponent > 0; mask >>= 1) exponent--;
  const mantissa = (s >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

// Diagnostic only — lets us tell "this is real speech-ish signal" apart from
// "this is silence" or "this is garbage" without needing to actually listen
// to the audio, by inspecting amplitude distribution.
export function pcmStats(pcm: Int16Array): { peak: number; avgAbs: number; silenceRatio: number } {
  let peak = 0;
  let sumAbs = 0;
  let silentCount = 0;
  for (let i = 0; i < pcm.length; i++) {
    const abs = Math.abs(pcm[i]);
    if (abs > peak) peak = abs;
    sumAbs += abs;
    if (abs < 200) silentCount++; // ~-44dBFS, well below normal speech level
  }
  const avgAbs = pcm.length ? sumAbs / pcm.length : 0;
  const silenceRatio = pcm.length ? silentCount / pcm.length : 1;
  return { peak, avgAbs, silenceRatio };
}

export function muLawBufferToPcm16(muLaw: Buffer): Int16Array {
  const out = new Int16Array(muLaw.length);
  for (let i = 0; i < muLaw.length; i++) out[i] = muLawByteToPcm16(muLaw[i]);
  return out;
}

export function pcm16ToMuLawBuffer(pcm: Int16Array): Buffer {
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = pcm16SampleToMuLaw(pcm[i]);
  return out;
}

// Simple linear-interpolation resampler. Fine for a voice POC; swap for a
// proper resampler (e.g. libsamplerate bindings) before anything production.
export function resamplePcm16(input: Int16Array, fromRate: number, toRate: number): Int16Array {
  if (fromRate === toRate) return input;
  const ratio = toRate / fromRate;
  const outLength = Math.round(input.length * ratio);
  const output = new Int16Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const srcPos = i / ratio;
    const srcIndex = Math.floor(srcPos);
    const frac = srcPos - srcIndex;
    const a = input[srcIndex] ?? 0;
    const b = input[srcIndex + 1] ?? a;
    output[i] = Math.round(a + (b - a) * frac);
  }
  return output;
}

export function pcm16ToBase64(pcm: Int16Array): string {
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64");
}

export function base64ToPcm16(base64: string): Int16Array {
  const buf = Buffer.from(base64, "base64");
  return new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2);
}

// --- Twilio <-> Gemini convenience wrappers ---

export const TWILIO_SAMPLE_RATE = 8000;
export const GEMINI_INPUT_SAMPLE_RATE = 16000;
export const GEMINI_OUTPUT_SAMPLE_RATE = 24000;

export function twilioMuLawPayloadToGeminiPcm16Base64(payloadBase64: string): string {
  const muLaw = Buffer.from(payloadBase64, "base64");
  const pcm8k = muLawBufferToPcm16(muLaw);
  const pcm16k = resamplePcm16(pcm8k, TWILIO_SAMPLE_RATE, GEMINI_INPUT_SAMPLE_RATE);
  return pcm16ToBase64(pcm16k);
}

// `sourceSampleRate` should come from the rate embedded in Gemini's own
// response mimeType (e.g. "audio/pcm;rate=24000") rather than being assumed,
// since that value isn't guaranteed to stay the same across model versions.
export function geminiPcm16Base64ToTwilioMuLawPayload(
  pcmBase64: string,
  sourceSampleRate: number = GEMINI_OUTPUT_SAMPLE_RATE,
): string {
  const pcm = base64ToPcm16(pcmBase64);
  const pcm8k = resamplePcm16(pcm, sourceSampleRate, TWILIO_SAMPLE_RATE);
  return pcm16ToMuLawBuffer(pcm8k).toString("base64");
}
