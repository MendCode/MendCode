import type { ItemId, PermissionMode } from "@mendcode/protocol"
import type { TurnInput } from "@mendcode/kernel"
import { fail, type ComputerPort } from "@mendcode/tools"

/**
 * A peer notice, synthetic turn or detached child cannot activate an exact desktop target. Binding an app asks once in the modes
 * that ask (which app may be driven is the user's call); full access is the user's standing answer, so it binds without a card,
 * like any other tool call in that mode. The code that drives the bound app is an ordinary tool call after that: the permission
 * mode decides (no card in full; the usual one card in the modes that ask), never a second card of its own.
 */
export function bindComputerAuthority(port: ComputerPort, input: TurnInput, main: boolean, itemId: ItemId, mode: () => PermissionMode): ComputerPort {
  return {
    ...port,
    async session(args, signal) {
      if (!port.session) return fail({ title: "MendCode Computer", message: "Computer sessions are disabled" })
      const source = input.authority ?? { sourceId: input.turnId, text: input.text }
      return port.session(args, signal, {
        ...source,
        synthetic: source.synthetic === true || !main,
        async approve(target, sessionMode) {
          if (mode() === "full") return true
          const result = await input.ask({ kind: "approval", title: "MendCode Computer", detail: `${target.appName} · ${target.bundleID} · ${target.pid > 0 ? `PID ${target.pid}` : "not running; launched in the background after approval"} · stays bound to this app and is not brought to the front\nMode: ${sessionMode} · 10 minute limit · 60 second idle expiry`, tool: "computer_session", permission: "execute", itemId })
          return result.kind === "approve"
        },
      })
    },
    async code(args, signal) {
      if (!port.code) return fail({ title: "Computer code", message: "Computer sessions are disabled" })
      if (!main || input.authority?.synthetic) return fail({ title: "Computer code", message: "Computer control requires the current real user turn" })
      return port.code(args, signal)
    },
  }
}
