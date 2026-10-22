/** Native Workers AI speech providers shared by HTTP speech and Telegram ingress. */
import { Buffer } from "node:buffer";
import { ElizaError } from "@elizaos/core";

export class CloudflareSpeechError extends ElizaError {
  constructor(
    message: string,
    readonly status: 400 | 502 | 503,
    code: string,
    cause?: unknown,
  ) {
    super(message, { code, cause });
  }
}

async function runSpeech(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    return await operation();
  } catch (cause) {
    // error-policy:J2 preserve provider failures without exposing their response body.
    throw new CloudflareSpeechError(
      "Workers AI speech request failed",
      502,
      "SPEECH_PROVIDER_FAILED",
      cause,
    );
  }
}

export const CLOUDFLARE_STT_MODEL = "@cf/openai/whisper-large-v3-turbo";
export const CLOUDFLARE_TTS_MODEL = "@cf/deepgram/aura-2-en";
export const CLOUDFLARE_TTS_MAX_CHARACTERS = 2000;

export type CloudflareTtsSpeaker =
  | "luna"
  | "asteria"
  | "athena"
  | "andromeda"
  | "aurora"
  | "orion"
  | "atlas"
  | "pandora"
  | "helena"
  | "draco"
  | "hyperion";

export interface CloudflareSpeechBinding {
  run(
    model: typeof CLOUDFLARE_STT_MODEL,
    input: { audio: string; language?: string },
  ): Promise<unknown>;
  run(
    model: typeof CLOUDFLARE_TTS_MODEL,
    input: {
      text: string;
      speaker: CloudflareTtsSpeaker;
      encoding: "mp3" | "linear16";
      container?: "wav";
      sample_rate?: number;
    },
  ): Promise<unknown>;
}

export async function transcribeCloudflareAudio(
  binding: CloudflareSpeechBinding | undefined,
  audio: Uint8Array,
  language?: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown> & { text: string }> {
  if (!binding)
    throw new CloudflareSpeechError(
      "Workers AI speech binding is missing",
      503,
      "SPEECH_PROVIDER_UNCONFIGURED",
    );
  signal?.throwIfAborted();
  // The binding has no documented abort parameter. Await accepted work rather
  // than abandon an unknown provider outcome or replay it on another provider.
  const result = await runSpeech(() =>
    binding.run(CLOUDFLARE_STT_MODEL, {
      audio: Buffer.from(audio).toString("base64"),
      ...(language ? { language } : {}),
    }),
  );
  if (
    result === null ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    !("text" in result) ||
    typeof result.text !== "string"
  ) {
    throw new CloudflareSpeechError(
      "Workers AI returned an invalid transcription",
      502,
      "SPEECH_PROVIDER_RESPONSE_INVALID",
    );
  }
  return result as Record<string, unknown> & { text: string };
}

export async function synthesizeCloudflareAudio(
  binding: CloudflareSpeechBinding | undefined,
  text: string,
  wav: boolean,
  signal?: AbortSignal,
  speaker: CloudflareTtsSpeaker = "luna",
): Promise<ReadableStream<Uint8Array>> {
  if (!binding)
    throw new CloudflareSpeechError(
      "Workers AI speech binding is missing",
      503,
      "SPEECH_PROVIDER_UNCONFIGURED",
    );
  if (text.length > CLOUDFLARE_TTS_MAX_CHARACTERS)
    throw new CloudflareSpeechError(
      `Workers AI speech accepts at most ${CLOUDFLARE_TTS_MAX_CHARACTERS} characters`,
      400,
      "SPEECH_TEXT_TOO_LONG",
    );
  signal?.throwIfAborted();
  const result = await runSpeech(() =>
    binding.run(CLOUDFLARE_TTS_MODEL, {
      text,
      speaker,
      ...(wav
        ? { encoding: "linear16" as const, container: "wav" as const, sample_rate: 24000 }
        : { encoding: "mp3" as const }),
    }),
  );
  if (!(result instanceof ReadableStream)) {
    throw new CloudflareSpeechError(
      "Workers AI returned invalid speech audio",
      502,
      "SPEECH_PROVIDER_RESPONSE_INVALID",
    );
  }
  return result;
}
