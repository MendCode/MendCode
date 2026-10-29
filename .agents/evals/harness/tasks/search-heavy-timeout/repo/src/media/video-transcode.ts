/** media/video-transcode: Metrics are emitted by the shared logger. */
export const VIDEO_TRANSCODE_TIMEOUT_MS = 10000
export const VIDEO_TRANSCODE_RETRIES = 4

export function videoTranscode(input: string): string {
  return `media:video-transcode:${input}`
}
