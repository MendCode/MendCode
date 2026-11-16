import type { ExternalBotInfo } from "@mendcode/protocol"
import type { AcpAgentConfig } from "../../engine-acp/src/agents"
import { offerConnectorAgents } from "./bot-connector-agents"
import type { BotConnector } from "./bot-service"

/**
 * The Hermes Agent connector (experimental bots, docs/agents.md "Hermes bots"). Every Hermes profile is a bot: `bot.list` carries it
 * in `external` with its model and whether it has a chat running, and a chat with it is an ordinary MendCode session on the model
 * `acp:hermes-<profile>`, which the ACP engine runs as `hermes -p <profile> acp` (Hermes' own editor protocol, so the profile's memory,
 * skills and history are the ones its own app shows).
 *
 * Where Hermes is: `MENDCODE_HERMES_URL` (and `MENDCODE_HERMES_TOKEN` for its session token, `MENDCODE_HERMES_COMMAND` / `MENDCODE_HERMES_HOME`
 * for the program that serves a chat), else the headless `hermes serve` a desktop app runs on this machine, found in the
 * process list. That server keeps its token only in its own environment, which the same user may read; MendCode reads it per call and never
 * stores, logs or sends it anywhere but that loopback address. Loaded by the first `bot.list` with the flag on and Hermes configured or found.
 */

export type HermesDeps = {
  env?: Readonly<Record<string, string | undefined>>
  fetch?: typeof fetch
  /** Runs a program with an argument array and answers its stdout ("" on any failure). */
  run?(argv: string[]): Promise<string>
  now?(): number
}

type Source = { url: string; token?: string; command: string; args: string[]; home?: string; app?: string }
type Profile = { name: string; path?: string; model?: string; display_name?: string; description?: string }

const SOURCE_TTL_MS = 30_000
const LIST_TTL_MS = 8_000
const TIMEOUT_MS = 4_000
/** A profile with a session Hermes calls active is working. */
const ACTIVE_SESSIONS = 50
const SERVE = /^(.*?) -m hermes_cli\.main serve\b/

async function defaultRun(argv: string[]): Promise<string> {
  try {
    const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore", stdin: "ignore" })
    const text = await new Response(proc.stdout).text()
    await proc.exited
    return text
  } catch {
    return ""
  }
}

/** The `hermes serve` the user's app runs: its address, token and the program that starts a chat. Undefined when none runs. */
async function detectServe(run: (argv: string[]) => Promise<string>): Promise<Source | undefined> {
  const processes = (await run(["ps", "-axo", "pid=,command="])).split("\n")
  for (const line of processes) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line)
    const program = match ? SERVE.exec(match[2]!) : null
    if (!match || !program) continue
    const pid = match[1]!
    const port = /n(?:127\.0\.0\.1|\[::1\]|localhost):(\d+)/.exec(await run(["lsof", "-nP", "-a", "-p", pid, "-iTCP", "-sTCP:LISTEN", "-Fn"]))?.[1]
    if (!port) continue
    const environment = await run(["ps", "eww", "-p", pid])
    const token = /HERMES_DASHBOARD_SESSION_TOKEN=(\S+)/.exec(environment)?.[1]
    const home = /\bHERMES_HOME=(\S+)/.exec(environment)?.[1]
    // The desktop app that started it, when one did: the `.app` bundle of its parent process ("Open in <app>").
    const parent = (await run(["ps", "-o", "ppid=", "-p", pid])).trim()
    const app = /^\d+$/.test(parent) ? /\/([^/]+)\.app\//.exec(await run(["ps", "-o", "command=", "-p", parent]))?.[1] : undefined
    return { url: `http://127.0.0.1:${port}`, ...(token ? { token } : {}), command: program[1]!, args: ["-m", "hermes_cli.main"], ...(home ? { home } : {}), ...(app ? { app } : {}) }
  }
  return undefined
}

export function hermesConnector({ env = process.env, fetch: request = globalThis.fetch, run = defaultRun, now = Date.now }: HermesDeps & { dir?: string } = {}): BotConnector {
  let source: { at: number; value: Source | undefined } | undefined
  let listed: { at: number; bots: ExternalBotInfo[] } | undefined

  async function resolve(): Promise<Source | undefined> {
    if (source && now() - source.at < SOURCE_TTL_MS) return source.value
    const url = env.MENDCODE_HERMES_URL?.trim()
    const value: Source | undefined = url
      ? { url: url.replace(/\/+$/, ""), ...(env.MENDCODE_HERMES_TOKEN ? { token: env.MENDCODE_HERMES_TOKEN } : {}), command: env.MENDCODE_HERMES_COMMAND?.trim() || "hermes", args: [], ...(env.MENDCODE_HERMES_HOME ? { home: env.MENDCODE_HERMES_HOME } : {}) }
      : await detectServe(run)
    source = { at: now(), value }
    return value
  }

  async function get<T>(from: Source, path: string): Promise<T> {
    const headers = from.token ? { "X-Hermes-Session-Token": from.token } : undefined
    let response: Response
    try {
      response = await request(`${from.url}${path}`, { ...(headers ? { headers } : {}), signal: AbortSignal.timeout(TIMEOUT_MS) })
    } catch {
      source = undefined
      throw new Error(`[HERMES]: Hermes does not answer at ${from.url}; start its app, or set MENDCODE_HERMES_URL`)
    }
    if (response.status === 401 || response.status === 403) {
      source = undefined
      throw new Error(`[HERMES]: Hermes at ${from.url} refused the session token (${response.status}); restart its app, or set MENDCODE_HERMES_TOKEN`)
    }
    if (!response.ok) throw new Error(`[HERMES]: Hermes answered ${response.status} to ${path}`)
    return (await response.json()) as T
  }

  return {
    id: "hermes",
    async list() {
      if (listed && now() - listed.at < LIST_TTL_MS) return listed.bots
      const from = await resolve()
      if (!from) {
        offerConnectorAgents("hermes-", {})
        return []
      }
      const profiles = (await get<{ profiles?: Profile[] }>(from, "/api/profiles")).profiles ?? []
      // Hermes' own rule for "active now" is on its sessions; one that fails only costs the working mark.
      const active = new Set<string>(
        await get<{ sessions?: Array<{ profile?: string; profile_name?: string; is_active?: boolean }> }>(from, `/api/profiles/sessions?limit=${ACTIVE_SESSIONS}`)
          .then((report) => (report.sessions ?? []).filter((session) => session.is_active).map((session) => session.profile ?? session.profile_name ?? ""))
          .catch(() => []),
      )
      const agents: Record<string, AcpAgentConfig> = {}
      const bots = profiles.filter((profile) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,57}$/.test(profile.name ?? "")).map((profile): ExternalBotInfo => {
        const agent = `hermes-${profile.name}`
        agents[agent] = {
          command: from.command,
          args: [...from.args, ...(profile.name === "default" ? [] : ["-p", profile.name]), "acp"],
          ...(from.home ? { env: { HERMES_HOME: from.home } } : {}),
        }
        return {
          origin: "hermes",
          id: profile.name,
          name: (profile.display_name || profile.name).slice(0, 100),
          ...(profile.description ? { description: profile.description.slice(0, 300) } : {}),
          identity: { origin: "hermes" },
          state: active.has(profile.name) ? "working" : "idle",
          ...(profile.model ? { model: profile.model.slice(0, 100) } : {}),
          chat: `acp:${agent}`,
          ...(from.app ? { app: from.app } : {}),
        }
      })
      offerConnectorAgents("hermes-", agents)
      listed = { at: now(), bots }
      return bots
    },
  }
}
