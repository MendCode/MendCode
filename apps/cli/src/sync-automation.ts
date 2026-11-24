import path from "node:path"
import type { CommandInput } from "@mendcode/client"
import type { SessionId } from "@mendcode/protocol"

/** `mendcode sync …` (docs/sync.md): this machine's session sync with a saved remote, the hub. */
export type SyncAutomation = {
  kind: "sync"
  action: "enable" | "disable" | "status" | "now" | "take" | "release" | "handoff" | "hub-off"
  remote?: string
  id?: string
  tokenFile?: string
  pathMap?: string[]
  memories?: boolean
  settings?: boolean
}

export const SYNC_USAGE = "usage: sync enable REMOTE [--sync-token-file F] [--path-map LOCAL=REMOTE]... [--no-memories] [--no-settings] | disable | status | now | take ID | release ID | handoff ID | hub-off"

export function parseSyncAutomation(words: string[], flags: Map<string, string | true>, repeated: Map<string, string[]>): SyncAutomation | { error: string } {
  const [action, target, ...extra] = words
  if (extra.length) return { error: SYNC_USAGE }
  const enableOnly = flags.has("sync-token-file") || repeated.has("path-map") || flags.has("no-memories") || flags.has("no-settings")
  if (action !== "enable" && enableOnly) return { error: "--sync-token-file, --path-map, --no-memories and --no-settings belong to sync enable" }
  switch (action) {
    case "enable": {
      if (!target || !/^[A-Za-z0-9_-]{1,64}$/.test(target)) return { error: "sync enable needs the name of a saved remote (mendcode remote list)" }
      const tokenFile = flags.get("sync-token-file")
      const pathMap = repeated.get("path-map") ?? []
      return { kind: "sync", action, remote: target, ...(typeof tokenFile === "string" ? { tokenFile } : {}), ...(pathMap.length ? { pathMap } : {}), memories: !flags.has("no-memories"), settings: !flags.has("no-settings") }
    }
    case "disable": case "status": case "now": case "hub-off":
      return target ? { error: SYNC_USAGE } : { kind: "sync", action }
    case "take": case "release": case "handoff":
      return target ? { kind: "sync", action, id: target } : { error: `sync ${action} needs a session ID` }
    default: return { error: SYNC_USAGE }
  }
}

type Reply = { ok: true; result: Record<string, unknown> } | { ok: false; message: string; code: string }
type Context = { dataDir: string; request(command: CommandInput): Promise<Reply>; result(data: Record<string, unknown>, human: string): number; fail(message: string, exit?: number): number }

const time = (at: unknown) => typeof at === "number" && at > 0 ? new Date(at).toLocaleTimeString() : "never"

function statusText(status: Record<string, unknown>) {
  if (status.mode === "off") return "Sync: off (mendcode sync enable REMOTE)\n"
  if (status.mode === "hub") {
    const leases = (status.leases ?? []) as Array<{ sessionId: string; holder: string; until: number }>
    return `Sync: this machine is the hub\n${leases.length ? leases.map((lease) => `  ${lease.sessionId}  written on ${lease.holder} (lease until ${time(lease.until)})`).join("\n") : "  no device holds a session"}\n`
  }
  const sessions = (status.sessions ?? []) as Array<{ sessionId: string; title: string; owner: string; state: string; note?: string }>
  const lines = [`Sync: with ${status.remote} · ${status.connected ? "connected" : "not connected"} · last round ${time(status.lastOkAt)}${status.lastError ? ` · ${status.lastError}` : ""}`]
  for (const session of sessions) lines.push(`  ${session.sessionId}  ${(session.title || "untitled").slice(0, 50)}  · owned by ${session.owner}${session.note ? ` · ${session.note}` : ""}`)
  return `${lines.join("\n")}\n`
}

export async function runSyncAutomation(command: SyncAutomation, ctx: Context): Promise<number> {
  const control = async (input: Record<string, unknown>) => ctx.request({ type: "sync.control", input } as CommandInput)
  if (command.action === "enable" || command.action === "disable") {
    const { readSyncConfig, writeSyncConfig } = await import("@mendcode/daemon/sync-config")
    if (command.action === "enable") {
      const { parsePathRule } = await import("@mendcode/daemon/project-identity")
      const { readRemoteProfiles } = await import("./remote-profiles")
      if (!readRemoteProfiles(ctx.dataDir)?.remotes[command.remote!]) return ctx.fail(`no saved remote named ${command.remote} (mendcode remote list)`)
      let pathMap
      try { pathMap = (command.pathMap ?? []).map(parsePathRule) } catch (error) { return ctx.fail((error as Error).message, 64) }
      const tokenFile = path.resolve(command.tokenFile ?? path.join(ctx.dataDir, "remote", `${command.remote}.sync-token`))
      writeSyncConfig(ctx.dataDir, { remote: command.remote!, tokenFile, pathMap, memories: command.memories !== false, settings: command.settings !== false })
    } else if (readSyncConfig(ctx.dataDir)) writeSyncConfig(ctx.dataDir, undefined)
    const reply = await control({ action: "reload" })
    if (!reply.ok) return ctx.fail(reply.message)
    return ctx.result(reply.result, command.action === "enable" ? `Sync on with ${command.remote}: sessions of ${command.remote} appear here; \`mendcode sync take ID\` continues one on this machine.\n` : "Sync off. Copies already here stay.\n")
  }
  const reply = command.action === "take" || command.action === "release" || command.action === "handoff"
    ? await control({ action: command.action, sessionId: command.id as SessionId })
    : await control({ action: command.action })
  if (!reply.ok) return ctx.fail(reply.message)
  if (command.action === "status" || command.action === "now") return ctx.result(reply.result, statusText(reply.result))
  if (command.action === "hub-off") return ctx.result(reply.result, "This machine no longer serves as a hub.\n")
  return ctx.result(reply.result, `${command.id} is now written on ${String(reply.result.owner)}.\n`)
}
