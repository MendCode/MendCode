import type { SandboxStatus, Settings } from "@mendcode/protocol"
import type { AppContext } from "./context"

type SandboxSetting = NonNullable<Settings["sandbox"]>
type Mode = NonNullable<SandboxSetting["mode"]>

const MODES: readonly Mode[] = ["off", "read-only", "workspace-write"]
const ALIASES: Readonly<Record<string, Mode>> = { on: "workspace-write", write: "workspace-write", ro: "read-only", readonly: "read-only" }
export const SANDBOX_USAGE = "usage: /sandbox [off | read-only | workspace-write | toggle | network on|off | allow <path> | deny <path>]"

/**
 * `/sandbox` shows and changes the OS sandbox for the agent's shell commands (the `sandbox` setting). The daemon decides
 * what the system can enforce; with a mode set and no backend, commands are refused rather than run unconfined.
 */
export function createSandbox(ctx: AppContext) {
  const { state, input, say, fail, requestFrame } = ctx

  async function apply(next: SandboxSetting, done: string) {
    const reply = await input.send({ type: "settings.set", patch: { sandbox: next } })
    if (!reply.ok) { fail(reply.error.message); return }
    state.settingsNow = ((reply.result as { settings?: Settings } | undefined)?.settings) ?? { ...state.settingsNow, sandbox: next }
    say(done, "success")
    requestFrame()
  }

  async function sandboxCommand(text: string): Promise<boolean> {
    const match = /^\/sandbox(?:\s+(.*))?$/s.exec(text.trim())
    if (!match) return false
    if (input.remote) { fail("The sandbox is controlled on the machine that runs the commands"); return true }
    const words = (match[1] ?? "").trim().split(/\s+/).filter(Boolean)
    const current: SandboxSetting = { ...state.settingsNow.sandbox }
    const head = (words[0] ?? "").toLowerCase()
    if (head === "") {
      const reply = await input.send({ type: "sandbox.status" })
      if (!reply.ok) { fail(reply.error.message); return true }
      const status = reply.result as SandboxStatus
      say(`sandbox ${status.detail}${status.writableRoots.length ? ` · extra writable: ${status.writableRoots.join(", ")}` : ""}`, status.mode !== "off" && !status.enforced ? "warning" : "info")
      return true
    }
    const mode = head === "toggle" ? ((current.mode ?? "off") === "off" ? "workspace-write" : "off") : MODES.find((candidate) => candidate === head) ?? ALIASES[head]
    if (mode) {
      await apply({ ...current, mode }, mode === "off" ? "sandbox off: commands run unconfined" : `sandbox ${mode}, network ${current.network ?? "off"}`)
      return true
    }
    if (head === "network" && (words[1] === "on" || words[1] === "off")) {
      await apply({ ...current, network: words[1] }, `sandbox network ${words[1]}${(current.mode ?? "off") === "off" ? " (the sandbox itself is off)" : ""}`)
      return true
    }
    if ((head === "allow" || head === "deny") && words.length > 1) {
      const target = words.slice(1).join(" ")
      if (!target.startsWith("/")) { say("give an absolute path", "warning"); return true }
      const roots = (current.writableRoots ?? []).filter((root) => root !== target)
      const next = head === "allow" ? [...roots, target] : roots
      if (next.length > 20) { say("at most 20 extra writable paths", "warning"); return true }
      await apply({ ...current, writableRoots: next }, `${head === "allow" ? "writable" : "no longer writable"}: ${target}`)
      return true
    }
    say(SANDBOX_USAGE, "warning")
    return true
  }

  return { sandboxCommand }
}
