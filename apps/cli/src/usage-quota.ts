import { createClient } from "@mendcode/client"
import { readLocalEndpoint } from "@mendcode/client/local-endpoint"
import { PROGRAM_NAME } from "@mendcode/program"
import { quotaReadings, shortSpan, type QuotaSnapshotLike } from "@mendcode/protocol/wire"
import { liveDaemon } from "./launcher"

/**
 * `usage --quota [--json] [--dir D]`: the provider quota windows the footer shows, read from a daemon that already runs.
 * Nothing is sent to a provider and no daemon is started: a running daemon sends its last reading of each provider right
 * after `hello`, and that is all this asks for. Without a daemon every window is unknown. Every tier.
 */
export type UsageQuotaCommand = { json: boolean; dir?: string | undefined; error?: string | undefined }

export const USAGE_QUOTA_USAGE = `usage: ${PROGRAM_NAME} usage --quota [--json] [--dir D]\n`

/** The command when `argv` is `usage --quota …`; undefined for every other command. */
export function parseUsageQuota(argv: readonly string[]): UsageQuotaCommand | undefined {
  if (!argv.includes("--quota")) return undefined
  const command: UsageQuotaCommand = { json: false }
  const words: string[] = []
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!
    const [name, inline] = token.split(/=(.*)/s, 2)
    if (token === "--quota") continue
    if (token === "--json") command.json = true
    else if (name === "--dir" || name === "--data-dir") {
      const value = inline ?? argv[++index]
      if (!value || value.startsWith("--")) command.error ??= `${name} needs a value`
      else command.dir = value
    } else if (token.startsWith("-")) command.error ??= `--quota does not combine with ${token}`
    else words.push(token)
  }
  if (words[0] !== "usage") return undefined
  if (words.length > 1) command.error ??= `unexpected argument ${words[1]}`
  return command
}

export type DaemonQuotas = { status: "absent" | "unanswered" } | { status: "ok"; snapshots: QuotaSnapshotLike[] }

/** The last quota snapshots, or why they could not be read. */
export async function daemonQuotas(dataDir: string): Promise<DaemonQuotas> {
  const running = await liveDaemon(dataDir)
  if (!running) return { status: "absent" }
  const quotas: QuotaSnapshotLike[] = []
  const client = createClient({ ...(running.tcp ? { localTcp: () => readLocalEndpoint(dataDir) } : { socketPath: running.socketPath }), name: "usage-quota", reconnect: false, timeoutMs: 5000, onGlobal: (event) => { if (event.type === "quota.snapshot") quotas.push(event) } })
  try {
    await client.connect()
    // The snapshots follow the hello; one answered read after it means they have all arrived.
    const info = await client.send({ type: "daemon.info" })
    return info.ok ? { status: "ok", snapshots: quotas } : { status: "unanswered" }
  } catch {
    return { status: "unanswered" }
  } finally {
    client.close()
  }
}

/** The list as the footer and `api.usage()` read it: one entry per provider window, without engine-internal fields. */
export function quotaList(snapshots: readonly QuotaSnapshotLike[], now: number) {
  return quotaReadings(snapshots, now).map(({ windowId: _id, windowMinutes: _minutes, source: _source, ...reading }) => reading)
}

export function quotaText(list: ReturnType<typeof quotaList>, now: number, status: DaemonQuotas["status"]) {
  if (status === "absent") return "quota: unknown (no daemon is running)\n"
  if (status === "unanswered") return "quota: unknown (the daemon is running but did not answer within 5 s; try again)\n"
  if (!list.length) return "quota: no provider has reported a window yet\n"
  return list.map((reading) => {
    const reset = reading.resetsAt === undefined ? "" : reading.resetsAt > now ? ` · resets in ${shortSpan(reading.resetsAt - now)}` : " · window reset"
    return `${reading.provider} ${reading.window}  ${reading.leftPercent}% left (${reading.usedPercent}% used)${reset} · ${reading.stale ? "stale, " : ""}seen ${shortSpan(reading.ageMs)} ago\n`
  }).join("")
}

type Output = { write(text: string): unknown }

/** Runs the command; the exit code is the return value. */
export async function runUsageQuota(command: UsageQuotaCommand, io: { dataDir: string; out: Output; err: Output; now?: () => number; read?: typeof daemonQuotas }): Promise<number> {
  if (command.error) { io.err.write(`error: ${command.error}\n${USAGE_QUOTA_USAGE}`); return 64 }
  const result = await (io.read ?? daemonQuotas)(command.dir ?? io.dataDir)
  const now = io.now?.() ?? Date.now()
  const list = quotaList(result.status === "ok" ? result.snapshots : [], now)
  io.out.write(command.json ? `${JSON.stringify({ now, daemon: result.status !== "absent", quota: list, ...(result.status === "unanswered" ? { error: "daemon_unanswered" } : {}) })}\n` : quotaText(list, now, result.status))
  return 0
}
