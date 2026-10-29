import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { startDaemon } from "@mendcode/daemon"
import { helpText, parseAutomation, runAutomation, type AutomationDeps } from "../src/automation"
import { appHarness } from "./session-ui-harness"
import { textWidth } from "../src/view/wrap"

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })

test("project parser accepts all eleven operations and distinguishes package --version from global --version", () => {
  for (const operation of ["init", "config-show", "context-status", "context-refresh", "context-show", "focus-status", "focus-list", "package-show"]) expect(parseAutomation(["control-plane", "project", operation, "--dir", "/tmp/data", "--json"])).toMatchObject({ ok: true, command: { kind: "project", input: { operation }, dir: "/tmp/data", json: true } })
  expect(parseAutomation(["control-plane", "project", "focus-show"])).toMatchObject({ ok: true, command: { input: { operation: "focus-show" } } })
  expect(parseAutomation(["control-plane", "project", "focus-use", "claude"])).toMatchObject({ ok: true, command: { input: { operation: "focus-use", focusID: "claude" } } })
  expect(parseAutomation(["control-plane", "project", "package-set", "--version", "2.1", "--title=", "--description", "sample", "--kind", "bundle", "--channel", "stable", "--id", "test", "--source-type", "git", "--source-url", "https://example.test", "--compat-mendcode", ">=2", "--compat-runtime-pack", "native", "--data-dir", "/tmp/data"])).toMatchObject({ ok: true, command: { dir: "/tmp/data", input: { operation: "package-set", patch: { version: "2.1", title: "", description: "sample", kind: "bundle", channel: "stable", id: "test", sourceType: "git", sourceURL: "https://example.test", compatMendcode: ">=2", compatRuntimePack: "native" } } } })
  expect(parseAutomation(["--version"])).toMatchObject({ ok: true, command: { kind: "version" } })
  expect(parseAutomation(["control-plane", "project", "config-show", "--version"])).toMatchObject({ ok: true, command: { kind: "version" } })
  expect(parseAutomation(["control-plane", "project", "--help"])).toMatchObject({ ok: true, command: { kind: "help", topic: "project" } })
  expect(helpText("project")).toContain("focus-use ID")
})

test("project parser rejects missing/invalid focus, unrelated flags, excessive arguments and empty metadata patches", () => {
  for (const args of [["focus-use"], ["focus-show", "unknown"], ["focus-use", "codex", "extra"], ["context-refresh", "extra"], ["config-show", "--title", "unexpected"], ["package-set"], ["package-set", "--version"], ["package-set", "--id", "x".repeat(501)], ["sync"]]) expect(parseAutomation(["control-plane", "project", ...args])).toMatchObject({ ok: false })
})

test("all project automation commands use the daemon and preserve v1 human output and v2 JSON envelopes", async () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-b43-cli-")))
  const project = path.join(dir, "project")
  const { mkdirSync } = await import("node:fs")
  mkdirSync(project)
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), log: () => {}, engine: ({ clock }) => createFauxEngine({ clock }) })
  cleanup.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "b43-cli" })
  await client.connect()
  cleanup.push(() => client.close())
  let output = "", errors = ""
  const deps: AutomationDeps = { client, cwd: project, now: () => Date.now(), out: { write: (text) => { output += text } }, err: { write: (text) => { errors += text } }, listen() {}, onInterrupt() {} }
  const run = async (...args: string[]) => {
    const parsed = parseAutomation(["control-plane", "project", ...args])
    if (parsed.ok !== true) throw new Error(JSON.stringify(parsed))
    output = ""
    expect(await runAutomation(parsed.command, deps)).toBe(0)
    return output
  }
  expect(await run("init")).toBe("initialized .mendcode\n")
  expect(await run("context-refresh")).toContain("refreshed .mendcode/context/summary.md")
  expect(await run("context-show")).toContain("# MendCode Context Summary")
  expect(await run("focus-use", "kimi")).toBe("active focus: kimi\n")
  expect(await run("focus-list")).toContain("codex\tCodex optimized")
  for (const operation of ["config-show", "context-status", "focus-status", "focus-show", "package-show"]) {
    const result = JSON.parse(await run(operation, "--json"))
    expect(result).toMatchObject({ schema: "mendcode-next.cli.v1", kind: "result", command: "project" })
    expect(result.data).toBeDefined()
  }
  expect(JSON.parse(await run("package-set", "--title", "Fixture", "--version", "2.0", "--json")).data).toMatchObject({ title: "Fixture", version: "2.0" })
  expect(errors).toBe("")
  expect(await client.send({ type: "session.list" })).toMatchObject({ ok: true, result: { sessions: [] } })
}, 30_000)

test("external skill load/toggle and project focus render through the app factories at all target widths", async () => {
  const { mkdirSync, writeFileSync } = await import("node:fs")
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-b43-ui-")))
  const project = path.join(dir, "project")
  const skills = path.join(dir, "external-skills")
  mkdirSync(project)
  mkdirSync(path.join(skills, "review"), { recursive: true })
  writeFileSync(path.join(skills, "review", "SKILL.md"), "---\nname: review\ndescription: External API review\n---\nRead contracts and callers")
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), log: () => {}, engine: ({ clock }) => createFauxEngine({ clock }) })
  cleanup.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "b43-ui" })
  await client.connect()
  cleanup.push(() => client.close())
  await client.send({ type: "settings.set", patch: { skills: { paths: [skills] } } })
  await client.projectControl(project, { operation: "focus-use", focusID: "claude" })
  for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) {
    const h = appHarness({ width, height, directory: project, dataDir: dir, reply: (command) => ["prompt.status", "prompt.set", "skills.list", "skills.load", "skills.set"].includes(command.type) ? client.send(command) : { ok: true } })
    h.app.applySettings({ onboarded: true })
    await h.type("/skills\r")
    await h.type("review")
    expect(h.app.page).toBe("skills")
    expect(h.text().join("\n")).toContain("External API review")
    expect(h.text().some((row) => row.includes("┌") || row.includes("┏"))).toBe(true)
    await h.app.onKey("\x0c")
    h.app.render()
    expect(h.text().join("\n")).toContain("Read contracts and callers")
    expect(h.text().length).toBe(height)
    expect(h.text().every((row) => textWidth(row) <= width)).toBe(true)
    await h.app.onKey("\x1b")
    await h.app.onKey("\r")
    expect(await client.send({ type: "skills.load", directory: project, name: "review" })).toMatchObject({ ok: false })
    await h.app.onKey("\r")
    await h.app.onKey("\x1b")
    await h.type("/prompt-mode\r")
    await h.app.onKey("2")
    h.app.render()
    expect(h.app.page).toBe("prompt-mode")
    expect(h.text().join("\n")).toContain("claude")
    expect(h.text().every((row) => textWidth(row) <= width)).toBe(true)
    await h.app.onKey("\x03")
  }
}, 30_000)
