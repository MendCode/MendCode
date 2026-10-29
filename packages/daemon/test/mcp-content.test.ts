import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import type { McpCatalogReport, SessionId } from "@mendcode/protocol"
import { startDaemon, type McpControl } from "../src"
import { expandMcpMentions, expandMcpPrompt, mcpCommandArguments } from "../src/mcp-content"
import { remoteTokens } from "../src/remote"

const BUILTIN_COMMANDS = ["bughunter", "commit", "commit-pr", "commit-push", "init", "pr-comments", "review", "security-review", "ultraplan", "verify", "wiki"].map((name) => expect.objectContaining({ name, source: "builtin" }))
const cleanups: Array<() => unknown> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const catalog: McpCatalogReport = {
  resources: [{ server: "docs", id: "docs:guide", name: "guide", uri: "docs://guide" }],
  templates: [{ server: "docs", id: "docs:issue", name: "issue", uriTemplate: "issues://{id}" }],
  prompts: [{ server: "docs", id: "docs:Review", name: "Review", arguments: [{ name: "target", required: true }, { name: "focus" }] }],
  issues: [],
}
function control(seen: unknown[] = []): McpControl {
  return {
    status: async () => ({ servers: [], issues: [] }),
    restart: async () => { throw new Error("unused") },
    catalog: async () => catalog,
    readResource: async (input) => {
      seen.push(input)
      return [{ uri: input.uri, text: "Project conventions" }, { uri: "docs://image", blob: "AAAA", mimeType: "image/png" }]
    },
    getPrompt: async (input) => {
      seen.push(input)
      return { messages: [{ role: "user", content: { type: "text", text: `Review ${input.args.target}; ${input.args.focus ?? "correctness"}` } }] }
    },
  }
}

test("MCP prompt arguments preserve quoting, map in declaration order and collect the final argument", async () => {
  const seen: unknown[] = []
  const port = control(seen)
  expect(mcpCommandArguments('"src/my file.ts" \'security and safety\'')).toEqual(["src/my file.ts", "security and safety"])
  expect(await expandMcpPrompt(port, "/repo", "docs:review", '"src/my file.ts" safety')).toBe("Review src/my file.ts; safety")
  expect(seen[0]).toMatchObject({ server: "docs", name: "Review", args: { target: "src/my file.ts", focus: "safety" } })
  expect(await expandMcpPrompt(port, "/repo", "docs:Review", "one")).toBe("Review one; correctness")
  expect(await expandMcpPrompt(port, "/repo", "unknown", "")).toBeUndefined()
  await expect(expandMcpPrompt(port, "/repo", "docs:Review", "")).rejects.toThrow("target")
  expect(await expandMcpPrompt(port, "/repo", "docs:Review", "one two three")).toBe("Review one; two three")
})

test("mentions read each resource once, append text, label binary content and reject missing aliases", async () => {
  const seen: unknown[] = []
  const result = await expandMcpMentions(control(seen), "/repo", "Use @docs:guide and @docs:guide")
  expect(seen).toHaveLength(1)
  expect(result).toContain('<mcp-resource name="docs:guide">\nProject conventions\n[binary resource: image/png]')
  await expect(expandMcpMentions(control(), "/repo", "@docs:missing")).rejects.toThrow("unknown")
  expect(await expandMcpMentions({}, "/repo", "@src/file.ts")).toBe("@src/file.ts")
})

test("thread mentions are reserved and attached snapshots cannot trigger MCP reads", async () => {
  const seen: unknown[] = []
  const { client, dir, prompts } = await boot(control(seen))
  const create = async () => {
    const reply = await client.send({ type: "session.create", directory: dir })
    if (!reply.ok) throw new Error(reply.error.message)
    return reply.result?.sessionId as SessionId
  }
  const source = await create()
  const target = await create()
  // A literal MCP reference in another session is context, not new user consent to read it.
  expect(await client.send({ type: "user.submit", sessionId: source, text: "example @docs:guide", attachments: [] })).toMatchObject({ ok: true })
  for (let tries = 0; tries < 100 && !prompts.length; tries++) await Bun.sleep(2)
  seen.length = 0
  expect(await client.send({ type: "user.submit", sessionId: target, text: `/thread-check @thread:${source}`, attachments: [] })).toMatchObject({ ok: true })
  for (let tries = 0; tries < 100 && prompts.length < 2; tries++) await Bun.sleep(2)
  expect(prompts[1]).toContain("<thread-snapshot ")
  expect(prompts[1]).toContain("example @docs:guide")
  expect(seen).toEqual([])
  const original = `use @thread:${source} and @docs:guide`
  expect(await client.send({ type: "user.submit", sessionId: target, text: original, attachments: [] })).toMatchObject({ ok: true })
  expect(seen).toHaveLength(1)
})

async function boot(mcp?: McpControl, remote = false) {
  const dir = mkdtempSync(join(tmpdir(), "mendd-catalog-"))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const prompts: string[] = []
  const daemon = await startDaemon({ dir, socketPath: join(dir, "mendd.sock"), ...(remote ? { listen: "127.0.0.1:0" } : {}), engine: ({ clock }) => {
    const engine = createFauxEngine({ clock, deltaMs: 1 })
    return { ...engine, runTurn(input) {
      prompts.push(input.text)
      return engine.runTurn(input)
    } }
  }, ...(mcp ? { mcp } : {}) })
  cleanups.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "catalog" })
  await client.connect()
  cleanups.push(() => client.close())
  return { client, dir, prompts, daemon }
}

test("daemon catalog queries and typed client helpers roundtrip; custom commands take precedence", async () => {
  const { client, dir } = await boot(control())
  expect(await client.mcpCatalog(dir)).toEqual({ ok: true, catalog })
  expect(await client.send({ type: "mcp.resources.list", directory: dir })).toMatchObject({ ok: true, result: { resources: catalog.resources, templates: catalog.templates } })
  expect(await client.send({ type: "mcp.prompts.list", directory: dir })).toMatchObject({ ok: true, result: { prompts: catalog.prompts } })
  expect(await client.readMcpResource(dir, "docs", "docs://guide")).toMatchObject({ ok: true, contents: expect.arrayContaining([expect.objectContaining({ text: "Project conventions" })]) })
  expect(await client.getMcpPrompt(dir, "docs", "Review", { target: "app.ts" })).toMatchObject({ ok: true, prompt: { messages: [expect.objectContaining({ role: "user" })] } })
  expect(await client.send({ type: "commands.list", directory: dir })).toMatchObject({ ok: true, result: { commands: [...BUILTIN_COMMANDS, expect.objectContaining({ name: "docs:review", source: "mcp", argumentHint: "<target> [focus]" })] } })
  expect(await client.send({ type: "commands.expand", directory: dir, name: "docs:review", args: "app.ts" })).toMatchObject({ ok: true, result: { prompt: "Review app.ts; correctness" } })
  expect(await client.send({ type: "commands.expand", directory: dir, name: "docs:review", args: "" })).toMatchObject({ ok: false, error: { code: "target_mismatch" } })
  mkdirSync(join(dir, ".mendcode", "commands", "docs"), { recursive: true })
  writeFileSync(join(dir, ".mendcode", "commands", "docs", "review.md"), "Local $1")
  expect(await client.send({ type: "commands.expand", directory: dir, name: "docs:review", args: "app.ts" })).toMatchObject({ ok: true, result: { prompt: "Local app.ts" } })
})

test("resource expansion reaches the engine and missing resources leave the session untouched", async () => {
  const { client, dir, prompts } = await boot(control())
  const created = await client.send({ type: "session.create", directory: dir })
  const sessionId = created.ok ? created.result?.sessionId as SessionId : undefined
  expect(sessionId).toBeTruthy()
  expect(await client.send({ type: "user.submit", sessionId: sessionId!, text: "@docs:missing", attachments: [] })).toMatchObject({ ok: false, error: { code: "target_mismatch" } })
  expect(prompts).toEqual([])
  expect(await client.send({ type: "user.submit", sessionId: sessionId!, text: "Explain @docs:guide", attachments: [] })).toMatchObject({ ok: true })
  for (let tries = 0; tries < 100 && !prompts.length; tries++) await Bun.sleep(2)
  expect(prompts[0]).toContain("Project conventions")
})

test("older daemon controls list an empty catalog and refuse content operations", async () => {
  const { client, dir } = await boot()
  expect(await client.mcpCatalog(dir)).toEqual({ ok: true, catalog: { resources: [], templates: [], prompts: [], issues: [] } })
  expect(await client.readMcpResource(dir, "docs", "docs://guide")).toMatchObject({ ok: false })
})

test("read-only peers cannot discover MCP content or invoke its server through command discovery", async () => {
  let calls = 0
  const mcp = { ...control(), catalog: async () => { calls++
    return catalog
  } }
  const { client, daemon, dir } = await boot(mcp, true)
  expect((await client.send({ type: "session.create", directory: dir })).ok).toBe(true)
  const token = remoteTokens(dir).create({ name: "observer", readOnly: true }).token
  const reader = createClient({ name: "observer", remote: { hostname: "127.0.0.1", port: daemon.remotePort!, token } })
  cleanups.push(() => reader.close())
  await reader.connect()
  for (const command of [
    { type: "mcp.catalog", directory: dir },
    { type: "mcp.resources.list", directory: dir },
    { type: "mcp.resource.read", directory: dir, server: "docs", uri: "docs://guide" },
    { type: "mcp.prompts.list", directory: dir },
    { type: "mcp.prompt.get", directory: dir, server: "docs", name: "Review", args: {} },
  ] as const) expect(await reader.send(command)).toMatchObject({ ok: false, error: { code: "forbidden" } })
  expect(await reader.send({ type: "commands.list", directory: dir })).toMatchObject({ ok: true, result: { commands: BUILTIN_COMMANDS } })
  expect(await reader.send({ type: "commands.expand", directory: dir, name: "docs:review", args: "app.ts" })).toMatchObject({ ok: false })
  expect(calls).toBe(0)
})
