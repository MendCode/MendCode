import { redactSecrets, type BotActivityReport, type ExternalBotInfo } from "@mendcode/protocol"
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
 * stores, logs or sends it anywhere but that loopback address. With no such server (the app works against a server elsewhere), a running
 * Hermes gateway or `MENDCODE_HERMES_HOME` alone gives the home folder, and the profiles and their sessions are read from it read-only
 * (`bot-hermes-disk.ts`). A refresh that fails keeps the last bots, marked stale. Loaded by the first `bot.list` with the flag on.
 */

export type HermesDeps = {
  env?: Readonly<Record<string, string | undefined>>
  fetch?: typeof fetch
  /** Runs a program with an argument array and answers its stdout ("" on any failure). */
  run?(argv: string[]): Promise<string>
  now?(): number
}

/** Where Hermes answers: its server (`url`), or, with `disk`, only its own folder (`home`) read in place. */
type Source = { url: string; token?: string; command: string; args: string[]; home?: string; app?: string; disk?: boolean }
type Profile = { name: string; path?: string; model?: string; display_name?: string; description?: string }

const SOURCE_TTL_MS = 30_000
const LIST_TTL_MS = 8_000
const TIMEOUT_MS = 4_000
/** A profile with a session Hermes calls active is working. */
const ACTIVE_SESSIONS = 50
/** The running sessions listed for one profile (the list shows fewer). */
const ACTIVITY_MAX = 8
/** The finished sessions listed for one profile, and how many of the root profile's newest are asked for. */
const RECENT_MAX = 30
/** Hermes' root profile: the one the user's own assistant lives in. */
const ROOT_PROFILE = "default"
const newest = (a: { activeAt?: number | undefined; startedAt?: number | undefined }, b: { activeAt?: number | undefined; startedAt?: number | undefined }) => (b.activeAt ?? b.startedAt ?? 0) - (a.activeAt ?? a.startedAt ?? 0)
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
/** Hermes' gateway (its chat platforms and schedules): it runs where the profiles live even when no `serve` does. */
const GATEWAY = /^(.*?) -m hermes_cli\.main gateway\b/

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

/**
 * The `hermes serve` the user's app runs: its address, token and the program that starts a chat. Without one (the app works against a
 * server elsewhere, or only the gateway runs), a running Hermes gateway gives the program and the home folder, read from disk.
 * Undefined when neither runs.
 */
async function detectServe(run: (argv: string[]) => Promise<string>, home: string | undefined): Promise<Source | undefined> {
  const processes = (await run(["ps", "-axo", "pid=,command="])).split("\n")
  const served = await detectRunning(run, processes)
  if (served) return served
  for (const line of processes) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line)
    const program = match ? GATEWAY.exec(match[2]!) : null
    // A wrapper that starts the gateway (`python -m <logger> -- python -m hermes_cli.main gateway`) is not the program itself.
    if (!match || !program || / -m /.test(program[1]!)) continue
    const folder = /\bHERMES_HOME=(\S+)/.exec(await run(["ps", "eww", "-p", match[1]!]))?.[1] ?? (home ? `${home}/.hermes` : undefined)
    if (folder) return { url: "", command: program[1]!, args: ["-m", "hermes_cli.main"], home: folder, disk: true }
  }
  return undefined
}

async function detectRunning(run: (argv: string[]) => Promise<string>, processes: readonly string[]): Promise<Source | undefined> {
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
    const home = env.MENDCODE_HERMES_HOME?.trim()
    const command = env.MENDCODE_HERMES_COMMAND?.trim() || "hermes"
    // A home without an address is read from disk, unless the app's own server runs on this machine (it knows more: what runs now).
    const value: Source | undefined = url
      ? { url: url.replace(/\/+$/, ""), ...(env.MENDCODE_HERMES_TOKEN ? { token: env.MENDCODE_HERMES_TOKEN } : {}), command, args: [], ...(home ? { home } : {}) }
      : home
        ? (await detectServe(run, env.HOME).then((found) => found && !found.disk ? found : undefined)) ?? { url: "", command, args: [], home, disk: true }
        : await detectServe(run, env.HOME)
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

  /** The profiles and their newest sessions, from Hermes' server or, with a disk source, from its folder. */
  async function readHermes(from: Source): Promise<{ profiles: Profile[]; sessions: HermesSession[] }> {
    if (from.disk && from.home) {
      const disk = await import("./bot-hermes-disk")
      const profiles = disk.diskProfiles(from.home)
      return { profiles, sessions: disk.diskSessions(from.home, profiles.map((profile) => profile.name), RECENT_MAX, now() / 1000) }
    }
    // Both requests go out together; the sessions only give the working mark and what each profile is doing, so a failure of theirs costs only that.
    // The root profile (the user's own assistant) is asked for its own newest sessions too: across all profiles, other bots' runs push its chats out of the newest 50.
    const listOf = (query: string) => get<{ sessions?: HermesSession[] }>(from, `/api/profiles/sessions?${query}`).then((report) => report.sessions ?? []).catch(() => [] as HermesSession[])
    const activeRequest = Promise.all([listOf(`limit=${ACTIVE_SESSIONS}`), listOf(`profile=${ROOT_PROFILE}&limit=${RECENT_MAX}`)])
      .then(([all, root]) => [...all, ...root.filter((session) => !all.some((known) => known.id !== undefined && known.id === session.id))])
    const profiles = (await get<{ profiles?: Profile[] }>(from, "/api/profiles")).profiles ?? []
    return { profiles, sessions: await activeRequest }
  }

  /** One discovery at a time: the process scan and the two requests to Hermes cost about half a second together. */
  let running: Promise<ExternalBotInfo[]> | undefined
  /** Why the last background discovery failed, told once to the next `list()` so the problem still reaches the report. */
  let failure: unknown

  async function discover(): Promise<ExternalBotInfo[]> {
      const from = await resolve()
      if (!from) {
        // Hermes was found before and is gone now (its app quit, or moved elsewhere): its bots stay, marked stale, so their chats still open.
        if (listed?.bots.length) return keepStale()
        offerConnectorAgents("hermes-", {})
        listed = { at: now(), bots: [] }
        return []
      }
      const { profiles, sessions } = await readHermes(from)
      // Hermes' own rule for "active now" is on its sessions: a profile with one works, and its newest ones say on what.
      const activity = new Map<string, NonNullable<ExternalBotInfo["activity"]>>()
      const finished = new Map<string, NonNullable<ExternalBotInfo["recent"]>>()
      for (const session of sessions) {
        const profile = session.profile ?? session.profile_name ?? ""
        const running = session.is_active === true
        const listed = (running ? activity : finished).get(profile) ?? []
        ;(running ? activity : finished).set(profile, listed)
        if (typeof session.id !== "string" || !SESSION_ID.test(session.id)) continue
        // A session with no title of its own reads as what it was asked first, never as a blank row.
        // What it was asked can hold a credential: the row is redacted first, as the messages of the chat are, and cut afterwards.
        const title = redactSecrets(session.title || session.preview || "").text.replace(/\s+/g, " ").trim().slice(0, 200)
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
          ...(activity.get(profile.name)?.length ? { activity: activity.get(profile.name)!.sort(newest).slice(0, ACTIVITY_MAX) } : {}),
          ...(finished.get(profile.name)?.length ? { recent: finished.get(profile.name)!.sort(newest).slice(0, RECENT_MAX) } : {}),
        }
      })
      offerConnectorAgents("hermes-", agents)
      listed = { at: now(), bots }
      return bots
  }

  const refresh = () => (running ??= discover().finally(() => { running = undefined }))

  /**
   * The last bots Hermes gave, kept when a refresh fails or Hermes is no longer found: marked stale, idle and without the running sessions
   * (those can no longer be known), and their chat agents stay offered so a chat with them still opens. The next refresh replaces them.
   */
  function keepStale(): ExternalBotInfo[] {
    const bots = (listed?.bots ?? []).map(({ activity: _activity, ...bot }): ExternalBotInfo => ({ ...bot, state: "idle", stale: true }))
    listed = { at: now(), bots }
    return bots
  }

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
      const report: { messages?: HermesMessage[] } = from.disk && from.home
        ? { messages: (await import("./bot-hermes-disk")).diskMessages(from.home, bot, session, asked) }
        : await get<{ messages?: HermesMessage[] }>(from, `/api/sessions/${encodeURIComponent(session)}/messages?profile=${encodeURIComponent(bot)}&limit=${asked}&order=latest`)
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
        // A refresh that fails keeps what was known (stale); with nothing known, the next list reports why.
        if (now() - listed.at >= LIST_TTL_MS && !running) refresh().catch((error) => { if (listed?.bots.length) keepStale(); else { listed = undefined; failure = error } })
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
