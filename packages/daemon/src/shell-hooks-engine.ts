import type { EngineHooks } from "@mendcode/engine-native"
import type { ShellHooks } from "./shell-hooks"

/**
 * Puts the shell hooks on the native engine's points: `PreToolUse` runs before the extension `tool.before` handlers
 * (a block from either refuses the call), `PostToolUse` and `PostToolUseFailure` after the extension `tool.after`
 * handlers, on what they left; `PermissionRequest` right before an approval prompt; `PreCompact` and `PostCompact`
 * around a compaction. Without a configured hook for the project `has` stays a set lookup and no await is added.
 */
export function withShellHooks(inner: EngineHooks, shell: ShellHooks): EngineHooks {
  return {
    ...inner,
    async prepare(ref) {
      shell.refresh(ref.cwd)
      await inner.prepare?.(ref)
    },
    has: (hook, cwd) =>
      (hook === "tool.before" && shell.has("PreToolUse", cwd)) ||
      (hook === "tool.after" && (shell.has("PostToolUse", cwd) || shell.has("PostToolUseFailure", cwd))) ||
      (hook === "permission.request" && shell.has("PermissionRequest", cwd)) ||
      (hook === "compact.before" && shell.has("PreCompact", cwd)) ||
      (hook === "compact.after" && shell.has("PostCompact", cwd)) ||
      inner.has(hook, cwd),
    async toolBefore(event) {
      if (shell.has("PreToolUse", event.cwd)) {
        const refused = await shell.toolBefore(event)
        if (refused) return refused
      }
      return inner.has("tool.before", event.cwd) ? inner.toolBefore?.(event) : undefined
    },
    async toolAfter(event) {
      let changed = inner.has("tool.after", event.cwd) ? await inner.toolAfter?.(event) : undefined
      if (shell.has("PostToolUse", event.cwd)) {
        const feedback = await shell.toolAfter({ ...event, output: changed?.output ?? event.output, isError: changed?.isError ?? event.isError })
        if (feedback) changed = { ...changed, ...feedback }
      }
      if ((changed?.isError ?? event.isError) && shell.has("PostToolUseFailure", event.cwd)) {
        const feedback = await shell.toolFailed({ ...event, output: changed?.output ?? event.output })
        if (feedback) changed = { ...changed, ...feedback }
      }
      return changed
    },
    async permissionRequest(event) {
      const refused = shell.has("PermissionRequest", event.cwd) ? await shell.permissionRequest(event) : undefined
      return refused ?? (inner.has("permission.request", event.cwd) ? inner.permissionRequest?.(event) : undefined)
    },
    async compactBefore(event) {
      if (shell.has("PreCompact", event.cwd)) {
        const refused = await shell.compactBefore(event)
        if (refused) return refused
      }
      return inner.has("compact.before", event.cwd) ? inner.compactBefore?.(event) : undefined
    },
    async compactAfter(event) {
      if (inner.has("compact.after", event.cwd)) await inner.compactAfter?.(event)
      if (shell.has("PostCompact", event.cwd)) await shell.compactAfter({ ...event, reason: event.reason ?? "auto" })
    },
  }
}
