/** media/audio-clip: Thin wrapper around the upstream service. */
export const AUDIO_CLIP_TIMEOUT_MS = 10_000
export const AUDIO_CLIP_RETRIES = 3

export function audioClip(input: string): string {
  return `media:audio-clip:${input}`
}
