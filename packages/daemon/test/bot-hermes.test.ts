import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BotListReport, createIdFactory } from "@mendcode/protocol"
import type { EngineEvent, TurnInput } from "@mendcode/kernel"
import { createAcpAgents, createAcpEngine } from "../../engine-acp/src"
import { connectorAgents, lazyHermesConnector, offerConnectorAgents } from "../src/bot-connector-agents"
import { hermesConnector } from "../src/bot-hermes"
import { listBots, type BotConnector } from "../src/bot-service"
import { boot } from "./native-harness"

const TOKEN = "fake-session-token-for-tests"
const ids = createIdFactory()
const temps: string[] = []
const servers: Array<{ stop(force?: boolean): void }> = []
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
  offerConnectorAgents("hermes-", {})
})
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "bot-hermes-")); temps.push(dir); return dir }

const PROFILES = {
  profiles: [
    { name: "default", model: "gpt-x", display_name: "Chief", description: "Runs the house" },
    { name: "ada", model: "gpt-y", display_name: "Ada", description: "Embedded AI lead" },
    { name: "bad name", model: "z" },
  ],
}

/** A Hermes that checks the session token header like `hermes serve`, with one profile busy. */
function fakeHermes({ token = TOKEN, status }: { token?: string; status?: number } = {}) {
  const seen: string[] = []
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(request) {
      const url = new URL(request.url)
      seen.push(url.pathname)
      if (status) return new Response("no", { status })
      if (request.headers.get("x-hermes-session-token") !== token) return new Response("unauthorized", { status: 401 })
      if (url.pathname === "/api/profiles") return Response.json(PROFILES)
      if (url.pathname === "/api/profiles/sessions") return Response.json({ sessions: [{ profile: "ada", is_active: true }, { profile: "default", is_active: false }] })
      return new Response("not found", { status: 404 })
    },
  })
  servers.push(server)
  return { url: `http://127.0.0.1:${server.port}`, seen }
}

describe("the Hermes connector lists the profiles as bots", () => {
  test("every profile becomes an external bot with its model, state and the model id that chats with it", async () => {
    const hermes = fakeHermes()
    const connector = hermesConnector({ env: { MENDCODE_HERMES_URL: hermes.url, MENDCODE_HERMES_TOKEN: TOKEN } })
    const bots = await connector.list()
    expect(bots.map((bot) => [bot.id, bot.name, bot.state, bot.model, bot.chat])).toEqual([
      ["default", "Chief", "idle", "gpt-x", "acp:hermes-default"],
      ["ada", "Ada", "working", "gpt-y", "acp:hermes-ada"],
    ])
    expect(BotListReport.safeParse({ bots: [], external: bots, problems: [] }).success).toBe(true)
    expect(bots.every((bot) => bot.origin === "hermes" && bot.identity?.origin === "hermes")).toBe(true)
  })

  test("a profile's chat is `hermes -p <profile> acp` with the app's home, and the default profile takes no -p", async () => {
    const hermes = fakeHermes()
    await hermesConnector({ env: { MENDCODE_HERMES_URL: hermes.url, MENDCODE_HERMES_TOKEN: TOKEN, MENDCODE_HERMES_COMMAND: "/opt/hermes", MENDCODE_HERMES_HOME: "/h" } }).list()
    expect(connectorAgents()).toEqual({
      "hermes-default": { command: "/opt/hermes", args: ["acp"], env: { HERMES_HOME: "/h" } },
      "hermes-ada": { command: "/opt/hermes", args: ["-p", "ada", "acp"], env: { HERMES_HOME: "/h" } },
    })
    // The ACP registry takes them as models without any acp-agents.json.
    const agents = createAcpAgents({ dir: temp(), extra: connectorAgents })
    expect(agents.models().map((model) => model.id)).toEqual(["acp:hermes-default", "acp:hermes-ada"])
    expect(agents.agentOf("acp:hermes-ada")).toBe("hermes-ada")
  })

  test("the app's own server is found in the process list, with its port and token read at the call and never kept in the bot", async () => {
    const hermes = fakeHermes()
    const port = hermes.url.split(":").pop()!
    const calls: string[][] = []
    const run = async (argv: string[]) => {
      calls.push(argv)
      if (argv[0] === "ps" && argv[1] === "-axo") return "  12 /bin/zsh\n  4242 /Users/me/.desk-agent/desk-agent/venv/bin/python -m hermes_cli.main serve --host 127.0.0.1 --port 0\n"
      if (argv[0] === "lsof") return `p4242\nn127.0.0.1:${port}\n`
      if (argv[0] === "ps" && argv[2] === "ppid=") return "  100\n"
      if (argv[0] === "ps" && argv[2] === "command=") return "/Applications/Desk Agent.app/Contents/MacOS/Desk Agent\n"
      return `4242 python -m hermes_cli.main serve HERMES_HOME=/Users/me/.desk-agent HERMES_DASHBOARD_SESSION_TOKEN=${TOKEN} OTHER=1`
    }
    const connector = hermesConnector({ env: {}, run })
    const bots = await connector.list()
    expect(bots.map((bot) => bot.id)).toEqual(["default", "ada"])
    expect(bots[0]!.app).toBe("Desk Agent")
    expect(JSON.stringify(bots)).not.toContain(TOKEN)
    expect(connectorAgents()["hermes-ada"]).toEqual({ command: "/Users/me/.desk-agent/desk-agent/venv/bin/python", args: ["-m", "hermes_cli.main", "-p", "ada", "acp"], env: { HERMES_HOME: "/Users/me/.desk-agent" } })
    // A second list inside the window asks nothing again.
    const asked = calls.length
    await connector.list()
    expect(calls.length).toBe(asked)
  })

  test("no Hermes configured or running is an empty list and no agents, not an error", async () => {
    expect(await hermesConnector({ env: {}, run: async () => "" }).list()).toEqual([])
    expect(connectorAgents()).toEqual({})
  })

  test("a refused token is a clear problem under connector:hermes and never prints the token", async () => {
    const hermes = fakeHermes({ token: "something-else" })
    const connector = hermesConnector({ env: { MENDCODE_HERMES_URL: hermes.url, MENDCODE_HERMES_TOKEN: TOKEN } })
    const dir = temp()
    const report = await listBots({ dir, agents: () => ({ directory: dir, agents: [], problems: [] }), sessions: () => [], connectors: () => [connector] })
    expect(report.external).toEqual([])
    expect(report.problems).toHaveLength(1)
    expect(report.problems[0]!.file).toBe("connector:hermes")
    expect(report.problems[0]!.message).toContain("refused the session token (401)")
    expect(report.problems[0]!.message).not.toContain(TOKEN)
  })

  test("an app that is not running says so", async () => {
    const connector = hermesConnector({ env: { MENDCODE_HERMES_URL: "http://127.0.0.1:9" } })
    await expect(connector.list()).rejects.toThrow("[HERMES]: Hermes does not answer at http://127.0.0.1:9")
  })

  test("a later list answers from what it knew at once and refreshes in the background; it never waits for Hermes", async () => {
    let clock = 0
    let slow = false
    let requests = 0
    const release: Array<() => void> = []
    const fetcher = (async (url: string) => {
      requests++
      if (slow) await new Promise<void>((resolve) => release.push(resolve))
      return Response.json(url.includes("/sessions") ? { sessions: [] } : { profiles: [{ name: slow ? "later" : "first" }] })
    }) as unknown as typeof fetch
    const connector = hermesConnector({ env: { MENDCODE_HERMES_URL: "http://hermes.test" }, fetch: fetcher, now: () => clock })
    expect((await connector.list()).map((bot) => bot.id)).toEqual(["first"])
    slow = true
    clock = 60_000
    const before = requests
    const started = performance.now()
    expect((await connector.list()).map((bot) => bot.id)).toEqual(["first"])
    expect(performance.now() - started).toBeLessThan(50)
    // One refresh at a time, however many lists come while it runs.
    await connector.list()
    await connector.list()
    await Promise.resolve()
    expect(requests - before).toBe(3)
    release.splice(0).forEach((resolve) => resolve())
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect((await connector.list()).map((bot) => bot.id)).toEqual(["later"])
  })

  test("a background refresh that fails keeps the bots it knew, marked stale and idle, with their chat agents; the next good one clears the mark", async () => {
    let clock = 0
    let down = false
    const fetcher = (async (url: string) => {
      if (down) throw new Error("refused")
      return Response.json(url.includes("/sessions") ? { sessions: [{ id: "s1", profile: "ada", is_active: true }] } : { profiles: [{ name: "ada" }] })
    }) as unknown as typeof fetch
    const connector = hermesConnector({ env: { MENDCODE_HERMES_URL: "http://hermes.test" }, fetch: fetcher, now: () => clock })
    expect((await connector.list()).map((bot) => [bot.id, bot.state])).toEqual([["ada", "working"]])
    down = true
    clock = 60_000
    expect((await connector.list()).map((bot) => bot.id)).toEqual(["ada"])
    await new Promise((resolve) => setTimeout(resolve, 10))
    const kept = await connector.list()
    expect(kept.map((bot) => [bot.id, bot.state, bot.stale, bot.activity])).toEqual([["ada", "idle", true, undefined]])
    expect(BotListReport.safeParse({ bots: [], external: kept, problems: [] }).success).toBe(true)
    expect(Object.keys(connectorAgents())).toEqual(["hermes-ada"])
    down = false
    clock = 120_000
    await connector.list()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect((await connector.list()).map((bot) => [bot.id, bot.stale])).toEqual([["ada", undefined]])
  })

  test("a refresh that fails before anything was known is reported once, and the list after it asks again", async () => {
    let clock = 0
    let down = false
    const fetcher = (async (url: string) => {
      if (down) throw new Error("refused")
      return Response.json(url.includes("/sessions") ? { sessions: [] } : { profiles: [] })
    }) as unknown as typeof fetch
    const connector = hermesConnector({ env: { MENDCODE_HERMES_URL: "http://hermes.test" }, fetch: fetcher, now: () => clock })
    expect(await connector.list()).toEqual([])
    down = true
    clock = 60_000
    await connector.list()
    await new Promise((resolve) => setTimeout(resolve, 10))
    await expect(connector.list()).rejects.toThrow("[HERMES]: Hermes does not answer")
    down = false
    expect(await connector.list()).toEqual([])
  })

  test("Hermes that is no longer found keeps the bots it listed, stale, so their chats still open", async () => {
    let clock = 0
    let running = true
    const port = fakeHermes().url.split(":").pop()!
    const run = async (argv: string[]) => {
      if (!running) return ""
      if (argv[0] === "ps" && argv[1] === "-axo") return "  4242 /opt/py -m hermes_cli.main serve --port 0\n"
      if (argv[0] === "lsof") return `p4242\nn127.0.0.1:${port}\n`
      if (argv[0] === "ps" && argv[1] === "eww") return `4242 python HERMES_DASHBOARD_SESSION_TOKEN=${TOKEN}`
      return ""
    }
    const connector = hermesConnector({ env: {}, run, now: () => clock })
    expect((await connector.list()).map((bot) => bot.id)).toEqual(["default", "ada"])
    running = false
    clock = 60_000
    await connector.list()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect((await connector.list()).map((bot) => [bot.id, bot.stale])).toEqual([["default", true], ["ada", true]])
    expect(Object.keys(connectorAgents()).sort()).toEqual(["hermes-ada", "hermes-default"])
  })

  test("the profiles and the active sessions are requested together", async () => {
    const order: string[] = []
    const fetcher = (async (url: string) => {
      order.push(`start ${url.includes("/sessions") ? "sessions" : "profiles"}`)
      await new Promise((resolve) => setTimeout(resolve, 20))
      return Response.json(url.includes("/sessions") ? { sessions: [] } : { profiles: [] })
    }) as unknown as typeof fetch
    await hermesConnector({ env: { MENDCODE_HERMES_URL: "http://hermes.test" }, fetch: fetcher }).list()
    expect(order).toEqual(["start sessions", "start sessions", "start profiles"])
  })
})

describe("a chat with a Hermes bot", () => {
  test("a turn on the bot's model reaches the profile's ACP process and its reply comes back", async () => {
    const hermes = fakeHermes()
    const dir = temp()
    // `hermes` stands in as a script that ignores `-p <profile> acp` and speaks the protocol like the ACP test fixture.
    const program = join(dir, "hermes")
    writeFileSync(program, `#!/bin/sh\nexec ${process.execPath} ${join(import.meta.dir, "../../engine-acp/test/fake-agent.ts")}\n`)
    chmodSync(program, 0o755)
    await hermesConnector({ env: { MENDCODE_HERMES_URL: hermes.url, MENDCODE_HERMES_TOKEN: TOKEN, MENDCODE_HERMES_COMMAND: program } }).list()
    const agents = createAcpAgents({ dir, extra: connectorAgents })
    const bindings = new Map<string, string>()
    const engine = createAcpEngine({
      agents,
      agentFor: () => agents.agentOf("acp:hermes-ada"),
      cwdFor: () => dir,
      bindings: { get: (sessionId, agent) => bindings.get(`${sessionId}/${agent}`), set: (sessionId, agent, id) => void bindings.set(`${sessionId}/${agent}`, id) },
      readBlob: async () => new Uint8Array(),
    })
    try {
      const events: EngineEvent[] = []
      const input: TurnInput = { sessionId: ids("session"), turnId: ids("turn"), text: "hola, ¿me oyes desde MendCode?", attachments: [], signal: new AbortController().signal, newItemId: () => ids("item"), emit: (event) => void events.push(event), ask: async () => ({ kind: "abandoned" }), permissionMode: () => "ask", setPermissionMode: () => undefined }
      const outcome = await engine.runTurn(input)
      expect(outcome.status).toBe("ok")
      expect(events.some((event) => event.type === "item.completed" && "text" in event && String(event.text).length > 0)).toBe(true)
    } finally {
      engine.stop()
    }
  })
})

describe("what a working profile is doing", () => {
  /** A Hermes with two live sessions of one profile, one finished one, and the messages of the first. */
  function busyHermes() {
    const asked: Array<{ path: string; query: string; token: string | null }> = []
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        const url = new URL(request.url)
        asked.push({ path: url.pathname, query: url.search, token: request.headers.get("x-hermes-session-token") })
        if (request.headers.get("x-hermes-session-token") !== TOKEN) return new Response("unauthorized", { status: 401 })
        if (url.pathname === "/api/profiles") return Response.json(PROFILES)
        if (url.pathname === "/api/profiles/sessions") return Response.json({ sessions: [
          { id: "s-old", profile: "ada", is_active: true, title: "Older run", source: "cron", started_at: 1_700_000_000, last_active: 1_700_000_100 },
          { id: "s-new", profile: "ada", is_active: true, title: null, preview: "Flash the board", source: "telegram", started_at: 1_700_000_200, last_activity_at: 1_700_000_300.5 },
          { id: "s-done", profile: "ada", is_active: false, title: "Finished" },
          { id: "s-titleless", profile: "ada", is_active: false, title: null, preview: "  First   question\nhere ", source: "desktop", started_at: 1_700_000_050, last_active: 1_700_000_060 },
          { id: "bad id", profile: "ada", is_active: true, title: "Odd" },
        ] })
        if (url.pathname === "/api/sessions/s-new/messages") return Response.json({ session_id: "s-new", messages: [
          { id: 1, role: "user", content: "Flash the board", timestamp: 1_700_000_200 },
          { id: 2, role: "assistant", content: "", tool_calls: [{ function: { name: "terminal" } }], timestamp: 1_700_000_210 },
          { id: 3, role: "tool", tool_name: "terminal", content: "ok", timestamp: 1_700_000_220 },
          { id: 4, role: "assistant", content: "Flashed.", timestamp: 1_700_000_230 },
          { id: 5, role: "system", content: "hidden" },
        ], pagination: { total: 9 } })
        return new Response("not found", { status: 404 })
      },
    })
    servers.push(server)
    return { env: { MENDCODE_HERMES_URL: `http://127.0.0.1:${server.port}`, MENDCODE_HERMES_TOKEN: TOKEN }, asked }
  }

  test("the list carries the profile's live sessions, newest first, in milliseconds, and its finished ones apart with a title read from the first question", async () => {
    const hermes = busyHermes()
    const bots = await hermesConnector({ env: hermes.env }).list()
    const ada = bots.find((bot) => bot.id === "ada")!
    expect(ada.state).toBe("working")
    expect(ada.activity).toEqual([
      { id: "s-new", title: "Flash the board", source: "telegram", startedAt: 1_700_000_200_000, activeAt: 1_700_000_300_500 },
      { id: "s-old", title: "Older run", source: "cron", startedAt: 1_700_000_000_000, activeAt: 1_700_000_100_000 },
    ])
    expect(ada.recent).toEqual([
      { id: "s-titleless", title: "First question here", source: "desktop", startedAt: 1_700_000_050_000, activeAt: 1_700_000_060_000 },
      { id: "s-done", title: "Finished" },
    ])
    expect(bots.find((bot) => bot.id === "default")!.activity).toBeUndefined()
    // The root profile's own newest sessions are asked for apart, so other bots' runs cannot push them out of the shared list.
    expect(hermes.asked.some((entry) => entry.query.includes("profile=default"))).toBe(true)
    expect(BotListReport.safeParse({ bots: [], external: bots, problems: [] }).success).toBe(true)
  })

  test("a title read from the first question never carries a credential", async () => {
    const secret = `sk-ant-api03-${"x".repeat(80)}`
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === "/api/profiles") return Response.json(PROFILES)
        if (url.pathname === "/api/profiles/sessions") return Response.json({ sessions: [{ id: "s-key", profile: "ada", is_active: false, title: null, preview: `Use ANTHROPIC_API_KEY=${secret} to deploy` }] })
        return new Response("not found", { status: 404 })
      },
    })
    servers.push(server)
    const bots = await hermesConnector({ env: { MENDCODE_HERMES_URL: `http://127.0.0.1:${server.port}`, MENDCODE_HERMES_TOKEN: TOKEN } }).list()
    const title = bots.find((bot) => bot.id === "ada")!.recent![0]!.title!
    expect(title).not.toContain(secret)
    expect(title).toContain("to deploy")
  })

  test("a session's messages are read with the same token header: who said what, the tool named, nothing of the system", async () => {
    const hermes = busyHermes()
    const connector = hermesConnector({ env: hermes.env })
    const report = await connector.session!({ bot: "ada", session: "s-new", limit: 4 })
    expect(report.messages.map((message) => [message.role, message.text, message.tool])).toEqual([
      ["user", "Flash the board", undefined],
      // The assistant's turn that only called a tool has no words: the tool's own row tells it.
      ["tool", "ok", "terminal"],
      ["assistant", "Flashed.", undefined],
    ])
    expect(report.messages[0]!.at).toBe(1_700_000_200_000)
    expect(report.more).toBe(true)
    const call = hermes.asked.find((entry) => entry.path === "/api/sessions/s-new/messages")!
    expect(call.token).toBe(TOKEN)
    expect(call.query).toContain("profile=ada")
    expect(call.query).toContain("order=latest")
    expect(call.query).not.toContain(TOKEN)
    expect(JSON.stringify(report)).not.toContain(TOKEN)
  })

  test("an id that is no session id never reaches Hermes, and a session Hermes does not know is an error without the token", async () => {
    const hermes = busyHermes()
    const connector = hermesConnector({ env: hermes.env })
    const before = hermes.asked.length
    await expect(connector.session!({ bot: "ada", session: "../profiles" })).rejects.toThrow("not a Hermes session")
    await expect(connector.session!({ bot: "bad name", session: "s-new" })).rejects.toThrow("not a Hermes session")
    expect(hermes.asked.length).toBe(before)
    const failure = await connector.session!({ bot: "ada", session: "s-missing" }).then(() => "", (error: Error) => error.message)
    expect(failure).not.toBe("")
    expect(failure).not.toContain(TOKEN)
  })

  test("bot.activity answers through the daemon with the bots flag on, and is refused for a connector that cannot be read", async () => {
    const readable: BotConnector = { id: "hermes", list: async () => [], session: async ({ bot, session }) => ({ messages: [{ role: "assistant", text: `${bot}/${session} token sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` }], more: false }) }
    const h = await boot({ botConnectors: [readable, { id: "mute", list: async () => [] }] })
    try {
      expect((await h.client.send({ type: "bot.activity", origin: "hermes", bot: "ada", session: "s-new" })).ok).toBe(false)
      await h.client.send({ type: "settings.set", patch: { experimental: { bots: true } } })
      const reply = await h.client.send({ type: "bot.activity", origin: "hermes", bot: "ada", session: "s-new" })
      expect(reply.ok).toBe(true)
      const text = (reply as unknown as { result: { messages: Array<{ text: string }> } }).result.messages[0]!.text
      expect(text).toContain("ada/s-new")
      expect(text).not.toContain("sk-ant-api03")
      expect((await h.client.send({ type: "bot.activity", origin: "mute", bot: "ada", session: "s-new" })).ok).toBe(false)
      // Reading what a bot does makes no session.
      const sessions = await h.client.send({ type: "session.list" })
      expect((sessions as unknown as { result: { sessions: unknown[] } }).result.sessions).toHaveLength(0)
    } finally {
      await h.cleanup()
    }
  })
})

describe("nothing loads with the flag off", () => {
  test("bot.list is refused and never asks the connector; with the flag on it carries what the connector lists", async () => {
    let asked = 0
    const connector: BotConnector = { id: "hermes", list: async () => { asked++; return [{ origin: "hermes", id: "ada", name: "Ada", state: "idle", chat: "acp:hermes-ada" }] } }
    const h = await boot({ botConnectors: [connector] })
    try {
      const off = await h.client.send({ type: "bot.list" })
      expect(off.ok).toBe(false)
      expect(asked).toBe(0)
      await h.client.send({ type: "settings.set", patch: { experimental: { bots: true } } })
      const on = await h.client.send({ type: "bot.list" })
      expect(on.ok).toBe(true)
      expect(BotListReport.parse((on as { result: unknown }).result).external.map((bot) => bot.id)).toEqual(["ada"])
      expect(asked).toBe(1)
    } finally {
      await h.cleanup()
    }
  })

  test("the stub the daemon holds offers no agents until it is listed", () => {
    expect(connectorAgents()).toEqual({})
    expect(lazyHermesConnector({ dir: temp() }).id).toBe("hermes")
    expect(connectorAgents()).toEqual({})
  })
})

describe("Hermes read from its folder when no server of it runs here", () => {
  /** A Hermes home like the app keeps: the root profile and a named one, each with its own sessions database. */
  function hermesHome() {
    const home = temp()
    const seconds = 1_800_000_000
    const write = (dir: string, files: Record<string, string>, sessions: Array<{ id: string; title: string | null; started: number; last: number | null; ended: number | null; messages: number; hidden?: number }>) => {
      mkdirSync(dir, { recursive: true })
      for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
      const db = new Database(join(dir, "state.db"))
      db.run("create table sessions (id text primary key, source text, title text, started_at real, ended_at real, last_activity_at real, message_count integer, hidden integer, archived integer, profile_name text)")
      db.run("create table messages (id integer primary key autoincrement, session_id text, role text, content text, tool_name text, timestamp real)")
      for (const session of sessions) db.query("insert into sessions values (?, 'cli', ?, ?, ?, ?, ?, ?, 0, null)").run(session.id, session.title, session.started, session.ended, session.last, session.messages, session.hidden ?? 0)
      const message = db.query("insert into messages (session_id, role, content, tool_name, timestamp) values (?, ?, ?, ?, ?)")
      message.run("a-1", "user", "first question", null, seconds + 1)
      message.run("a-1", "tool", "{\"ok\": true}", "search", seconds + 2)
      message.run("a-1", "assistant", "the answer", null, seconds + 3)
      db.close()
    }
    write(home, { "profile.yaml": "ui_meta:\n  app-bots:\n    title: Chief\n    pinned: true\n", "config.yaml": "model:\n  default: gpt-root\n  provider: x\n" }, [{ id: "root-1", title: "Plan the week", started: seconds, last: seconds + 50, ended: seconds + 60, messages: 4 }])
    write(join(home, "profiles", "ada"), { "profile.yaml": "description: Embedded AI lead\ndisplay_name: 'Ada'\n", "config.yaml": "model: gpt-ada\n" }, [
      { id: "a-1", title: "Board bring-up", started: seconds, last: seconds + 100, ended: null, messages: 3 },
      { id: "a-2", title: null, started: seconds - 10, last: null, ended: seconds, messages: 0 },
      { id: "a-3", title: "Hidden one", started: seconds - 5, last: null, ended: seconds, messages: 2, hidden: 1 },
    ])
    mkdirSync(join(home, "profiles", "bad name"), { recursive: true })
    return { home, now: () => (seconds + 120) * 1000 }
  }

  test("a running gateway gives the program and the home: the profiles become bots with their names, models and newest sessions", async () => {
    const { home, now } = hermesHome()
    const run = async (argv: string[]) => {
      if (argv[0] === "ps" && argv[1] === "-axo") return "  10 /opt/py -m hermes_cli.stderr_timestamp --log x -- /opt/py -m hermes_cli.main gateway run\n  11 /opt/py -m hermes_cli.main gateway run --replace\n"
      if (argv[0] === "ps" && argv[1] === "eww" && argv[3] === "11") return `11 /opt/py -m hermes_cli.main gateway run HERMES_HOME=${home} OTHER=1`
      return ""
    }
    const connector = hermesConnector({ env: {}, run, now })
    const bots = await connector.list()
    expect(bots.map((bot) => [bot.id, bot.name, bot.model, bot.description, bot.state, bot.chat])).toEqual([
      ["default", "Chief", "gpt-root", undefined, "idle", "acp:hermes-default"],
      ["ada", "Ada", "gpt-ada", "Embedded AI lead", "working", "acp:hermes-ada"],
    ])
    expect(bots[1]!.activity?.map((session) => [session.id, session.title])).toEqual([["a-1", "Board bring-up"]])
    expect(bots[0]!.recent?.map((session) => [session.id, session.title, session.activeAt])).toEqual([["root-1", "Plan the week", 1_800_000_050_000]])
    expect(BotListReport.safeParse({ bots: [], external: bots, problems: [] }).success).toBe(true)
    expect(connectorAgents()["hermes-ada"]).toEqual({ command: "/opt/py", args: ["-m", "hermes_cli.main", "-p", "ada", "acp"], env: { HERMES_HOME: home } })
    const read = await connector.session!({ bot: "ada", session: "a-1", limit: 2 })
    expect(read.messages.map((message) => [message.role, message.text, message.tool])).toEqual([["tool", "{\"ok\": true}", "search"], ["assistant", "the answer", undefined]])
    expect(read.more).toBe(true)
  })

  test("MENDCODE_HERMES_HOME alone reads that folder, and a running server of the app still wins over it", async () => {
    const { home, now } = hermesHome()
    const bots = await hermesConnector({ env: { MENDCODE_HERMES_HOME: home, MENDCODE_HERMES_COMMAND: "/opt/hermes" }, run: async () => "", now }).list()
    expect(bots.map((bot) => bot.id)).toEqual(["default", "ada"])
    expect(connectorAgents()["hermes-default"]).toEqual({ command: "/opt/hermes", args: ["acp"], env: { HERMES_HOME: home } })
    const port = fakeHermes().url.split(":").pop()!
    const run = async (argv: string[]) => {
      if (argv[0] === "ps" && argv[1] === "-axo") return "  4242 /opt/py -m hermes_cli.main serve --port 0\n"
      if (argv[0] === "lsof") return `p4242\nn127.0.0.1:${port}\n`
      if (argv[0] === "ps" && argv[1] === "eww") return `4242 python HERMES_DASHBOARD_SESSION_TOKEN=${TOKEN}`
      return ""
    }
    const served = await hermesConnector({ env: { MENDCODE_HERMES_HOME: home }, run }).list()
    expect(served.map((bot) => bot.name)).toEqual(["Chief", "Ada"])
    expect(served[0]!.model).toBe("gpt-x")
  })

  test("a home with no profiles folder and no database lists its root profile alone", async () => {
    const home = temp()
    const bots = await hermesConnector({ env: { MENDCODE_HERMES_HOME: home }, run: async () => "" }).list()
    expect(bots.map((bot) => [bot.id, bot.name, bot.recent])).toEqual([["default", "default", undefined]])
  })
})
