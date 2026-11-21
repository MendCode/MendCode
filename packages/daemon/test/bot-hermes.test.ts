import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
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
    expect(requests - before).toBe(2)
    release.splice(0).forEach((resolve) => resolve())
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect((await connector.list()).map((bot) => bot.id)).toEqual(["later"])
  })

  test("a background refresh that fails is reported by the next list, once, and the list after it asks again", async () => {
    let clock = 0
    let down = false
    const fetcher = (async (url: string) => {
      if (down) throw new Error("refused")
      return Response.json(url.includes("/sessions") ? { sessions: [] } : { profiles: [{ name: "ada" }] })
    }) as unknown as typeof fetch
    const connector = hermesConnector({ env: { MENDCODE_HERMES_URL: "http://hermes.test" }, fetch: fetcher, now: () => clock })
    await connector.list()
    down = true
    clock = 60_000
    expect((await connector.list()).map((bot) => bot.id)).toEqual(["ada"])
    await new Promise((resolve) => setTimeout(resolve, 10))
    await expect(connector.list()).rejects.toThrow("[HERMES]: Hermes does not answer")
    down = false
    expect((await connector.list()).map((bot) => bot.id)).toEqual(["ada"])
  })

  test("the profiles and the active sessions are requested together", async () => {
    const order: string[] = []
    const fetcher = (async (url: string) => {
      order.push(`start ${url.includes("/sessions") ? "sessions" : "profiles"}`)
      await new Promise((resolve) => setTimeout(resolve, 20))
      return Response.json(url.includes("/sessions") ? { sessions: [] } : { profiles: [] })
    }) as unknown as typeof fetch
    await hermesConnector({ env: { MENDCODE_HERMES_URL: "http://hermes.test" }, fetch: fetcher }).list()
    expect(order).toEqual(["start sessions", "start profiles"])
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
