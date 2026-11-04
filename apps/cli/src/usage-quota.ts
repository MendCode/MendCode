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

/** The last quota snapshot of every provider a running daemon holds; undefined when none runs or it does not answer. */
export async function daemonQuotas(dataDir: string): Promise<QuotaSnapshotLike[] | undefined> {
  const running = await liveDaemon(dataDir)
  if (!running) return undefined
  const quotas: QuotaSnapshotLike[] = []
  const client = createClient({ ...(running.tcp ? { localTcp: () => readLocalEndpoint(dataDir) } : { socketPath: running.socketPath }), name: "usage-quota", reconnect: false, timeoutMs: 1500, onGlobal: (event) => { if (event.type === "quota.snapshot") quotas.push(event) } })
  try {
    await client.connect()
    // The snapshots follow the hello; one answered read after it means they have all arrived.
    const info = await client.send({ type: "daemon.info" })
    return info.ok ? quotas : undefined
  } catch {
    return undefined
  } finally {
    client.close()
  }
}

/** The list as the footer and `api.usage()` read it: one entry per provider window, without engine-internal fields. */
export function quotaList(snapshots: readonly QuotaSnapshotLike[], now: number) {
  return quotaReadings(snapshots, now).map(({ windowId: _id, windowMinutes: _minutes, source: _source, ...reading }) => reading)
}

export function quotaText(list: ReturnType<typeof quotaList>, now: number, daemon: boolean) {
  if (!daemon) return "quota: unknown (no daemon is running)\n"
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
  const snapshots = await (io.read ?? daemonQuotas)(command.dir ?? io.dataDir)
  const now = io.now?.() ?? Date.now()
  const list = quotaList(snapshots ?? [], now)
  io.out.write(command.json ? `${JSON.stringify({ now, daemon: snapshots !== undefined, quota: list })}\n` : quotaText(list, now, snapshots !== undefined))
  return 0
}
