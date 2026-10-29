import type { HooksReport } from "@mendcode/protocol"
import { createHooksPageState, preload } from "../lazy-pages"
import type { AppContext } from "./context"

const pendingTotal = (report: HooksReport) => report.pending.hooks + report.pending.tools + report.pending.extensions + (report.pending.mcp ?? 0)

/** `/hooks` (shell hooks and their recent runs), `/trust`, and the startup prompt to trust a project's hooks, tools and extensions. */
export function createHooks(ctx: AppContext) {
  const { state, input } = ctx
  const directory = () => input.directory ?? ""

  async function loadHooks() {
    const reply = await input.send({ type: "hooks.list", directory: directory() })
    const report = reply.ok ? (reply.result as HooksReport | undefined) : undefined
    if (report?.pending) {
      state.hooksReport = report
      state.hooksError = ""
    } else if (reply.ok) state.hooksError = "the daemon sent no hooks report"
    else state.hooksError = reply.error.code === "invalid_command" ? "the daemon is older than this terminal, or hooks are local-only here; restart the daemon" : reply.error.message
    ctx.requestFrame()
    return state.hooksReport
  }

  /** The project trust `/tools` sets: hooks, tools and extensions of this directory follow it. The daemon's settings push lets this terminal load (or drop) extensions. */
  async function setTrust(trusted: boolean) {
    const reply = await input.send({ type: "tools.trust", directory: directory(), trusted })
    if (!reply.ok) {
      state.notice = reply.error.message
      ctx.requestFrame()
      return false
    }
    state.notice = trusted ? "project trusted: its hooks, tools and extensions can run" : "project no longer trusted"
    await loadHooks()
    return true
  }

  async function openHooks(prompt = false) {
    await preload("hooks")
    state.page = "hooks"
    state.hooksState = createHooksPageState(prompt)
    state.hooksReport = undefined
    state.hooksError = ""
    ctx.requestFrame()
    await loadHooks()
  }

  /** `/trust`: no argument shows what waits for trust and asks; `on` / `off` set it; `status` says where it stands. */
  async function trustCommand(args: string) {
    const word = args.trim().toLowerCase()
    if (word === "on" || word === "off") {
      await setTrust(word === "on")
      return
    }
    if (word && word !== "status") {
      state.notice = "usage: /trust [on|off|status]"
      return
    }
    const report = await loadHooks()
    if (!report) return
    if (word === "status" || pendingTotal(report) === 0) {
      state.notice = report.trusted ? "this project is trusted" : "this project is not trusted; nothing project-local is waiting for it"
      return
    }
    await openHooks(true)
  }

  /** Once at startup: a project that ships hooks, tools or extensions waiting for trust asks before anything of it runs. */
  async function checkStartupTrust() {
    if (input.trustPrompt === false || input.remote || input.startup?.prompt !== undefined || !input.directory) return
    const report = await loadHooks().catch(() => undefined)
    if (!report || pendingTotal(report) === 0 || state.page !== "chat") return
    await preload("hooks")
    state.hooksState = createHooksPageState(true)
    state.page = "hooks"
    ctx.requestFrame()
  }

  return { loadHooks, setTrust, openHooks, trustCommand, checkStartupTrust }
}
