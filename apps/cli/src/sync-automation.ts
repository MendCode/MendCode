import path from "node:path"
import type { CommandInput } from "@mendcode/client"
import type { SessionId } from "@mendcode/protocol"

/** `mendcode sync …` (docs/sync.md): this machine's session sync with a saved remote, the hub. */
export type SyncAutomation = {
  kind: "sync"
  action: "enable" | "disable" | "status" | "now" | "take" | "release" | "handoff" | "hub-off" | "parity" | "follow"
  remote?: string
  id?: string
  tokenFile?: string
  pathMap?: string[]
  memories?: boolean
  settings?: boolean
  follow?: boolean
  /** `parity`: bring the hub level (else only compare), and what that may send. */
  apply?: boolean
  allowFlagged?: string[]
  allowCode?: boolean
}

export const SYNC_USAGE = "usage: sync enable REMOTE [--sync-token-file F] [--path-map LOCAL=REMOTE]... [--no-memories] [--no-settings] [--follow] | disable | status | now | take ID | release ID | handoff ID | hub-off | parity [REMOTE] [--apply] [--code] [--allow-flagged PATH]... | follow on|off"

export function parseSyncAutomation(words: string[], flags: Map<string, string | true>, repeated: Map<string, string[]>): SyncAutomation | { error: string } {
  const [action, target, ...extra] = words
  if (extra.length) return { error: SYNC_USAGE }
  const enableOnly = flags.has("sync-token-file") || repeated.has("path-map") || flags.has("no-memories") || flags.has("no-settings")
  if (action !== "enable" && enableOnly) return { error: "--sync-token-file, --path-map, --no-memories and --no-settings belong to sync enable" }
  if (action !== "enable" && flags.has("follow")) return { error: "--follow belongs to sync enable; `sync follow on|off` changes it later" }
  if (action !== "parity" && (flags.has("apply") || flags.has("code") || repeated.has("allow-flagged"))) return { error: "--apply, --code and --allow-flagged belong to sync parity" }
  switch (action) {
    case "enable": {
      if (!target || !/^[A-Za-z0-9_-]{1,64}$/.test(target)) return { error: "sync enable needs the name of a saved remote (mendcode remote list)" }
      const tokenFile = flags.get("sync-token-file")
      const pathMap = repeated.get("path-map") ?? []
      return { kind: "sync", action, remote: target, ...(typeof tokenFile === "string" ? { tokenFile } : {}), ...(pathMap.length ? { pathMap } : {}), memories: !flags.has("no-memories"), settings: !flags.has("no-settings"), follow: flags.has("follow") }
    }
    case "parity": {
      if (target && !/^[A-Za-z0-9_-]{1,64}$/.test(target)) return { error: "sync parity takes the name of a saved remote (mendcode remote list)" }
      if (flags.has("code") && !flags.has("apply")) return { error: "--code only matters with --apply" }
      if (repeated.has("allow-flagged") && !flags.has("apply")) return { error: "--allow-flagged only matters with --apply" }
      return { kind: "sync", action, ...(target ? { remote: target } : {}), apply: flags.has("apply"), allowFlagged: repeated.get("allow-flagged") ?? [], allowCode: flags.has("code") }
    }
    case "follow":
      return target === "on" || target === "off" ? { kind: "sync", action, follow: target === "on" } : { error: "usage: sync follow on|off" }
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
  const follow = status.follow as { at: number; ok: boolean; summary: string } | undefined
  if (follow) lines.push(`  hub follows this machine's configuration: ${follow.at ? `${follow.ok ? "last check" : "failed"} ${time(follow.at)} · ${follow.summary}` : "not checked yet"}`)
  for (const session of sessions) lines.push(`  ${session.sessionId}  ${(session.title || "untitled").slice(0, 50)}  · owned by ${session.owner}${session.note ? ` · ${session.note}` : ""}`)
  return `${lines.join("\n")}\n`
}

type ParityRow = { kind: string; item: string; state: string; note?: string }
const STATE_WORD: Record<string, string> = { same: "same", missing: "missing there", differs: "differs", state: "on/off differs", code: "code, not sent", blocked: "blocked", "hub-only": "only there", "no-tool": "not installed there" }

/** The rows that are not level, one line each, then the count of the rest. */
function parityText(result: Record<string, unknown>): string {
  const rows = ((result.after ?? result.before) as ParityRow[]) ?? []
  const versions = (result.versions ?? {}) as { here?: string; there?: string }
  const lines = [`Parity with ${result.remote}: this machine against the hub${versions.here || versions.there ? ` (MendCode ${versions.here ?? "?"} here, ${versions.there ?? "?"} there)` : ""}`]
  const open = rows.filter((row) => row.state !== "same")
  const width = Math.max(0, ...open.map((row) => row.kind.length))
  for (const row of open) lines.push(`  ${row.kind.padEnd(width)}  ${row.item}  ${STATE_WORD[row.state] ?? row.state}${row.note ? `  ${row.note}` : ""}`)
  const counts = (result.counts ?? {}) as Record<string, number>
  lines.push(`  ${rows.filter((row) => row.state === "same").length} level${open.length ? ` · ${Object.entries(counts).filter(([state, count]) => state !== "same" && count > 0).map(([state, count]) => `${count} ${STATE_WORD[state] ?? state}`).join(" · ")}` : ": nothing differs"}`)
  const done = result.import as { importId: string; summary: string; blocked: string[]; notes: string[] } | undefined
  if (done) {
    lines.push(`  applied on the hub: import ${done.importId} · ${done.summary}`, ...done.blocked.map((line) => `  blocked there: ${line}`), ...done.notes.map((line) => `  note: ${line}`), `  undo on the hub: mendcode config-bundle rollback ${done.importId}`)
    if (rows.some((row) => row.kind === "mcp" && row.state === "same")) lines.push("  MCP servers arrived pending: approve them in /mcp on the hub and sign in there; logins are per machine")
  } else if (result.applied === true) lines.push("  nothing to send")
  else if (open.some((row) => ["missing", "differs", "state"].includes(row.state))) lines.push("  bring the hub level: mendcode sync parity --apply")
  return `${lines.join("\n")}\n`
}

export async function runSyncAutomation(command: SyncAutomation, ctx: Context): Promise<number> {
  const control = async (input: Record<string, unknown>) => ctx.request({ type: "sync.control", input } as CommandInput)
  if (command.action === "parity") {
    const reply = await ctx.request({ type: "config.parity", input: { op: "run", ...(command.remote ? { remote: command.remote } : {}), ...(command.apply ? { apply: true } : {}), ...(command.allowFlagged?.length ? { allowFlagged: command.allowFlagged } : {}), ...(command.allowCode ? { allowCode: true } : {}) } } as CommandInput)
    if (!reply.ok) return ctx.fail(reply.message)
    return ctx.result(reply.result, parityText(reply.result))
  }
  if (command.action === "follow") {
    const { readSyncConfig, writeSyncConfig } = await import("@mendcode/daemon/sync-config")
    const current = readSyncConfig(ctx.dataDir)
    if (!current) return ctx.fail("sync is off on this machine (mendcode sync enable REMOTE)")
    writeSyncConfig(ctx.dataDir, { ...current, follow: command.follow === true })
    const reloaded = await control({ action: "reload" })
    if (!reloaded.ok) return ctx.fail(reloaded.message)
    return ctx.result(reloaded.result, command.follow ? `The hub (${current.remote}) now follows this machine's portable configuration: checked every 10 minutes and by \`sync now\`, using the saved remote's full token. Code that runs on its own is never sent this way.\n` : "The hub no longer follows this machine's configuration.\n")
  }
  if (command.action === "enable" || command.action === "disable") {
    const { readSyncConfig, writeSyncConfig } = await import("@mendcode/daemon/sync-config")
    if (command.action === "enable") {
      const { parsePathRule } = await import("@mendcode/daemon/project-identity")
      const { readRemoteProfiles } = await import("./remote-profiles")
      if (!readRemoteProfiles(ctx.dataDir)?.remotes[command.remote!]) return ctx.fail(`no saved remote named ${command.remote} (mendcode remote list)`)
      let pathMap
      try { pathMap = (command.pathMap ?? []).map(parsePathRule) } catch (error) { return ctx.fail((error as Error).message, 64) }
      const tokenFile = path.resolve(command.tokenFile ?? path.join(ctx.dataDir, "remote", `${command.remote}.sync-token`))
      writeSyncConfig(ctx.dataDir, { remote: command.remote!, tokenFile, pathMap, memories: command.memories !== false, settings: command.settings !== false, follow: command.follow === true })
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
