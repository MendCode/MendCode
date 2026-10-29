export const RELEASE_CHANNELS = ["stable", "beta", "dev", "nightly"] as const
export type ReleaseChannel = typeof RELEASE_CHANNELS[number]
export type ReleaseReport = {
  channel: ReleaseChannel
  current: string
  autoupdate: boolean | "notify"
  lastCheckAt: number | null
  latest: string | null
  status: "unchecked" | "up-to-date" | "ahead" | "update-available" | "installed"
  recovery: { current: string; previous: string | null } | null
}
