import { statSync } from "node:fs"
import path from "node:path"
import { capPermission, type PermissionMode, type SessionId } from "@mendcode/protocol"
import type { Store } from "@mendcode/store"
import { canonicalDir } from "@mendcode/tools"
import { defaultPermissionFor } from "./profiles"

export type SessionStartResult = { ok: true; sessionId: SessionId; permission: PermissionMode; trusted: boolean; directory: string } | { ok: false; message: string }

/** How many sessions are compared with the folder to reuse the spelling their project already has. */
const KNOWN_SESSIONS = 500

/**
 * A session one session opens in another project's folder (docs/peers.md § Starting a session). The folder is a real directory; the
 * session gets that folder's own usual permission mode (its project setting, else the default) but never more than the opening
 * session has, so a lower-ranked session cannot launch a stronger one. Trust is not granted here: project tools, hooks and
 * extensions of the folder load only if the user already trusted it (`trustedToolDirs`), as in any session opened there.
 */
export function createSessionStarter(input: {
  store: Pick<Store, "listSessions" | "createSession" | "settings" | "meta" | "emptySessions" | "setSessionAgent" | "sessionInfo">
  id(): SessionId
  /** The permission mode a session has right now. */
  permissionOf(sessionId: SessionId): PermissionMode | undefined
  /** The agent a new session in `directory` starts with (the project's default agent, else the daemon's). */
  agentFor(directory: string): string | undefined
  /** What a new session needs besides its row: hooks, sharing, activity, and the permission mode set as a recorded event. */
  opened(input: { sessionId: SessionId; directory: string; mode: PermissionMode; from: SessionId }): Promise<void>
  home: string
  safeMode?: boolean | undefined
}) {
  const trusted = (real: string) => (input.store.settings.get().trustedToolDirs ?? []).some((entry) => canonicalDir(entry) === real)

  /** The folder as a project already spells it: an existing session's own `directory` when it is the same place. */
  function spelled(real: string) {
    return input.store.listSessions({ limit: KNOWN_SESSIONS }).find((session) => canonicalDir(session.directory) === real)?.directory ?? real
  }

  /** What the approval shows before anything is created: the folder, the mode the session would get and the folder's trust. */
  function plan(from: SessionId, directory: string): { ok: true; directory: string; mode: PermissionMode; trusted: boolean } | { ok: false; message: string } {
    if (input.safeMode) return { ok: false, message: "starting sessions is off in safe mode" }
    const expanded = directory === "~" ? input.home : directory.startsWith("~/") ? path.join(input.home, directory.slice(2)) : directory
    if (!path.isAbsolute(expanded)) return { ok: false, message: `${directory} is not an absolute path; name the project's folder in full` }
    try {
      if (!statSync(expanded).isDirectory()) return { ok: false, message: `${directory} is not a folder` }
    } catch {
      return { ok: false, message: `${directory} does not exist` }
    }
    const real = canonicalDir(expanded)
    const usual = defaultPermissionFor(input.store.settings.get(), real) ?? "ask"
    const mode = capPermission(usual, input.permissionOf(from) ?? "ask")
    return { ok: true, directory: spelled(real), mode, trusted: trusted(real) }
  }

  return {
    plan(from: SessionId, directory: string) {
      const found = plan(from, directory)
      return found.ok
        ? `Open a new session in ${found.directory} (${found.trusted ? "trusted for project tools" : "not trusted: its project tools, hooks and extensions stay off"}), permission mode ${found.mode}${found.mode === (defaultPermissionFor(input.store.settings.get(), found.directory) ?? "ask") ? "" : ` (lowered to this session's own)`}`
        : found.message
    },
    async start(request: { from: SessionId; directory: string; title?: string | undefined }): Promise<SessionStartResult> {
      const origin = input.store.sessionInfo(request.from)
      if (!origin) return { ok: false, message: "unknown session" }
      if (origin.parentId) return { ok: false, message: "a sub-agent session cannot start sessions" }
      const found = plan(request.from, request.directory)
      if (!found.ok) return found
      const sessionId = input.id()
      const title = request.title?.trim().slice(0, 120)
      input.store.createSession({ id: sessionId, directory: found.directory, title: title ?? "" })
      // Opened on purpose: never reused, hidden or removed as an empty chat before its first message lands.
      input.store.emptySessions.markExplicit(sessionId)
      if (title) input.store.meta.set(`session.title.manual:${sessionId}`, "true")
      const agent = input.agentFor(found.directory)
      if (agent && agent !== "plan" && agent !== "build") input.store.setSessionAgent(sessionId, agent)
      input.store.meta.set(`session.started-by:${sessionId}`, request.from)
      await input.opened({ sessionId, directory: found.directory, mode: found.mode, from: request.from })
      return { ok: true, sessionId, permission: found.mode, trusted: found.trusted, directory: found.directory }
    },
  }
}
