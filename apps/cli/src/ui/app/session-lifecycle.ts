import type { SessionMetaInput } from "@mendcode/protocol"
import type { AppContext } from "./context"

export function createSessionLifecycle(ctx: AppContext, reload: () => Promise<void>) {
  const { input, state, fail, say } = ctx
  let undo: import("@mendcode/protocol").SessionId | undefined
  async function meta(request: SessionMetaInput, sessionId = state.sessionId) {
    if (input.remote) return fail("Session metadata is local only")
    const reply = await input.send({ type: "session.meta", sessionId, input: request })
    if (!reply.ok) return fail(reply.error.message)
    if (request.action === "settle") {
      undo = sessionId
      say("settled · /settle undo", "success")
    } else say(request.action.replaceAll("_", " "), "success")
    await reload()
  }
  async function titleCommand(args: string) {
    if (args.trim() !== "regenerate") return say("/title regenerate", "warning")
    await meta({ action: "regenerate_title" })
  }
  async function pinCommand(args: string) {
    if (args && args !== "on" && args !== "off") return say("/pin [on|off]", "warning")
    await meta({ action: "pin", pinned: args !== "off" })
  }
  async function settleCommand(args: string) {
    if (args === "undo") {
      await meta({ action: "restore" }, undo ?? state.sessionId)
      return
    }
    if (args === "rules off") return meta({ action: "rules", disabled: true })
    if (args === "rules pr") return meta({ action: "rules", prClosed: true, disabled: false })
    const days = /^rules inactive ([1-9]\d*)$/.exec(args)
    if (days) {
      if (Number(days[1]) > 3650) return say("inactive days: 1–3650", "warning")
      return meta({ action: "rules", inactiveDays: Number(days[1]), disabled: false })
    }
    if (args.startsWith("rules")) return say("/settle rules off|pr|inactive N", "warning")
    if (args === "check") return meta({ action: "check" })
    await meta({ action: "settle", ...(args ? { reason: args.slice(0, 400) } : {}) })
  }
  async function prMetadata(args: string): Promise<boolean> {
    const [action, ...rest] = args.trim().split(/\s+/)
    if (action !== "link" && action !== "unlink" && action !== "refresh") return false
    await meta({ action: action === "link" ? "link_pr" : action === "unlink" ? "unlink_pr" : "check", ...(rest.length ? { pr: rest.join(" ") } : {}) })
    return true
  }
  return { titleCommand, pinCommand, settleCommand, prMetadata }
}
