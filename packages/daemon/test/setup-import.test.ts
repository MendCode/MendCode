import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { Command, createIdFactory, isReadOnlyCommand } from "@mendcode/protocol"
import { setupImportKey } from "@mendcode/protocol/wire"
import { createFauxEngine } from "@mendcode/engine-faux"
import { startDaemon } from "../src"
import { remoteTokens } from "../src/remote"
import { createSetupImport } from "../src/setup-import"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

const SECRET = `sk-proj-${"A".repeat(40)}`
const temp = (prefix: string) => {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
const write = (file: string, text: string) => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, text) }

/** A fake home with a Claude Code and a Codex setup, a project and an empty MendCode data dir. */
function layout() {
  const root = temp("mend-setup-import-")
  const homes = { claude: path.join(root, "home", ".claude"), codex: path.join(root, "home", ".codex"), claudeJson: path.join(root, "home", ".claude.json") }
  const project = path.join(root, "project")
  const dir = path.join(root, "data")
  mkdirSync(project, { recursive: true })
  write(homes.claudeJson, JSON.stringify({
    history: "ignored",
    mcpServers: {
      files: { type: "stdio", command: "npx", args: ["-y", "@scope/files", "/work"], env: { NODE_ENV: "production", API_TOKEN: SECRET, HOME_REF: "${HOME}", WITH_DEFAULT: "${REGION:-eu}" } },
      docs: { type: "http", url: "https://docs.example.com/mcp", headers: { Authorization: `Bearer ${SECRET}`, "X-Team": "core" } },
      leaky: { command: "tool", args: ["--key", SECRET] },
      "bad name!": { command: "x" },
    },
    projects: { [project]: { mcpServers: { local: { command: "bun", args: ["run", "mcp"] } } } },
  }))
  write(path.join(project, ".mcp.json"), JSON.stringify({ mcpServers: { shared: { type: "sse", url: "https://shared.example.com/sse" }, creds: { url: `https://user:${SECRET}@h.example.com/mcp` } } }))
  write(path.join(homes.codex, "config.toml"), [
    "[mcp_servers.search]", `command = "uvx"`, `args = ["search-mcp"]`, `env_vars = ["SEARCH_HOME"]`, "tool_timeout_sec = 30", "",
    "[mcp_servers.search.env]", `LOG = "info"`, `SEARCH_KEY = "${SECRET}"`, "",
    "[mcp_servers.remote]", `url = "https://remote.example.com/mcp"`, `bearer_token_env_var = "REMOTE_TOKEN"`, "enabled = false", "",
    "[mcp_servers.files]", `command = "other"`, "",
  ].join("\n"))
  write(path.join(homes.codex, "prompts", "review.md"), "---\ndescription: Review a diff\n---\nReview $ARGUMENTS")
  write(path.join(homes.codex, "prompts", "shelly.md"), "run !`rm -rf x` now")
  write(path.join(homes.codex, "AGENTS.md"), "codex rules\n")
  write(path.join(homes.claude, "CLAUDE.md"), "claude rules\n")
  write(path.join(homes.claude, "commands", "ship.md"), "ship it")
  write(path.join(homes.claude, "agents", "reviewer.md"), "---\ndescription: r\n---\nbody")
  write(path.join(project, ".claude", "skills", "tdd", "SKILL.md"), "---\nname: tdd\n---\nbody")
  write(path.join(project, "CLAUDE.md"), "project rules")
  return { root, homes, project, dir, service: createSetupImport({ dir, homes }) }
}

const names = (items: Array<{ name: string; kind: string }>, kind = "mcp") => items.filter((item) => item.kind === kind).map((item) => item.name)

describe("setup import preview", () => {
  test("reads both tools, reports what is new and what stays, and writes nothing", async () => {
    const { project, dir, service } = layout()
    const report = await service.run({ directory: project, from: "auto", apply: false })
    expect(report.applied).toBe(false)
    expect(report.found.map((entry) => entry.tool).sort()).toEqual(["claude-code", "claude-code", "codex"])
    const byName = Object.fromEntries(report.items.filter((item) => item.kind === "mcp").map((item) => [`${item.tool}:${item.name}`, item]))
    expect(byName["claude-code:files"]).toMatchObject({ status: "new", scope: "user", needs: ["API_TOKEN"], enabled: false })
    expect(byName["claude-code:docs"]).toMatchObject({ status: "new", needs: ["DOCS_AUTHORIZATION"], enabled: false })
    expect(byName["claude-code:leaky"]).toMatchObject({ status: "skipped" })
    expect(byName["claude-code:bad-name"]).toMatchObject({ status: "new" })
    expect(byName["claude-code:local"]).toMatchObject({ status: "new", scope: "project", enabled: true })
    expect(byName["claude-code:shared"]).toMatchObject({ status: "new", scope: "project" })
    expect(byName["claude-code:creds"]).toMatchObject({ status: "skipped" })
    expect(byName["codex:search"]).toMatchObject({ status: "new", needs: ["SEARCH_KEY"] })
    expect(byName["codex:remote"]).toMatchObject({ status: "new", enabled: false })
    expect(byName["codex:files"]).toMatchObject({ status: "exists" })
    expect(names(report.items, "command")).toEqual(["review", "shelly"])
    expect(report.items.find((item) => item.name === "shelly")).toMatchObject({ status: "skipped", note: expect.stringContaining("inline shell") })
    expect(report.items.filter((item) => item.kind === "instructions").map((item) => `${item.tool}:${item.status}`)).toEqual(["claude-code:new", "codex:skipped"])
    expect(report.inPlace.join("\n")).toContain("~/.claude")
    expect(report.inPlace.join("\n")).toContain("1 skill")
    expect(report.notImported.join("\n")).toContain("permission rules")
    expect(JSON.stringify(report)).not.toContain(SECRET)
    expect(existsSync(path.join(dir, "mcp.json"))).toBe(false)
    expect(existsSync(path.join(dir, "commands"))).toBe(false)
    expect(existsSync(path.join(dir, "AGENTS.md"))).toBe(false)
    expect(existsSync(path.join(project, ".mendcode"))).toBe(false)
  })

  test("from narrows to one tool", async () => {
    const { project, service } = layout()
    const codex = await service.run({ directory: project, from: "codex", apply: false })
    expect(codex.items.every((item) => item.tool === "codex")).toBe(true)
    expect(codex.inPlace).toEqual([])
    expect(codex.items.filter((item) => item.kind === "instructions")[0]).toMatchObject({ tool: "codex", status: "new" })
    const claude = await service.run({ directory: project, from: "claude-code", apply: false })
    expect(claude.items.every((item) => item.tool === "claude-code")).toBe(true)
  })

  test("a machine with neither tool has nothing to import", async () => {
    const root = temp("mend-setup-none-")
    const service = createSetupImport({ dir: path.join(root, "data"), homes: { claude: path.join(root, ".claude"), codex: path.join(root, ".codex"), claudeJson: path.join(root, ".claude.json") } })
    const report = await service.run({ directory: root, from: "auto", apply: true })
    expect(report).toMatchObject({ applied: true, found: [], items: [], inPlace: [], notImported: [] })
  })

  test("an unreadable MendCode mcp.json is never overwritten", async () => {
    const { project, dir, service } = layout()
    write(path.join(dir, "mcp.json"), "{ not json")
    const report = await service.run({ directory: project, from: "claude-code", apply: true })
    expect(report.items.find((item) => item.name === "files")).toMatchObject({ status: "skipped", note: expect.stringContaining("unreadable") })
    expect(readFileSync(path.join(dir, "mcp.json"), "utf8")).toBe("{ not json")
  })
})

describe("setup import apply", () => {
  test("writes servers, commands and instructions with no secret and keeps what exists", async () => {
    const { project, dir, service } = layout()
    write(path.join(dir, "mcp.json"), JSON.stringify({ servers: { files: { command: "mine" } } }))
    const report = await service.run({ directory: project, from: "auto", apply: true })
    expect(report.applied).toBe(true)
    expect(JSON.stringify(report)).not.toContain(SECRET)
    const user = JSON.parse(readFileSync(path.join(dir, "mcp.json"), "utf8")).servers
    expect(user.files).toEqual({ command: "mine" })
    expect(user.docs).toEqual({ url: "https://docs.example.com/mcp", headers: { Authorization: "${DOCS_AUTHORIZATION}", "X-Team": "core" }, enabled: false })
    expect(user.search).toEqual({ command: "uvx", args: ["search-mcp"], env: { LOG: "info", SEARCH_KEY: "${SEARCH_KEY}", SEARCH_HOME: "${SEARCH_HOME}" }, timeoutMs: 30_000, enabled: false })
    expect(user.remote).toEqual({ url: "https://remote.example.com/mcp", headers: { Authorization: "Bearer ${REMOTE_TOKEN}" }, enabled: false })
    expect(readFileSync(path.join(dir, "mcp.json"), "utf8")).not.toContain(SECRET)
    const projectFile = readFileSync(path.join(project, ".mendcode", "mcp.json"), "utf8")
    expect(projectFile).not.toContain(SECRET)
    expect(JSON.parse(projectFile).servers.local).toEqual({ command: "bun", args: ["run", "mcp"] })
    expect(JSON.parse(projectFile).servers.shared).toEqual({ url: "https://shared.example.com/sse" })
    expect(readFileSync(path.join(dir, "commands", "review.md"), "utf8")).toContain("Review $ARGUMENTS")
    expect(existsSync(path.join(dir, "commands", "shelly.md"))).toBe(false)
    expect(readFileSync(path.join(dir, "AGENTS.md"), "utf8")).toBe("claude rules\n")
    expect(report.items.find((item) => item.name === "files" && item.tool === "claude-code")).toMatchObject({ status: "exists" })
  })

  test("env values keep plain settings and turn credentials into references", async () => {
    const { project, dir, service } = layout()
    await service.run({ directory: project, from: "claude-code", apply: true })
    expect(JSON.parse(readFileSync(path.join(dir, "mcp.json"), "utf8")).servers.files).toEqual({
      command: "npx", args: ["-y", "@scope/files", "/work"],
      env: { NODE_ENV: "production", API_TOKEN: "${API_TOKEN}", HOME_REF: "${HOME}", WITH_DEFAULT: "${REGION}" }, enabled: false,
    })
  })

  test("a credential given as the value of a separate flag argument is not copied", async () => {
    const { project, dir, homes, service } = layout()
    write(homes.claudeJson, JSON.stringify({ mcpServers: {
      spaced: { command: "tool", args: ["--password", "hunter2xyz"] },
      keyed: { command: "tool", args: ["serve", "--api-key", "abc123def456"] },
      referenced: { command: "tool", args: ["--token", "${MY_TOKEN}", "--port", "8080"] },
    } }))
    const report = await service.run({ directory: project, from: "claude-code", apply: true })
    expect(report.items.find((item) => item.name === "spaced")).toMatchObject({ status: "skipped" })
    expect(report.items.find((item) => item.name === "keyed")).toMatchObject({ status: "skipped" })
    expect(report.items.find((item) => item.name === "referenced")).toMatchObject({ status: "imported" })
    const stored = readFileSync(path.join(dir, "mcp.json"), "utf8")
    for (const value of ["hunter2xyz", "abc123def456"]) expect(stored).not.toContain(value)
  })

  test("running it twice changes nothing the second time", async () => {
    const { project, dir, service } = layout()
    await service.run({ directory: project, from: "auto", apply: true })
    const first = readFileSync(path.join(dir, "mcp.json"), "utf8")
    const again = await service.run({ directory: project, from: "auto", apply: true })
    expect(again.items.filter((item) => item.status === "imported")).toEqual([])
    expect(readFileSync(path.join(dir, "mcp.json"), "utf8")).toBe(first)
  })
})

describe("setup import selection", () => {
  const claudeFiles = { key: setupImportKey({ kind: "mcp", tool: "claude-code", scope: "user", name: "files" }), name: "files" }
  const codexSearch = setupImportKey({ kind: "mcp", tool: "codex", scope: "user", name: "search" })
  const projectLocal = setupImportKey({ kind: "mcp", tool: "claude-code", scope: "project", name: "local" })

  test("two chosen of many: exactly those two are written, nothing else, and the rest stays for later", async () => {
    const { project, dir, service } = layout()
    const preview = await service.run({ directory: project, from: "auto", apply: false })
    expect(preview.items.filter((item) => item.status === "new").length).toBeGreaterThan(4)
    const report = await service.run({ directory: project, from: "auto", apply: true, only: [codexSearch, projectLocal] })
    expect(report.items.filter((item) => item.status === "imported").map((item) => `${item.tool}:${item.scope}:${item.name}`).sort()).toEqual(["claude-code:project:local", "codex:user:search"])
    const user = JSON.parse(readFileSync(path.join(dir, "mcp.json"), "utf8")).servers
    expect(Object.keys(user)).toEqual(["search"])
    expect(JSON.parse(readFileSync(path.join(project, ".mendcode", "mcp.json"), "utf8")).servers).toEqual({ local: { command: "bun", args: ["run", "mcp"] } })
    expect(existsSync(path.join(dir, "commands"))).toBe(false)
    expect(existsSync(path.join(dir, "AGENTS.md"))).toBe(false)
    expect(JSON.stringify(report)).not.toContain(SECRET)
    const later = await service.run({ directory: project, from: "auto", apply: false })
    expect(later.items.filter((item) => item.status === "new").map((item) => item.name)).toContain("files")
    expect(later.items.find((item) => item.name === "search")).toMatchObject({ status: "exists" })
  })

  test("an empty selection writes nothing, a command or instructions are chosen by key like a server, and an unknown key is ignored", async () => {
    const { project, dir, service } = layout()
    const none = await service.run({ directory: project, from: "auto", apply: true, only: [] })
    expect(none.items.some((item) => item.status === "imported")).toBe(false)
    expect(existsSync(path.join(dir, "mcp.json"))).toBe(false)
    const review = setupImportKey({ kind: "command", tool: "codex", scope: "user", name: "review" })
    await service.run({ directory: project, from: "auto", apply: true, only: [review, "mcp:claude-code:user:not-there", "garbage"] })
    expect(readFileSync(path.join(dir, "commands", "review.md"), "utf8")).toContain("Review $ARGUMENTS")
    expect(existsSync(path.join(dir, "mcp.json"))).toBe(false)
    expect(existsSync(path.join(dir, "AGENTS.md"))).toBe(false)
    const rules = setupImportKey({ kind: "instructions", tool: "claude-code", scope: "user", name: "AGENTS.md" })
    await service.run({ directory: project, from: "auto", apply: true, only: [rules] })
    expect(readFileSync(path.join(dir, "AGENTS.md"), "utf8")).toBe("claude rules\n")
  })

  test("without a selection apply still writes everything new (the /import setup apply behaviour)", async () => {
    const { project, dir, service } = layout()
    const report = await service.run({ directory: project, from: "auto", apply: true })
    expect(report.items.filter((item) => item.status === "imported").length).toBeGreaterThan(4)
    expect(Object.keys(JSON.parse(readFileSync(path.join(dir, "mcp.json"), "utf8")).servers)).toContain(claudeFiles.name)
  })
})

describe("setup.import command", () => {
  test("the schema takes a directory, a tool, apply and a bounded list of keys only, and is not read-only", () => {
    const ids = createIdFactory()
    const base = { id: ids("command"), clientId: ids("client") }
    expect(Command.safeParse({ ...base, type: "setup.import", directory: "/p", apply: true, only: ["mcp:codex:user:a"] }).success).toBe(true)
    expect(Command.safeParse({ ...base, type: "setup.import", directory: "/p", apply: true, only: [] }).success).toBe(true)
    expect(Command.safeParse({ ...base, type: "setup.import", directory: "/p", only: [1] }).success).toBe(false)
    expect(Command.safeParse({ ...base, type: "setup.import", directory: "/p", only: Array.from({ length: 401 }, (_, i) => `k${i}`) }).success).toBe(false)
    expect(Command.safeParse({ ...base, type: "setup.import", directory: "/p" }).success).toBe(true)
    expect(Command.safeParse({ ...base, type: "setup.import", directory: "/p", from: "codex", apply: true }).success).toBe(true)
    expect(Command.safeParse({ ...base, type: "setup.import", directory: "/p", from: "vim" }).success).toBe(false)
    expect(Command.safeParse({ ...base, type: "setup.import", directory: "/p", path: "/etc" }).success).toBe(false)
    expect(isReadOnlyCommand("setup.import")).toBe(false)
  })

  test("a local client previews and applies; a remote client is refused", async () => {
    const { project, dir, homes } = layout()
    const saved = { claude: process.env.CLAUDE_CONFIG_DIR, codex: process.env.CODEX_HOME }
    // The daemon resolves the tools' homes from the environment; `.claude.json` sits in CLAUDE_CONFIG_DIR.
    write(path.join(homes.claude, ".claude.json"), readFileSync(homes.claudeJson, "utf8"))
    process.env.CLAUDE_CONFIG_DIR = homes.claude
    process.env.CODEX_HOME = homes.codex
    cleanups.push(() => { for (const [key, value] of [["CLAUDE_CONFIG_DIR", saved.claude], ["CODEX_HOME", saved.codex]] as const) { if (value === undefined) delete process.env[key]; else process.env[key] = value } })
    const data = temp("mend-setup-daemon-")
    const daemon = await startDaemon({ dir: data, socketPath: path.join(data, "mendd.sock"), listen: "127.0.0.1:0", engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
    cleanups.push(() => daemon.stop())
    const client = createClient({ socketPath: daemon.socketPath, name: "setup" })
    await client.connect()
    cleanups.push(() => client.close())
    const preview = await client.send({ type: "setup.import", directory: project, from: "claude-code" })
    expect(preview.ok).toBe(true)
    expect(existsSync(path.join(data, "mcp.json"))).toBe(false)
    const picked = await client.send({ type: "setup.import", directory: project, from: "claude-code", apply: true, only: [setupImportKey({ kind: "mcp", tool: "claude-code", scope: "project", name: "local" })] })
    expect(picked.ok ? (picked.result as { items: Array<{ status: string; name: string }> }).items.filter((item) => item.status === "imported").map((item) => item.name) : []).toEqual(["local"])
    expect(existsSync(path.join(data, "mcp.json"))).toBe(false)
    const applied = await client.send({ type: "setup.import", directory: project, from: "claude-code", apply: true })
    expect(applied.ok && (applied.result as { items: Array<{ status: string }> }).items.some((item) => item.status === "imported")).toBe(true)
    expect(existsSync(path.join(data, "mcp.json"))).toBe(true)
    expect(existsSync(path.join(dir, "mcp.json"))).toBe(false)
    const token = remoteTokens(data).create({ name: "full", readOnly: false }).token
    const remote = createClient({ name: "remote", remote: { hostname: "127.0.0.1", port: daemon.remotePort!, token } })
    await remote.connect()
    cleanups.push(() => remote.close())
    const refused = await remote.send({ type: "setup.import", directory: project, apply: true })
    expect(!refused.ok ? refused.error.code : "").toBe("forbidden")
  })
})
