import { RELEASE_CHANNELS, type ReleaseChannel, type ReleaseReport } from "@mendcode/protocol/wire"
import type { AppContext } from "./context"
import { preload } from "../lazy-pages"

export function createRelease(ctx: AppContext) {
  const { input, state, say, requestFrame } = ctx
  async function load(check = false, channel?: ReleaseChannel) {
    if ((check || channel) && input.remote?.readOnly) { say("release changes disabled in read-only mode", "warning"); return }
    state.releaseLoading = true
    state.releaseError = ""
    requestFrame()
    try {
      const reply = await input.send(channel ? { type: "release.set", channel } : { type: check ? "release.check" : "release.inspect" })
      if (!reply.ok) throw new Error(reply.error.message)
      state.releaseReport = reply.result as ReleaseReport | undefined
      if (state.releaseReport) state.releaseSelected = RELEASE_CHANNELS.indexOf(state.releaseReport.channel)
    } catch (error) { state.releaseError = error instanceof Error ? error.message : String(error) }
    finally { state.releaseLoading = false; requestFrame() }
  }
  async function policy(value?: boolean | "notify") {
    if (input.remote?.readOnly) { say("update settings disabled in read-only mode", "warning"); return }
    const previous = state.releaseReport?.autoupdate ?? false
    const autoupdate = value ?? (previous === false ? "notify" : previous === "notify" ? true : false)
    const reply = await input.send({ type: "settings.set", patch: { autoupdate } })
    if (!reply.ok) state.releaseError = reply.error.message
    else await load()
    requestFrame()
  }
  async function releaseCommand(text: string) {
    const match = /^\/release-channel(?:\s+(.*))?$/.exec(text.trim())
    if (!match) return false
    await preload("release-channel")
    state.page = "release-channel"
    state.releaseScroll = 0
    const args = match[1]?.trim() ?? ""
    if (RELEASE_CHANNELS.includes(args as ReleaseChannel)) await load(false, args as ReleaseChannel)
    else if (args === "check") await load(true)
    else if (/^autoupdate (off|notify|on)$/.test(args)) await policy(args.endsWith("notify") ? "notify" : args.endsWith("on"))
    else if (!args || args === "inspect") await load()
    else state.releaseError = "Usage: /release-channel [stable|beta|nightly|dev|check|inspect|autoupdate off|notify|on]"
    requestFrame()
    return true
  }
  async function releaseKey(key: string) {
    if (key === "\x1b" || key === "q") state.page = "chat"
    else if (key === "\x1b[A" || key === "k") state.releaseSelected = ((state.releaseSelected ?? 0) + RELEASE_CHANNELS.length - 1) % RELEASE_CHANNELS.length
    else if (key === "\x1b[B" || key === "j") state.releaseSelected = ((state.releaseSelected ?? 0) + 1) % RELEASE_CHANNELS.length
    else if (key === "\r") await load(false, RELEASE_CHANNELS[state.releaseSelected ?? 0]!)
    else if (key === "c") await load(true)
    else if (key === "r") await load()
    else if (key === "a") await policy()
    else if (key === "\x1b[6~") state.releaseScroll = (state.releaseScroll ?? 0) + 8
    else if (key === "\x1b[5~") state.releaseScroll = Math.max(0, (state.releaseScroll ?? 0) - 8)
    requestFrame()
  }
  return { releaseCommand, releaseKey }
}
