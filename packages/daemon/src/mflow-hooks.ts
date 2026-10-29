import { realpathSync } from "node:fs"
import path from "node:path"
import type { EngineHooks } from "@mendcode/engine-native"
import type { SessionEvent } from "@mendcode/protocol"
import type { MflowService } from "./mflow"

/** Canonical paths keep aliases, patch moves and symlinked parents on one lease. No contents cross the room. */
export function mflowTargets(tool: string, args: Record<string, unknown>, cwd: string): string[] {
  const direct = args.path ?? args.filePath ?? args.file_path
  const files: string[] = []
  if (["read", "write", "edit", "multiedit"].includes(tool) && typeof direct === "string") files.push(direct)
  if (["write", "edit", "multiedit", "apply_patch", "apply-patch"].includes(tool)) {
    for (const value of [args.files, args.paths]) if (Array.isArray(value)) files.push(...value.filter((entry): entry is string => typeof entry === "string"))
    const patch = args.patch ?? args.patchText ?? args.patch_text
    if (typeof patch === "string") files.push(...[...patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].map((match) => match[1]!.trim()))
  }
  const root = realpathSync(cwd)
  return [...new Set(files.map((file) => {
    let existing = path.resolve(cwd, file), tail: string[] = []
    for (;;) {
      try { existing = realpathSync(existing); break }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || path.dirname(existing) === existing) throw new Error("Mflow could not resolve tool path")
        tail.unshift(path.basename(existing)); existing = path.dirname(existing)
      }
    }
    const relative = path.relative(root, path.join(existing, ...tail)).replaceAll(path.sep, "/")
    if (!relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) throw new Error("Mflow tool path is outside its room project")
    return relative
  }))].sort()
}

export function createMflowHooks(input: { service: MflowService; inner: EngineHooks; alive?(sessionId: string, turnId: string): boolean; cancel?(sessionId: string): void; onWait?(sessionId: string, wait: { file: string; deadlineAt: number } | undefined): void; waitMs?: number; pollMs?: number }) {
  type Before = Parameters<NonNullable<EngineHooks["toolBefore"]>>[0]
  const leases = new Map<string, { event: Before; owner: string; leaseId: string; timer: ReturnType<typeof setInterval> }>()
  const key = (event: Before) => `${event.sessionId}:${event.callId}`
  const owner = (event: Before) => `tool:${event.sessionId}:${event.turnId}:${event.callId}`
  async function release(id: string) {
    const held = leases.get(id)
    if (!held) return
    leases.delete(id)
    clearInterval(held.timer)
    try { await input.service.lease(held.event.cwd, held.owner, { action: "release", leaseId: held.leaseId }) } catch {}
  }
  const hooks: EngineHooks = {
    ...input.inner,
    has: (hook, cwd) => hook === "tool.before" || hook === "tool.after" || input.inner.has(hook, cwd),
    async toolBefore(event) {
      const verdict = input.inner.has("tool.before", event.cwd) ? await input.inner.toolBefore?.(event) : undefined
      if (verdict?.block !== undefined || !input.service.config(event.cwd).enabled) return verdict
      let waiting = false
      try {
        const files = mflowTargets(event.tool, verdict?.args ?? event.args, event.cwd)
        if (!files.length) return verdict
        if (files.length > 128) return { block: "Mflow tool file limit exceeded" }
        const deadline = Date.now() + (input.waitMs ?? 90_000)
        for (;;) {
          if (input.alive && !input.alive(event.sessionId, event.turnId)) return { block: "Mflow wait cancelled" }
          const result = await input.service.lease(event.cwd, owner(event), { action: "acquire", files, mode: event.tool === "read" ? "read" : "write" })
          if (result.ok && result.lease) {
            // Renew until tool.after or the turn ends. A restart leaves only a bounded TTL.
            const timer = setInterval(() => {
              void input.service.lease(event.cwd, owner(event), { action: "renew", leaseId: result.lease!.leaseId }).then((renewed) => {
                if (!renewed.ok) { input.cancel?.(event.sessionId); void release(key(event)) }
              }).catch(() => { input.cancel?.(event.sessionId); void release(key(event)) })
            }, 10_000)
            timer.unref()
            leases.set(key(event), { event, owner: owner(event), leaseId: result.lease.leaseId, timer })
            return verdict
          }
          if (!result.conflict) return { block: result.message ?? "Mflow lease unavailable" }
          waiting = true
          input.onWait?.(event.sessionId, { file: result.conflict.files[0] ?? files[0]!, deadlineAt: deadline })
          if (Date.now() >= deadline) return { block: "Mflow wait timed out: file locked" }
          await new Promise((resolve) => setTimeout(resolve, Math.min(input.pollMs ?? 750, Math.max(1, deadline - Date.now()))))
        }
      } catch { return { block: "Mflow lock unavailable; start coordination or check the relay" } }
      finally { if (waiting) input.onWait?.(event.sessionId, undefined) }
    },
    async toolAfter(event) {
      try { return input.inner.has("tool.after", event.cwd) ? await input.inner.toolAfter?.(event) : undefined }
      finally { await release(key(event)) }
    },
  }
  function observe(event: SessionEvent) {
    if (event.type === "item.completed") for (const [id, held] of leases) if (held.event.sessionId === event.sessionId && held.event.itemId === event.itemId) void release(id)
    if (["turn.completed", "turn.cancelled", "turn.failed", "turn.interrupted"].includes(event.type)) {
      for (const [id, held] of leases) if (held.event.sessionId === event.sessionId) void release(id)
    }
  }
  async function stop() { await Promise.all([...leases.keys()].map(release)) }
  return { hooks, observe, stop }
}
