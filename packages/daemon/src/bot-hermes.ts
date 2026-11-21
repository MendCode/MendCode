import type { BotActivityReport, ExternalBotInfo } from "@mendcode/protocol"
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
/** The running sessions listed for one profile (the list shows fewer). */
const ACTIVITY_MAX = 8
const MESSAGES_DEFAULT = 40
const MESSAGES_MAX = 100
const MESSAGE_TEXT_MAX = 4000
const TOOL_TEXT_MAX = 200
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,57}$/
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/
type HermesSession = { id?: string; profile?: string; profile_name?: string; is_active?: boolean; title?: string | null; preview?: string | null; source?: string | null; started_at?: number | null; last_active?: number | null; last_activity_at?: number | null }
type HermesMessage = { role?: string; content?: unknown; tool_name?: string | null; timestamp?: number | null }
/** Hermes keeps times in seconds with a fraction. */
const millis = (seconds: number | null | undefined) => typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : undefined
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

  /** One discovery at a time: the process scan and the two requests to Hermes cost about half a second together. */
  let running: Promise<ExternalBotInfo[]> | undefined
  /** Why the last background discovery failed, told once to the next `list()` so the problem still reaches the report. */
  let failure: unknown

  async function discover(): Promise<ExternalBotInfo[]> {
      const from = await resolve()
      if (!from) {
        offerConnectorAgents("hermes-", {})
        listed = { at: now(), bots: [] }
        return []
      }
      // Both requests go out together; the sessions only give the working mark and what each profile is doing, so a failure of theirs costs only that.
      const activeRequest = get<{ sessions?: HermesSession[] }>(from, `/api/profiles/sessions?limit=${ACTIVE_SESSIONS}`)
        .then((report) => (report.sessions ?? []).filter((session) => session.is_active))
        .catch(() => [] as HermesSession[])
      const profiles = (await get<{ profiles?: Profile[] }>(from, "/api/profiles")).profiles ?? []
      // Hermes' own rule for "active now" is on its sessions: a profile with one works, and its newest ones say on what.
      const activity = new Map<string, NonNullable<ExternalBotInfo["activity"]>>()
      for (const session of await activeRequest) {
        const profile = session.profile ?? session.profile_name ?? ""
        const listed = activity.get(profile) ?? []
        activity.set(profile, listed)
        if (typeof session.id !== "string" || !SESSION_ID.test(session.id)) continue
        const title = (session.title || session.preview || "").replace(/\s+/g, " ").trim().slice(0, 200)
        const startedAt = millis(session.started_at)
        const activeAt = millis(session.last_active ?? session.last_activity_at)
        listed.push({ id: session.id, ...(title ? { title } : {}), ...(typeof session.source === "string" && session.source ? { source: session.source.slice(0, 64) } : {}), ...(startedAt !== undefined ? { startedAt } : {}), ...(activeAt !== undefined ? { activeAt } : {}) })
      }
      const active = new Set<string>(activity.keys())
      const agents: Record<string, AcpAgentConfig> = {}
      const bots = profiles.filter((profile) => PROFILE_NAME.test(profile.name ?? "")).map((profile): ExternalBotInfo => {
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
          ...(activity.get(profile.name)?.length ? { activity: activity.get(profile.name)!.sort((a, b) => (b.activeAt ?? b.startedAt ?? 0) - (a.activeAt ?? a.startedAt ?? 0)).slice(0, ACTIVITY_MAX) } : {}),
        }
      })
      offerConnectorAgents("hermes-", agents)
      listed = { at: now(), bots }
      return bots
  }

  const refresh = () => (running ??= discover().finally(() => { running = undefined }))

  return {
    id: "hermes",
    /**
     * The newest messages of one of a profile's own Hermes sessions, oldest first, to read: what it was asked, what it answered and
     * which tools it ran. Read from Hermes when asked for and never kept; nothing is written to Hermes.
     */
    async session({ bot, session, limit = MESSAGES_DEFAULT }) {
      if (!PROFILE_NAME.test(bot) || !SESSION_ID.test(session)) throw new Error("[HERMES]: that is not a Hermes session")
      const from = await resolve()
      if (!from) throw new Error("[HERMES]: Hermes is not running; start its app, or set MENDCODE_HERMES_URL")
      const asked = Math.max(1, Math.min(MESSAGES_MAX, Math.floor(limit)))
      const report = await get<{ messages?: HermesMessage[] }>(from, `/api/sessions/${encodeURIComponent(session)}/messages?profile=${encodeURIComponent(bot)}&limit=${asked}&order=latest`)
      const messages: BotActivityReport["messages"] = []
      for (const message of report.messages ?? []) {
        const role = message.role === "user" || message.role === "assistant" || message.role === "tool" ? message.role : undefined
        const text = typeof message.content === "string" ? message.content.trim() : ""
        if (!role || (!text && role !== "tool")) continue
        const at = millis(message.timestamp)
        // A tool's result is its name and a short start of what it answered; a message is kept up to a readable length.
        messages.push({ role, text: text.slice(0, role === "tool" ? TOOL_TEXT_MAX : MESSAGE_TEXT_MAX), ...(role === "tool" && typeof message.tool_name === "string" && message.tool_name ? { tool: message.tool_name.slice(0, 100) } : {}), ...(at !== undefined ? { at } : {}) })
      }
      return { messages, more: (report.messages ?? []).length >= asked }
    },
    /**
     * Never makes the caller wait for Hermes once it has answered before: the last answer is returned at once and, when it is older
     * than `LIST_TTL_MS`, one discovery runs in the background for the next list. Only the first list (nothing known yet) waits.
     */
    async list() {
      if (listed) {
        if (now() - listed.at >= LIST_TTL_MS && !running) refresh().catch((error) => { listed = undefined; failure = error })
        return listed.bots
      }
      if (failure !== undefined) {
        const error = failure
        failure = undefined
        throw error
      }
      return refresh()
    },
  }
}
