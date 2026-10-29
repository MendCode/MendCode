import { readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { z } from "zod"
import { PermissionRule, type SessionId } from "@mendcode/protocol"

const Rules = z.array(PermissionRule).max(500)
const File = z.record(z.string(), Rules)
const MAX_DEPTH = 8

/**
 * Permission rules a REST client attached to one session. They are private daemon state (`session-permissions.json`),
 * apply to that session and the sub-agent sessions it spawns, and are evaluated after settings and agent rules.
 */
export function createSessionPermissionRules(input: { dir: string; parentOf(sessionId: SessionId): SessionId | undefined }) {
  const file = path.join(input.dir, "session-permissions.json")
  let rules: Record<string, PermissionRule[]> = {}
  try { rules = File.parse(JSON.parse(readFileSync(file, "utf8"))) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("[DAEMON]: invalid session-permissions.json")
  }
  function save(next: Record<string, PermissionRule[]>) {
    const temporary = `${file}.${process.pid}.tmp`
    writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 })
    renameSync(temporary, file)
    rules = next
  }
  return {
    /** The rules set on this session itself, in the order given. */
    own: (sessionId: SessionId): readonly PermissionRule[] | undefined => rules[sessionId],
    /** Ancestors first, so a child's own rules refine its parent's. Read on every tool call: a plain lookup when none exist. */
    effective(sessionId: SessionId): readonly PermissionRule[] {
      if (!Object.keys(rules).length) return []
      const chain: SessionId[] = []
      for (let id: SessionId | undefined = sessionId; id && chain.length < MAX_DEPTH && !chain.includes(id); id = input.parentOf(id)) chain.unshift(id)
      return chain.flatMap((id) => rules[id] ?? [])
    },
    set(sessionId: SessionId, next: readonly PermissionRule[]) {
      const parsed = Rules.parse(next)
      const copy = { ...rules }
      if (parsed.length) copy[sessionId] = parsed
      else delete copy[sessionId]
      save(copy)
    },
    delete(sessionId: SessionId) {
      if (!(sessionId in rules)) return
      const copy = { ...rules }
      delete copy[sessionId]
      save(copy)
    },
  }
}
export type SessionPermissionRules = ReturnType<typeof createSessionPermissionRules>
