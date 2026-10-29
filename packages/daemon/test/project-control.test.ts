import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import type { ProjectControlInput } from "@mendcode/protocol"
import { isReadOnlyCommand } from "@mendcode/protocol/wire"
import { startDaemon } from "../src"
import { createProjectControl, projectSources } from "../src/project-control"

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
function temp() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-b43-")))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
function put(root: string, file: string, text: string) {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
  writeFileSync(path.join(root, file), text)
}
async function fixture() {
  const dir = temp(), project = temp()
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), log: () => {}, engine: ({ clock }) => createFauxEngine({ clock }) })
  cleanup.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "b43" })
  await client.connect()
  cleanup.push(() => client.close())
  const run = async (input: ProjectControlInput) => {
    const reply = await client.projectControl(project, input)
    if (!reply.ok) throw new Error(reply.error.message)
    return reply.result!
  }
  return { dir, project, client, run }
}

test("project init is additive, idempotent and preserves focus, model settings and existing project files", async () => {
  const h = await fixture()
  put(h.project, ".mendcode/context/project.md", "Keep my context")
  await h.client.send({ type: "settings.set", patch: { models: { main: { model: "unchanged", effort: "high" } } } })
  await h.run({ operation: "focus-use", focusID: "claude" })
  expect(await h.run({ operation: "init" })).toMatchObject({ initialized: ".mendcode", focus: "claude", modelChanged: false })
  expect(readFileSync(path.join(h.project, ".mendcode/context/project.md"), "utf8")).toBe("Keep my context")
  const first = readFileSync(path.join(h.project, ".mendcode/project.json"), "utf8")
  expect(await h.run({ operation: "init" })).toMatchObject({ created: [] })
  expect(readFileSync(path.join(h.project, ".mendcode/project.json"), "utf8")).toBe(first)
  expect(existsSync(path.join(h.project, ".mendcode/focus"))).toBe(false)
  expect(existsSync(path.join(h.project, ".mendcode/memory"))).toBe(true)
  expect(existsSync(path.join(h.project, ".mendcode/budget"))).toBe(false)
  expect(JSON.parse(first)).not.toHaveProperty("budgets")
  expect(JSON.parse(first)).not.toHaveProperty("memory")
  expect(JSON.parse(first)).not.toHaveProperty("focus")
  expect(await h.client.send({ type: "settings.get" })).toMatchObject({ ok: true, result: { settings: { models: { main: { model: "unchanged", effort: "high" } } } } })
  expect(existsSync(path.join(h.project, ".agents"))).toBe(false)
})

test("focus list/show/status/use persist independently from models and reject unknown IDs", async () => {
  const h = await fixture()
  expect(await h.run({ operation: "focus-list" })).toMatchObject({ profiles: [{ id: "auto" }, { id: "codex" }, { id: "claude" }, { id: "gemini" }, { id: "kimi" }, { id: "deepseek" }, { id: "mistral" }, { id: "glm" }, { id: "minimax" }, { id: "grok" }, { id: "local" }] })
  // A project that never chose a family follows its model; the faux test engine's model belongs to no family.
  expect(await h.run({ operation: "focus-show" })).toMatchObject({ id: "neutral", requested: "auto" })
  expect(await h.run({ operation: "focus-status" })).toMatchObject({ active: "auto", resolved: "neutral" })
  const description = await h.run({ operation: "focus-show", focusID: "codex" })
  expect(description).toMatchObject({ id: "codex", promptPolicy: { contextFiles: ["AGENTS.md", ".agents/context.md", ".agents/global/context.md", ".mendcode/context/project.md"], behavior: expect.stringContaining("Respect sandbox and approval boundaries") } })
  for (const key of ["agent", "model", "reasoning", "tools", "sessionPolicy", "worktreePolicy", "budgetPolicy"]) expect(description).not.toHaveProperty(key)
  expect(await h.run({ operation: "focus-use", focusID: "gemini" })).toMatchObject({ active: "gemini" })
  expect(await h.run({ operation: "focus-status" })).toMatchObject({ active: "gemini", profile: { id: "gemini", promptPolicy: { contextFiles: ["GEMINI.md", "AGENTS.md", ".mendcode/context/project.md"] } } })
  expect(await h.client.promptStatus(h.project)).toMatchObject({ ok: true, result: { focusID: "gemini" } })
  expect(await createProjectControl({ dir: h.dir, settings: () => ({}) }).run(h.project, { operation: "focus-show" })).toMatchObject({ id: "gemini" })
  expect(await h.run({ operation: "focus-use", focusID: "auto" })).toMatchObject({ active: "auto" })
  expect(await h.client.promptStatus(h.project, "anthropic:claude-sonnet-5-5")).toMatchObject({ ok: true, result: { focusID: "auto", resolvedFocus: "claude" } })
  expect(await h.client.promptStatus(h.project, "gpt-6-sol")).toMatchObject({ ok: true, result: { focusID: "auto", resolvedFocus: "codex" } })
  expect(await h.client.promptStatus(h.project)).toMatchObject({ ok: true, result: { resolvedFocus: "neutral" } })
  expect(await h.client.send({ type: "project.control", directory: h.project, input: { operation: "focus-use", focusID: "invalid" } } as never)).toMatchObject({ ok: false, error: { code: "invalid_command" } })
  expect(await h.client.send({ type: "session.list" })).toMatchObject({ ok: true, result: { sessions: [] } })
})

test("init preserves legacy focus, budget and project metadata byte-for-byte", async () => {
  const h = await fixture()
  const files = {
    ".mendcode/project.json": '{"memory":{"enabled":false},"focus":{"default":"kimi"},"budgets":{"mode":"subscription"}}\n',
    ".mendcode/focus/kimi.json": '{"model":"owned","worktreePolicy":{"mode":"lock-only"}}\n',
    ".mendcode/budget/spend-state.json": '{"telemetry":{"currentUsd":7}}\n',
  }
  for (const [file, text] of Object.entries(files)) put(h.project, file, text)
  await h.run({ operation: "init" })
  for (const [file, text] of Object.entries(files)) expect(readFileSync(path.join(h.project, file), "utf8")).toBe(text)
})

test("context refresh/show detect same-sized edits, removals and local script/dependency inventory", async () => {
  const h = await fixture()
  put(h.project, "AGENTS.md", "first")
  utimesSync(path.join(h.project, "AGENTS.md"), new Date(1_700_000_000_000), new Date(1_700_000_000_000))
  put(h.project, "docs/api.md", "docs")
  put(h.project, "package.json", JSON.stringify({ name: "sample", scripts: { test: "do not execute" }, dependencies: { local: "1" } }))
  expect(await h.run({ operation: "context-status" })).toMatchObject({ summary: null, generatedAt: null })
  const shown = await h.run({ operation: "context-show" })
  expect(String(shown.text)).toContain("AGENTS.md (5 bytes)")
  const status = await h.run({ operation: "context-status" })
  expect(status).toMatchObject({ level: 2, packageScripts: ["test"], packageDependencies: ["local"], docs: ["docs/api.md"] })
  const info = (status.files as Array<{ path: string; mtimeMs: number }>).find((file) => file.path === "AGENTS.md")!
  writeFileSync(path.join(h.project, "AGENTS.md"), "later")
  utimesSync(path.join(h.project, "AGENTS.md"), new Date(info.mtimeMs), new Date(info.mtimeMs))
  await h.run({ operation: "context-refresh" })
  expect(await h.run({ operation: "context-status" })).toMatchObject({ changed: ["AGENTS.md"] })
  const changed = await h.run({ operation: "context-status" })
  expect((changed.files as Array<{ path: string; mtimeMs: number }>).find((file) => file.path === "AGENTS.md")?.mtimeMs).toBe(info.mtimeMs)
  rmSync(path.join(h.project, "AGENTS.md"))
  await h.run({ operation: "context-refresh" })
  expect(await h.run({ operation: "context-status" })).toMatchObject({ changed: ["AGENTS.md"] })
  expect(String((await h.run({ operation: "context-show" })).text)).toContain("Missing optional inputs")
})

test("package metadata patches only supplied fields, clears empty values and reports invalid config", async () => {
  const h = await fixture()
  put(h.project, "package.json", JSON.stringify({ name: "fallback", description: "package description" }))
  put(h.project, ".mendcode/project.json", JSON.stringify({ preserved: 7, package: { version: "2.0", source: { type: "git" }, selection: { tools: ["review"] } } }))
  expect(await h.run({ operation: "package-show" })).toMatchObject({ title: "fallback", version: "2.0", channel: "local", selection: { tools: ["review"] } })
  expect(await h.run({ operation: "package-set", patch: { id: "test", title: "Sample", description: "Owned", kind: "bundle", channel: "stable", sourceURL: "https://example.test", compatMendcode: ">=2", compatRuntimePack: "native" } })).toMatchObject({ id: "test", source: { type: "git", url: "https://example.test" }, compatibility: { mendcode: ">=2", runtimePack: "native" } })
  expect(await h.run({ operation: "package-set", patch: { title: "", sourceURL: "" } })).toMatchObject({ title: "fallback", description: "Owned", version: "2.0", source: { type: "git" } })
  expect(JSON.parse(readFileSync(path.join(h.project, ".mendcode/project.json"), "utf8")).preserved).toBe(7)
  put(h.project, ".mendcode/project.json", "{broken")
  expect(await h.client.projectControl(h.project, { operation: "config-show" })).toMatchObject({ ok: false, error: { code: "invalid_command" } })
})

test("settings and project local sources feed full prompt builds and skill loading live; URLs stay blocked", async () => {
  const h = await fixture(), external = temp()
  put(h.project, "rules/a.md", "Local unique instructions")
  put(external, "outside.md", "User configured instructions")
  put(external, "nested/review/SKILL.md", "---\nname: review\ndescription: external review\n---\nRead callers carefully")
  put(h.project, ".mendcode/project.json", JSON.stringify({ instructions: ["rules/*.md", "rules/a.md", "https://example.test/rules"], skills: { urls: ["https://example.test/skills"] } }))
  expect(await h.client.send({ type: "settings.set", patch: { instructions: [path.join(external, "outside.md")], skills: { paths: [external] } } })).toMatchObject({ ok: true })
  const build = await h.client.promptBuild(h.project, { mode: "full", showFull: true })
  expect(build.ok).toBe(true)
  const text = String(build.ok && build.result?.instructions)
  expect(text).toContain("User configured instructions")
  expect(text.split("Local unique instructions").length).toBe(2)
  expect(text).toContain("review: external review")
  expect(await h.client.send({ type: "skills.load", directory: h.project, name: "review" })).toMatchObject({ ok: true, result: { body: "Read callers carefully" } })
  const config = await h.run({ operation: "config-show" })
  expect(config.sources).toMatchObject({ blocked: [{ path: "https://example.test/rules" }, { path: "https://example.test/skills" }] })
  await h.client.send({ type: "skills.set", directory: h.project, name: "review", enabled: false })
  const disabled = await h.client.promptBuild(h.project, { mode: "full", showFull: true })
  expect(String(disabled.ok && disabled.result?.instructions)).not.toContain("review: external review")
}, 30_000)

test("project writes reject symlink escapes and project sources cannot grant external reads; RPC is not read-only", async () => {
  const dir = temp(), project = temp(), external = temp()
  symlinkSync(external, path.join(project, ".mendcode"))
  const service = createProjectControl({ dir, settings: () => ({}) })
  await expect(service.run(project, { operation: "init" })).rejects.toThrow("Project writes must stay inside")
  expect(readdir(external)).toEqual([])
  const other = temp()
  put(other, ".mendcode/project.json", JSON.stringify({ instructions: [path.join(external, "secret.md")], skills: { paths: [external] } }))
  const sources = projectSources(other, {})
  expect(sources.instructions).toEqual([])
  expect(sources.skills).toEqual([])
  expect(sources.blocked.length).toBe(2)
  const parent = temp(), scoped = path.join(parent, "repo")
  put(parent, "rules/outside.md", "Outside project rules")
  put(scoped, "rules/inside.md", "Inside project rules")
  put(scoped, ".mendcode/project.json", JSON.stringify({ instructions: ["rules/*.md"] }))
  expect(service.instructions(scoped)).toContain("Inside project rules")
  expect(service.instructions(scoped)).not.toContain("Outside project rules")
  expect(isReadOnlyCommand("project.control")).toBe(false)
})

function readdir(dir: string) { return Array.from(new Bun.Glob("**/*").scanSync({ cwd: dir })) }

test("an https instruction URL in the user's settings reaches the prompt from its downloaded copy; project URLs and http stay blocked", async () => {
  const { remoteInstructions, REMOTE_INSTRUCTIONS_DIR } = await import("../src/remote-instructions")
  const dir = temp(), project = temp()
  const pages: Record<string, () => Response> = {
    "https://rules.example/team.md": () => new Response("Team rule: always run the linter"),
    "https://rules.example/huge.md": () => new Response("x".repeat(70 * 1024)),
    "https://rules.example/moved.md": () => Object.defineProperty(new Response("insecure"), "url", { value: "http://rules.example/moved.md" }),
  }
  let fail = false
  let clock = 1_000_000
  const logged: string[] = []
  const cache = remoteInstructions(dir, { fetch: async (url) => { if (fail) throw new Error("offline"); return pages[url]?.() ?? new Response("missing", { status: 404 }) }, now: () => clock, log: (line) => logged.push(line) })
  const settings = { instructions: ["https://rules.example/team.md", "https://rules.example/huge.md", "https://rules.example/moved.md", "http://rules.example/plain.md"] }
  await cache.prefetch(settings.instructions)
  put(project, ".mendcode/project.json", JSON.stringify({ instructions: ["https://rules.example/project.md"] }))
  const sources = projectSources(project, settings, cache.pathFor)
  expect(sources.instructions.map((file) => path.relative(path.join(dir, REMOTE_INSTRUCTIONS_DIR), file))).toEqual([expect.stringMatching(/^rules\.example_team\.md-[0-9a-f]{8}\.md$/)])
  expect(sources.blocked.map((entry) => entry.path).sort()).toEqual(["http://rules.example/plain.md", "https://rules.example/project.md"])
  expect(logged.join("\n")).toMatch(/huge\.md: not downloaded \(larger than 64 KB\)/)
  expect(logged.join("\n")).toMatch(/moved\.md: not downloaded \(redirected away from https\)/)
  const service = createProjectControl({ dir, settings: () => settings })
  expect(service.instructions(project)).toContain("Team rule: always run the linter")
  // A failed refresh later keeps the last good copy.
  fail = true
  clock += 11 * 60_000
  await cache.prefetch(settings.instructions)
  expect(service.instructions(project)).toContain("Team rule: always run the linter")
  expect(logged.join("\n")).toMatch(/team\.md: not downloaded \(offline\); the last copy stays/)
})
