import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { EXPERIMENTAL_FLAGS } from "@mendcode/protocol/wire"
import { Settings, isReadOnlyCommand, type SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src"
import { remoteTokens } from "../src/remote"
import { createProviderService } from "../src/providers"
import { boot, hang, openSession, say, stop, until } from "./native-harness"
import { configLayers } from "../src/config-layers"
import { outputStyleText } from "../src/output-styles"

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
const temp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

describe("output styles", () => {
  test("default adds nothing; each preset is a distinct tone block that never grants tools", () => {
    expect(outputStyleText(undefined)).toBe("")
    expect(outputStyleText("default")).toBe("")
    const texts = (["explanatory", "learning", "terse"] as const).map(outputStyleText)
    expect(new Set(texts).size).toBe(3)
    for (const text of texts) expect(text).toMatch(/^Output style: /)
  })

  test("the setting validates and the experimental flag list matches the settings schema", () => {
    expect(Settings.safeParse({ outputStyle: "terse", serviceTier: "fast" }).success).toBe(true)
    expect(Settings.safeParse({ outputStyle: "loud" }).success).toBe(false)
    expect(Settings.safeParse({ serviceTier: "turbo" }).success).toBe(false)
    const schemaKeys = Object.keys(((Settings as unknown as { shape: Record<string, { unwrap(): { shape: Record<string, unknown> } }> }).shape.experimental!).unwrap().shape).filter((key) => key !== "primary_tools").sort()
    const listed: string[] = EXPERIMENTAL_FLAGS.map((flag) => flag.id)
    expect(listed.sort()).toEqual(schemaKeys)
    for (const flag of EXPERIMENTAL_FLAGS) expect(Settings.safeParse({ experimental: { [flag.id]: true } }).success).toBe(true)
  })
})

describe("fast service tier", () => {
  test("the openai provider follows the serviceTier setting live; other providers never send it", async () => {
    const dir = temp("mend-b17-fast-")
    let settings = Settings.parse({ provider: { openai: { models: [{ id: "gpt-test" }] }, relay: { type: "openai", baseUrl: "http://relay.test/v1", apiKeyEnv: "RELAY_KEY", models: [{ id: "m" }] } } })
    const bodies: Record<string, Array<Record<string, unknown>>> = { openai: [], relay: [] }
    const sseBody = () => new Response(new TextEncoder().encode(`event: x\ndata: ${JSON.stringify({ type: "response.completed", response: {} })}\n\n`), { status: 200 })
    const providers = createProviderService({ dir, env: { OPENAI_API_KEY: "sk-openai-fixture-00000000000", RELAY_KEY: "sk-relay-fixture-0000000000" }, settings: () => settings, fetch: async (url, init) => { bodies[url.includes("relay.test") ? "relay" : "openai"]!.push(JSON.parse(String(init.body))); return sseBody() } })
    const run = async (id: "openai" | "relay") => { for await (const _ of providers.runtime()[id]!.stream({ system: "", messages: [{ role: "user", content: "hi" }], tools: [], model: id === "openai" ? "gpt-test" : "m", signal: new AbortController().signal })) void _ }
    await run("openai")
    settings = Settings.parse({ ...settings, serviceTier: "fast" })
    await run("openai")
    await run("relay")
    expect(bodies.openai!.map((body) => body.service_tier)).toEqual([undefined, "priority"])
    expect(bodies.relay!.map((body) => body.service_tier)).toEqual([undefined])
  })
})

describe("config layers", () => {
  test("lists each layer in precedence order, hides secret-like values and reports warnings", () => {
    const dir = temp("mend-layers-data-")
    const project = temp("mend-layers-proj-")
    mkdirSync(path.join(project, ".mendcode"))
    writeFileSync(path.join(project, ".mendcode", "project.json"), JSON.stringify({ version: 1, instructions: ["../outside.md"], apiToken: "sk-should-not-show" }))
    const settings = { theme: "fjord", serviceTier: "fast", experimental: { code_mode: true }, provider: { openai: { apiKey: "sk-secret-value-123456" } }, profiles: [{ name: "work", directories: [project] }] } as unknown as Settings
    const { layers, warnings } = configLayers({ dir, directory: project, settings, environment: { MENDCODE_THEME: "x", PATH: "/bin", MENDCODE_V2_ENGINE: "native" }, home: "/home/nobody" })
    expect(layers.map((layer) => layer.id)).toEqual(["defaults", "user", "profile", "project-settings", "project", "environment"])
    const user = layers.find((layer) => layer.id === "user")!
    expect(user.entries).toContain("theme = fjord")
    expect(user.entries).toContain("serviceTier = fast")
    expect(user.entries).toContain("provider · 1 key")
    expect(layers.find((layer) => layer.id === "profile")!.entries).toEqual(["profile = work"])
    expect(layers.find((layer) => layer.id === "project")!.entries).toContain("apiToken · hidden")
    expect(layers.find((layer) => layer.id === "environment")!.entries).toEqual(["MENDCODE_THEME", "MENDCODE_V2_ENGINE"])
    expect(JSON.stringify(layers)).not.toContain("sk-")
    expect(warnings.some((line) => line.includes("experimental flags on: code_mode"))).toBe(true)
    expect(warnings.some((line) => line.includes("service tier fast"))).toBe(true)
    expect(warnings.some((line) => line.includes("../outside.md"))).toBe(true)
  })

  test("an unreadable project file is reported once and ignored", () => {
    const project = temp("mend-layers-bad-")
    mkdirSync(path.join(project, ".mendcode"))
    writeFileSync(path.join(project, ".mendcode", "project.json"), "{ not json")
    const { layers, warnings } = configLayers({ dir: temp("mend-layers-data-"), directory: project, settings: {} as Settings, environment: {} })
    expect(layers.find((layer) => layer.id === "project")).toMatchObject({ present: true, entries: [], note: "ignored: unreadable" })
    expect(warnings.filter((line) => line.startsWith(".mendcode/project.json"))).toHaveLength(1)
  })

  test("system.query config-layers answers a local client without values of secret settings", async () => {
    const h = await boot({ steps: [] })
    cleanup.push(h.cleanup)
    await h.client.send({ type: "settings.set", patch: { serviceTier: "fast", outputStyle: "terse" } })
    const reply = await h.client.send({ type: "system.query", directory: h.project, operation: "config-layers" })
    if (!reply.ok) throw new Error(reply.error.message)
    const facts = (reply.result as { facts: { layers: Array<{ id: string; entries: string[] }> } }).facts
    expect(facts.layers.find((layer) => layer.id === "user")!.entries).toEqual(expect.arrayContaining(["serviceTier = fast", "outputStyle = terse"]))
  })
})

describe("/cd: session.cd", () => {
  test("moves an idle session to an existing directory (relative, ~ and symlinks resolved) and publishes the change", async () => {
    const h = await boot({ steps: [stop("hi")] })
    cleanup.push(h.cleanup)
    const id = await openSession(h)
    const target = h.temp("mend-cd-target-")
    mkdirSync(path.join(target, "sub"))
    const link = path.join(h.temp("mend-cd-links-"), "link")
    symlinkSync(path.join(target, "sub"), link)
    const first = await h.client.send({ type: "session.cd", sessionId: id, path: target })
    if (!first.ok) throw new Error(first.error.message)
    expect(first.result).toEqual({ directory: target, previous: h.project })
    expect(h.store.sessionDirectory(id)).toBe(target)
    const relative = await h.client.send({ type: "session.cd", sessionId: id, path: "sub" })
    expect(relative.ok && relative.result?.directory).toBe(path.join(target, "sub"))
    const viaLink = await h.client.send({ type: "session.cd", sessionId: id, path: link })
    expect(viaLink.ok && viaLink.result?.directory).toBe(path.join(target, "sub"))
    expect(h.events.some((event) => event.type === "session.workspace.changed" && event.directory === target)).toBe(true)
    await say(h, id, "where am I")
    expect(h.store.sessionDirectory(id)).toBe(path.join(target, "sub"))
  })

  test("refuses a missing directory, a file, an unknown session and a busy session", async () => {
    const h = await boot({ steps: [] })
    cleanup.push(h.cleanup)
    const id = await openSession(h)
    const file = path.join(h.project, "plain.txt")
    writeFileSync(file, "x")
    const missing = await h.client.send({ type: "session.cd", sessionId: id, path: path.join(h.project, "nope") })
    expect(missing).toMatchObject({ ok: false, error: { code: "invalid_command" } })
    const notDirectory = await h.client.send({ type: "session.cd", sessionId: id, path: file })
    expect(notDirectory.ok).toBe(false)
    const unknown = await h.client.send({ type: "session.cd", sessionId: "ses_00000000000000000000000000" as never, path: h.project })
    expect(unknown).toMatchObject({ ok: false, error: { code: "unknown_session" } })
    expect(h.store.sessionDirectory(id)).toBe(h.project)
  })

  test("refuses while a turn is running", async () => {
    const h = await boot({ steps: [hang] })
    cleanup.push(h.cleanup)
    const id = await openSession(h)
    await h.client.send({ type: "user.submit", sessionId: id, text: "work", attachments: [] })
    await until(() => h.store.lastTurnStatus(id) === "running")
    const other = h.temp("mend-cd-busy-")
    expect(await h.client.send({ type: "session.cd", sessionId: id, path: other })).toMatchObject({ ok: false, error: { code: "busy" } })
    expect(h.store.sessionDirectory(id)).toBe(h.project)
    await h.client.send({ type: "turn.cancel", sessionId: id } as never)
  })

  test("a remote peer, even with a full-access token, cannot move a session or read the config layers; neither is a read-only command", async () => {
    const dir = temp("mend-b17-remote-")
    const project = temp("mend-b17-remote-proj-")
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), listen: "127.0.0.1:0", engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
    cleanup.push(() => daemon.stop())
    const local = createClient({ socketPath: daemon.socketPath, name: "local" })
    cleanup.push(() => local.close())
    await local.connect()
    const created = await local.send({ type: "session.create", directory: project })
    if (!created.ok) throw new Error(created.error.message)
    const sessionId = created.result!.sessionId as SessionId
    const token = remoteTokens(dir).create({ name: "full", readOnly: false }).token
    const remote = createClient({ name: "full", remote: { hostname: "127.0.0.1", port: daemon.remotePort!, token } })
    cleanup.push(() => remote.close())
    await remote.connect()
    const target = temp("mend-b17-remote-target-")
    expect(await remote.send({ type: "session.cd", sessionId, path: target })).toMatchObject({ ok: false, error: { code: "forbidden" } })
    expect(await remote.send({ type: "system.query", directory: project, operation: "config-layers" })).toMatchObject({ ok: false, error: { code: "forbidden" } })
    expect(daemon.store.sessionDirectory(sessionId)).toBe(project)
    expect((await local.send({ type: "session.cd", sessionId, path: target })).ok).toBe(true)
    for (const type of ["session.cd", "system.query"] as const) expect(isReadOnlyCommand(type)).toBe(false)
  })
})
