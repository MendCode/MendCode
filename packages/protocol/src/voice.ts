import { z } from "zod"
import { lazySchema } from "./lazy"

const ProviderId = z.string().trim().min(1).max(32).regex(/^[a-z0-9][a-z0-9_-]*$/)
const BaseUrl = z.string().url().max(2048).refine((value) => {
  const url = new URL(value)
  return !url.username && !url.password && !url.search && !url.hash && (url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
}, "Voice API URLs require HTTPS or loopback HTTP, without credentials, query or fragment")

/**
 * Push-to-talk dictation (docs/voice.md). Off unless `enabled`. The recording is uploaded to an OpenAI-compatible
 * `/audio/transcriptions` endpoint of `provider` (default `openai`, API key from the provider config or environment).
 */
export const VoiceSettings = lazySchema(() => z.strictObject({
  enabled: z.boolean().optional(),
  provider: ProviderId.optional(),
  model: z.string().trim().min(1).max(200).optional(),
  /** Overrides the provider's API root. Provider credentials go to it only when `provider` is set explicitly. */
  base_url: BaseUrl.optional(),
  /**
   * ISO 639-1/-3 code (`es`), or two (`es,en`) that the on-device model hears at once, keeping the surer transcript; an API gets
   * the first as its hint. Unset: on-device follows the Mac's first two preferred languages and an API detects the language.
   */
  language: z.string().regex(/^[a-z]{2,3}(,[a-z]{2,3})?$/).optional(),
  /** Longest recording; the terminal stops it there. */
  max_seconds: z.number().int().min(5).max(300).optional(),
  timeout_ms: z.number().int().min(1000).max(600_000).optional(),
}))
export type VoiceSettings = z.infer<typeof VoiceSettings>

/** Local clients only. `start` opens the microphone, `stop` ends the recording and returns its transcript, `cancel` discards it, `status` reports readiness. */
export const VoiceControlInput = lazySchema(() => z.strictObject({
  action: z.enum(["start", "stop", "cancel", "status"]),
  /** `start` while space is held: it records until let go, with no time limit on-device and the upload size's limit otherwise. */
  held: z.boolean().optional(),
}))

export const VoiceReport = lazySchema(() => z.strictObject({
  enabled: z.boolean(),
  recording: z.boolean(),
  /** A recorder program and a transcription endpoint with credentials are both available. */
  ready: z.boolean(),
  provider: z.string(),
  model: z.string(),
  maxSeconds: z.number().int(),
  recorder: z.string().optional(),
  issue: z.string().optional(),
}))
export type VoiceReport = z.infer<typeof VoiceReport>

export const VoiceTranscript = lazySchema(() => z.strictObject({
  text: z.string(),
  seconds: z.number(),
}))
export type VoiceTranscript = z.infer<typeof VoiceTranscript>
