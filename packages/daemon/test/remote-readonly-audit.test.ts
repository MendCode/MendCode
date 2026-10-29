import { afterEach, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import type { GrantStore } from "@mendcode/engine-native"
import { createIdFactory, isReadOnlyCommand, type SessionId } from "@mendcode/protocol"
import { startDaemon } from "../src"
import { createProviderService } from "../src/providers"
import { remoteTokens } from "../src/remote"

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const credential = `sk-proj-${"a1B2c3D4".repeat(5)}`

async function boot(mcp?: Parameters<typeof startDaemon>[0]["mcp"]) {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-readonly-audit-")), project = path.join(dir, "project")
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(project)
  const initialized = Bun.spawnSync(["git", "init", "-q", project])
  if (initialized.exitCode) throw new Error(initialized.stderr.toString())
  writeFileSync(path.join(project, "credential.txt"), `API_KEY=${credential}\n`)
  mkdirSync(path.join(project, ".mendcode/prompts"), { recursive: true })
  writeFileSync(path.join(project, ".mendcode/prompts/custom.md"), `# ${credential}\n\nProject instructions`)
  const providerFile = path.join(dir, "providers.json")
  writeFileSync(providerFile, JSON.stringify({ providers: { openai: { apiKey: credential } } }))
  chmodSync(providerFile, 0o644)
  let grants: GrantStore | undefined
  const daemon = await startDaemon({
    dir, socketPath: path.join(dir, "mendd.sock"), listen: "127.0.0.1:0",
    providers: createProviderService({ dir, env: {} }),
    models: { selectable: true, list: () => [{ id: "scripted", name: "Scripted", efforts: [] }], defaults: { model: "scripted" } },
    info: { engine: "native", login: async () => ({ ok: true }) },
    ...(mcp ? { mcp } : {}),
    engine: (input) => { grants = input.grants; return createFauxEngine({ clock: input.clock, deltaMs: 1 }) },
  })
  cleanups.push(() => daemon.stop())
  const writer = createClient({ socketPath: daemon.socketPath, name: "local-audit" })
  cleanups.push(() => writer.close())
  await writer.connect()
  const created = await writer.send({ type: "session.create", directory: project })
  if (!created.ok) throw new Error(created.error.message)
  const sessionId = created.result!.sessionId as SessionId
  const pattern = `curl -H 'Authorization: Bearer ${credential}' https://example.test`
  daemon.store.settings.set({ models: { main: { model: "scripted", parameters: { metadata: { apiKey: credential } } } }, permission: { shell: { [pattern]: "ask" } } })
  grants!.add(sessionId, "shell", "execute", pattern, "shell")
  expect((await writer.send({ type: "memory.add", scope: "project", directory: project, text: `API_KEY=${credential}` })).ok).toBe(true)
  const token = remoteTokens(dir).create({ name: "observer", readOnly: true }).token
  const reader = createClient({ name: "observer", remote: { hostname: "127.0.0.1", port: daemon.remotePort!, token } })
  cleanups.push(() => reader.close())
  await reader.connect()
  return { daemon, reader, writer, sessionId, project, providerFile, dir, token }
}

test("read-only peers cannot retrieve unredacted diffs, memories, prompt names, permission patterns or model parameters", async () => {
  const h = await boot()
  const commands: Parameters<typeof h.reader.send>[0][] = [
    { type: "review.query", sessionId: h.sessionId, query: { action: "file", filePath: "credential.txt", includePatch: true } },
    { type: "memory.browse", directory: h.project, view: "project" },
    { type: "prompt.status", directory: h.project },
    { type: "prompt.sources", directory: h.project },
    { type: "permissions.status" },
    { type: "permissions.history", sessionId: h.sessionId },
    { type: "models.config.get", directory: h.project },
    { type: "settings.get" },
  ]
  for (const command of commands) {
    const local = await h.writer.send(command)
    expect(local.ok).toBe(true)
    expect(JSON.stringify(local)).toContain(credential)
    expect(isReadOnlyCommand(command.type)).toBe(false)
    const denied = await h.reader.send(command)
    expect(denied).toMatchObject({ ok: false, error: { code: "forbidden" } })
    expect(JSON.stringify(denied)).not.toContain(credential)
  }
})

test("wave-four sharing status is denied before returning a capability URL or private service errors", async () => {
  const h = await boot()
  h.reader.close()
  h.writer.close()
  await h.daemon.stop()
  const content = "privateSharedUserContentAndOpaqueCapability"
  const file = path.join(h.dir, "session-shares.json")
  writeFileSync(file, JSON.stringify([{ sessionId: h.sessionId, id: "audit-share", secret: credential, url: `http://127.0.0.1:8788/share/${content}?token=${content}`, backend: "http://127.0.0.1:8788", resource: "share" }]), { mode: 0o600 })
  const daemon = await startDaemon({ dir: h.dir, socketPath: h.daemon.socketPath, listen: "127.0.0.1:0", engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
  cleanups.push(daemon.stop)
  const writer = createClient({ socketPath: daemon.socketPath, name: "local-share-audit" })
  const reader = createClient({ name: "share-observer", remote: { hostname: "127.0.0.1", port: daemon.remotePort!, token: h.token } })
  cleanups.push(() => writer.close(), () => reader.close())
  await writer.connect()
  await reader.connect()
  const command = { type: "session.share.get" as const, sessionId: h.sessionId }
  const local = await writer.send(command)
  expect(local.ok).toBe(true)
  expect(JSON.stringify(local)).toContain(content)
  const state = () => JSON.stringify({ settings: daemon.store.settings.get(), session: daemon.store.sessionSummary(h.sessionId), seq: daemon.store.lastSeq(h.sessionId), share: readFileSync(file, "utf8"), mode: statSync(file).mode & 0o777 })
  const before = state()
  expect(isReadOnlyCommand(command.type)).toBe(false)
  const denied = await reader.send(command)
  expect(denied).toMatchObject({ ok: false, error: { code: "forbidden" } })
  expect(JSON.stringify(denied)).not.toContain(content)
  expect(JSON.stringify(denied)).not.toContain(credential)
  expect(state()).toBe(before)
  expect(statSync(h.providerFile).mode & 0o777).toBe(0o644)
})

for (const type of ["providers.catalog", "system.query"] as const) {
  test(`read-only peers cannot trigger provider file permission changes through ${type}`, async () => {
    const h = await boot()
    const command = type === "providers.catalog" ? { type } : { type, directory: h.project, operation: "ai-status" as const }
    const before = readFileSync(h.providerFile, "utf8")
    expect(statSync(h.providerFile).mode & 0o777).toBe(0o644)
    expect(isReadOnlyCommand(type)).toBe(false)
    expect(await h.reader.send(command)).toMatchObject({ ok: false, error: { code: "forbidden" } })
    expect(statSync(h.providerFile).mode & 0o777).toBe(0o644)
    expect((await h.writer.send(command)).ok).toBe(true)
    expect(statSync(h.providerFile).mode & 0o777).toBe(0o600)
    expect(readFileSync(h.providerFile, "utf8")).toBe(before)
    const local = await h.writer.send(command)
    if (type === "providers.catalog") {
      expect(JSON.stringify(local)).not.toContain(credential)
      expect(JSON.stringify(local)).not.toContain("keyTail")
    } else expect(JSON.stringify(local)).toContain(credential)
  })
}

test("memory metadata stays local; remaining peer reads redact sessions without changing durable state", async () => {
  const h = await boot()
  const commands: Parameters<typeof h.reader.send>[0][] = [
    { type: "plan.review.list", sessionId: h.sessionId },
    { type: "session.agent-command.policy" },
    { type: "session.get", sessionId: h.sessionId },
    { type: "session.inspect", sessionId: h.sessionId },
    { type: "context.recent", sessionId: h.sessionId },
  ]
  h.daemon.store.renameSession(h.sessionId, `API_KEY=${credential}`)
  const before = JSON.stringify({ settings: h.daemon.store.settings.get(), session: h.daemon.store.sessionSummary(h.sessionId), seq: h.daemon.store.lastSeq(h.sessionId) })
  for (const command of [{ type: "memory.workspaces", directory: h.project }, { type: "memory.sharing.status", scope: "project", directory: h.project }] as const) {
    expect(isReadOnlyCommand(command.type)).toBe(false)
    expect(await h.reader.send(command)).toMatchObject({ ok: false, error: { code: "forbidden" } })
    expect((await h.writer.send(command)).ok).toBe(true)
  }
  for (const command of commands) {
    expect(isReadOnlyCommand(command.type)).toBe(true)
    const reply = await h.reader.send(command)
    expect(reply.ok).toBe(true)
    expect(JSON.stringify(reply)).not.toContain(credential)
  }
  expect(isReadOnlyCommand("session.agent-command.list")).toBe(true)
  expect(await h.reader.send({ type: "session.agent-command.list", sessionId: h.sessionId })).toMatchObject({ ok: false, error: { code: "invalid_command" } })
  expect(JSON.stringify({ settings: h.daemon.store.settings.get(), session: h.daemon.store.sessionSummary(h.sessionId), seq: h.daemon.store.lastSeq(h.sessionId) })).toBe(before)
  expect(statSync(h.providerFile).mode & 0o777).toBe(0o644)
})

test("wave-two content reads are forbidden before handlers can expose user content or inspect Git", async () => {
  const h = await boot()
  const content = "private-user-content-and-opaque-token"
  const created = await h.writer.send({ type: "session.create", directory: h.project, parentId: h.sessionId, title: content })
  if (!created.ok) throw new Error(created.error.message)
  const childId = created.result!.sessionId as SessionId
  h.daemon.store.meta.set(`session.summary:${childId}`, content)
  expect(await h.writer.send({ type: "session.background.register", sessionId: childId, state: "completed", summary: content, error: content })).toMatchObject({ ok: true })
  expect(await h.writer.send({ type: "session.agent-view.metadata.patch", sessionId: childId, patch: { title: content, notes: content, tags: [content] } })).toMatchObject({ ok: true })
  const commands: Parameters<typeof h.reader.send>[0][] = [
    { type: "session.children", sessionId: h.sessionId },
    { type: "session.background.list", directory: h.project },
    { type: "session.agent-view.metadata.list", directory: h.project },
    { type: "session.agent-view.metadata.get", sessionId: childId },
    { type: "worktree.query", directory: h.project, query: { operation: "preview", input: { name: "audit", path: path.join(h.project, content) } } },
  ]
  for (const command of commands) {
    const local = await h.writer.send(command)
    expect(local.ok).toBe(true)
    expect(JSON.stringify(local)).toContain(content)
  }
  const state = () => JSON.stringify({ settings: h.daemon.store.settings.get(), root: h.daemon.store.sessionSummary(h.sessionId), child: h.daemon.store.sessionSummary(childId), summary: h.daemon.store.meta.get(`session.summary:${childId}`), background: h.daemon.store.sessionBackground.list(), metadata: h.daemon.store.agentCommands.metadata(), seq: [h.daemon.store.lastSeq(h.sessionId), h.daemon.store.lastSeq(childId)] })
  const before = state()
  const registry = await h.writer.send(commands.at(-1)!)
  if (!registry.ok) throw new Error(registry.error.message)
  const registryPath = String(registry.result!.registryPath)
  expect(() => statSync(registryPath)).toThrow()
  for (const command of commands) {
    expect(isReadOnlyCommand(command.type)).toBe(false)
    const denied = await h.reader.send(command)
    expect(denied).toMatchObject({ ok: false, error: { code: "forbidden" } })
    expect(JSON.stringify(denied)).not.toContain(content)
    expect(JSON.stringify(denied)).not.toContain(credential)
  }
  expect(state()).toBe(before)
  expect(() => statSync(registryPath)).toThrow()
  expect(statSync(h.providerFile).mode & 0o777).toBe(0o644)
})

test("the remaining wave-two command list is local-only and does not read or change remote state", async () => {
  const h = await boot()
  const content = "private-agent-command-metadata"
  h.daemon.store.agentCommands.patchMetadata(h.sessionId, { notes: content })
  const command = { type: "session.agent-command.list-by-session" as const, sessionId: h.sessionId }
  expect(isReadOnlyCommand(command.type)).toBe(true)
  const local = await h.writer.send(command)
  expect(local.ok).toBe(true)
  expect(JSON.stringify(local)).toContain(content)
  const before = JSON.stringify(h.daemon.store.agentCommands.metadata())
  const denied = await h.reader.send(command)
  expect(denied).toMatchObject({ ok: false, error: { code: "invalid_command" } })
  expect(JSON.stringify(denied)).not.toContain(content)
  expect(JSON.stringify(h.daemon.store.agentCommands.metadata())).toBe(before)
})

test("read-only command discovery neither reads cached MCP prompt content nor contacts its server", async () => {
  let calls = 0
  const h = await boot({
    status: async () => ({ servers: [], issues: [] }),
    restart: async () => { throw new Error("unused") },
    cachedPrompts: () => { calls++; return [{ server: "docs", prompt: { name: "private", description: credential } }] },
    catalog: async () => { calls++; return { resources: [], templates: [], prompts: [], issues: [] } },
  })
  const reply = await h.reader.send({ type: "commands.list", directory: h.project })
  expect(reply).toMatchObject({ ok: true, result: { commands: ["bughunter", "commit", "commit-pr", "commit-push", "init", "pr-comments", "review", "security-review", "ultraplan", "verify", "wiki"].map((name) => expect.objectContaining({ name })) } })
  expect(JSON.stringify(reply)).not.toContain(credential)
  expect(calls).toBe(0)
  expect(statSync(h.providerFile).mode & 0o777).toBe(0o644)
})

test("all eight wave-three reads are observational and exclude opaque provider credentials and user/MCP content", async () => {
  let mcpReads = 0
  const opaque = "opaquePrivateValueWithoutCredentialPrefix"
  const h = await boot({
    status: async () => ({ servers: [], issues: [] }), restart: async () => { throw new Error("unused") },
    cachedPrompts: () => { mcpReads++; return [{ server: "private", prompt: { name: opaque, description: opaque } }] },
    catalog: async () => { mcpReads++; return { resources: [], templates: [], prompts: [], issues: [] } },
  })
  const authFiles = [path.join(h.dir, "chatgpt-auth.json"), path.join(h.dir, "github-copilot-auth.json")]
  writeFileSync(authFiles[0]!, JSON.stringify({ access: opaque, refresh: opaque, account: opaque, expiresAt: Date.now() + 3600_000 }))
  writeFileSync(authFiles[1]!, JSON.stringify({ access: opaque, refresh: opaque, issuer: "https://github.com", expiresAt: Date.now() + 3600_000 }))
  for (const file of authFiles) chmodSync(file, 0o644)
  h.daemon.store.renameSession(h.sessionId, opaque)
  const state = () => JSON.stringify({ settings: h.daemon.store.settings.get(), session: h.daemon.store.sessionSummary(h.sessionId), seq: h.daemon.store.lastSeq(h.sessionId), files: [h.providerFile, ...authFiles].map((file) => ({ content: readFileSync(file, "utf8"), mode: statSync(file).mode & 0o777 })) })
  const before = state()
  const commands: Parameters<typeof h.reader.send>[0][] = [
    { type: "server.health" }, { type: "server.memory" },
    { type: "providers.auth.methods" }, { type: "providers.auth.status" },
    { type: "providers.auth.plan", provider: "chatgpt", method: "browser" },
    { type: "release.inspect" }, { type: "daemon.status" }, { type: "trace.query", sessionId: h.sessionId },
  ]
  for (const command of commands) {
    expect(isReadOnlyCommand(command.type)).toBe(true)
    const reply = await h.reader.send(command)
    expect(reply.ok).toBe(true)
    expect(JSON.stringify(reply)).not.toContain(credential)
    expect(JSON.stringify(reply)).not.toContain(opaque)
    expect(state()).toBe(before)
  }
  expect(await h.reader.send({ type: "providers.auth.status", provider: "chatgpt" })).toMatchObject({ ok: true, result: { statuses: [expect.objectContaining({ accessTokenPresent: true, refreshTokenPresent: true, accountIdPresent: true })] } })
  expect(await h.reader.send({ type: "providers.auth.status", provider: "github-copilot" })).toMatchObject({ ok: true, result: { statuses: [expect.objectContaining({ accessTokenPresent: true, refreshTokenPresent: true })] } })
  const denied: Parameters<typeof h.reader.send>[0][] = [
    { type: "providers.auth.authorize", provider: "chatgpt", method: "browser" },
    { type: "providers.auth.action", provider: "chatgpt", action: "refresh" },
    { type: "providers.auth.metadata", url: "https://example.test/metadata", execute: true },
    { type: "server.config.get" }, { type: "server.dispose" },
    { type: "app.log", input: { service: "audit", level: "info", message: opaque } },
    { type: "trace.configure", enabled: true },
    { type: "daemon.tick", scheduler: "loops", execute: true },
  ]
  for (const command of denied) {
    expect(isReadOnlyCommand(command.type)).toBe(false)
    expect(await h.reader.send(command)).toMatchObject({ ok: false, error: { code: "forbidden" } })
  }
  expect(state()).toBe(before)
  expect(mcpReads).toBe(0)
  expect(() => statSync(path.join(h.dir, "trace.jsonl"))).toThrow()
})

test("wave-five REST, TUI, interactions and PTY commands remain denied before reading content or changing state", async () => {
  const h = await boot()
  const ids = createIdFactory(), workflowId = ids("workflow"), ptyId = `pty_${"a".repeat(32)}`
  const commands: Parameters<typeof h.reader.send>[0][] = [
    { type: "catalog.rest", directory: h.project, input: { operation: "providers" } },
    { type: "catalog.rest", directory: h.project, input: { operation: "oauth-callback", provider: "chatgpt", method: 0, code: credential } },
    { type: "tui.control.register", directory: h.project, enabled: true },
    { type: "tui.control.send", directory: h.project, request: { path: "/tui/append-prompt", body: { text: credential } } },
    { type: "tui.control.next", directory: h.project, timeoutMs: 1 },
    { type: "tui.control.response", directory: h.project, response: true },
    { type: "project.rest", directory: h.project, input: { operation: "vcs-diff", mode: "git" } },
    { type: "workflow.permissions", workflowId, mode: "report-only" },
    { type: "workflow.retry-phase", workflowId, phaseId: "main" },
    { type: "workflow.script", workflowId, action: "budget", budget: { agents: 50 } },
    { type: "workflow.start", directory: h.project, plan: { script: `export const meta = { name: "x" }\nreturn 1` } },
    { type: "interaction.list", directory: h.project, kind: "question" },
    { type: "memory.side-chat", directory: h.project, payload: { message: credential } },
    { type: "file.rest.read", directory: h.project, input: { operation: "file.read", path: "credential.txt" } },
    { type: "file.view", directory: h.project, path: "credential.txt" },
    { type: "file.view", directory: h.project, path: "." },
    { type: "git.commit", directory: h.project, message: credential, paths: ["credential.txt"] },
    { type: "git.commit", directory: h.project, message: credential, paths: ["credential.txt"], preview: true },
    { type: "git.push", directory: h.project },
    { type: "git.publish", directory: h.project, name: credential, description: credential },
    { type: "git.init", directory: h.project, sessionId: h.sessionId },
    { type: "git.pr.view", directory: h.project },
    { type: "git.pr.create", directory: h.project, title: credential, body: credential },
    { type: "file.edit", directory: h.project, input: { operation: "read", path: "credential.txt" } },
    { type: "file.edit", directory: h.project, input: { operation: "write", path: "credential.txt", content: credential, expected: null } },
    { type: "pty.shells", directory: h.project },
    { type: "pty.list", directory: h.project },
    { type: "pty.create", directory: h.project, input: { args: [credential] } },
    { type: "pty.get", directory: h.project, ptyId },
    { type: "pty.update", directory: h.project, ptyId, input: { title: credential } },
    { type: "pty.remove", directory: h.project, ptyId },
    { type: "pty.connect-token", directory: h.project, ptyId },
  ]
  const state = () => JSON.stringify({ settings: h.daemon.store.settings.get(), session: h.daemon.store.sessionSummary(h.sessionId), seq: h.daemon.store.lastSeq(h.sessionId), workflows: h.daemon.store.workflows.all(), providers: readFileSync(h.providerFile, "utf8"), mode: statSync(h.providerFile).mode & 0o777 })
  const before = state()
  for (const command of commands) {
    expect(isReadOnlyCommand(command.type)).toBe(false)
    const denied = await h.reader.send(command)
    expect(denied).toMatchObject({ ok: false, error: { code: "forbidden" } })
    expect(JSON.stringify(denied)).not.toContain(credential)
    expect(state()).toBe(before)
  }
  expect(h.daemon.workflowsLoaded()).toBe(false)
})

test("wave-five provider auth discovery remains observational and excludes opaque keys and headers", async () => {
  const h = await boot(), opaque = "opaqueWaveFiveCredentialWithoutRecognizablePrefix"
  const providers = ["azure", "amazon-bedrock", "google-vertex", "google-vertex-anthropic", "xai", "mistral", "deepinfra", "perplexity", "alibaba", "opencode", "llmgateway", "nvidia", "sap-ai-core", "zenmux", "gitlab"]
  writeFileSync(h.providerFile, JSON.stringify({ providers: Object.fromEntries(providers.map((id) => [id, { enabled: false, apiKey: opaque, headers: { "x-private-routing": opaque } }])) }))
  chmodSync(h.providerFile, 0o644)
  const before = readFileSync(h.providerFile, "utf8")
  for (const provider of providers) {
    for (const command of [{ type: "providers.auth.methods", provider }, { type: "providers.auth.status", provider }, { type: "providers.auth.plan", provider }] as const) {
      expect(isReadOnlyCommand(command.type)).toBe(true)
      const reply = await h.reader.send(command)
      expect(reply.ok).toBe(true)
      expect(JSON.stringify(reply)).not.toContain(opaque)
      expect(readFileSync(h.providerFile, "utf8")).toBe(before)
      expect(statSync(h.providerFile).mode & 0o777).toBe(0o644)
    }
  }
})

test("raw content reads (permission patterns, command files, memories, scratchpad, working-tree diffs) need a full-access peer", async () => {
  const h = await boot()
  mkdirSync(path.join(h.project, ".mendcode/commands"), { recursive: true })
  writeFileSync(path.join(h.project, ".mendcode/commands/custom.md"), `Use ${credential}`)
  expect((await h.writer.send({ type: "scratchpad.set", directory: h.project, text: `API_KEY=${credential}` })).ok).toBe(true)
  const commands: Parameters<typeof h.reader.send>[0][] = [
    { type: "permissions.list", sessionId: h.sessionId },
    { type: "commands.expand", directory: h.project, name: "custom", args: "" },
    { type: "memory.list", directory: h.project },
    { type: "memory.search", directory: h.project, query: "API_KEY" },
    { type: "memory.graph", directory: h.project },
    { type: "scratchpad.get", directory: h.project },
    { type: "changes.query", directory: h.project },
    { type: "changes.file", directory: h.project, path: "credential.txt" },
  ]
  for (const command of commands) {
    const local = await h.writer.send(command)
    expect(local.ok).toBe(true)
    expect(JSON.stringify(local)).toContain(credential)
    expect(isReadOnlyCommand(command.type)).toBe(false)
    const denied = await h.reader.send(command)
    expect(denied).toMatchObject({ ok: false, error: { code: "forbidden" } })
    expect(JSON.stringify(denied)).not.toContain(credential)
  }
})
