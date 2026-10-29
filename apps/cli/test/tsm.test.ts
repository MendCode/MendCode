import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { parseAutomation, runAutomation, EXIT, helpText, HELP } from "../src/automation"
import { completionScript } from "../src/support-output"
import { renderTsmPage, type TsmPageState } from "../src/view/tsm-page"
import { textWidth } from "../src/view/wrap"
import { b72Harness, b72Report } from "./b72-fixtures"
import { cleanTemps, tempDir } from "./session-ui-harness"

afterEach(cleanTemps)
describe("B72 TSM automation", () => {
  test("all eight v1 operations parse standalone/control-plane with data/project flags and mux", () => {
    for (const prefix of [[], ["control-plane"]]) for (const operation of ["status", "plan", "install", "setup", "activate", "deactivate", "remove", "doctor"]) {
      expect(parseAutomation(["--dir", "/tmp/data", ...prefix, "tsm", operation, "--project", "/tmp/project", "--json"])).toMatchObject({ ok: true, command: { kind: "tsm", dir: "/tmp/data", projectDir: "/tmp/project", json: true, request: { type: ["status", "doctor"].includes(operation) ? "tsm.query" : "tsm.change" } } })
    }
    expect(parseAutomation(["control-plane", "tsm", "activate", "--mux=kitty"])).toMatchObject({ ok: true, command: { request: { change: { operation: "activate", muxBackend: "kitty" } } } })
    expect(parseAutomation(["tsm"])).toMatchObject({ ok: true, command: { request: { query: { operation: "status" } } } })
    expect(parseAutomation(["tsm", "--help"])).toMatchObject({ ok: true, command: { kind: "help", topic: "tsm" } })
    expect(helpText("tsm")).toContain("dry-run")
    expect(HELP).toContain("tsm <status")
    for (const shell of ["bash", "zsh"] as const) expect(completionScript(shell)).toContain("tsm) ")
  })
  test("adapter open/create are pure previews; invalid or execution arguments fail", () => {
    expect(parseAutomation(["tsm", "open", "mend/client"])).toMatchObject({ ok: true, command: { request: { type: "tsm.query", query: { operation: "open", target: "mend/client" } } } })
    expect(parseAutomation(["tsm", "create", "Client", "--branch", "mend/client", "--base=main", "--path", "../client", "--focus", "claude"])).toMatchObject({ ok: true, command: { request: { query: { operation: "create", input: { name: "Client", branch: "mend/client", base: "main", path: "../client", focus: "claude" } } } } })
    for (const args of [["status", "extra"], ["open"], ["activate", "--mux", "tmux"], ["status", "--mux", "kitty"], ["setup", "--execute"], ["remove", "--force"], ["create", "x".repeat(101)], ["open", "bad\n"], ["plan", "--base", "main"], ["activate", "--mux"], ["typo"]]) expect(parseAutomation(["tsm", ...args]).ok).toBe(false)
  })
  test("runner routes writes/queries, emits existing envelopes and reports daemon/degraded failures", async () => {
    for (const operation of ["status", "plan", "install", "setup", "activate", "deactivate", "remove", "doctor"]) {
      const parsed = parseAutomation(["control-plane", "tsm", operation, "--project", "/tmp/project", "--json"])
      if (parsed.ok !== true) throw new Error("Parse failed")
      const report = b72Report(operation === "doctor" ? "degraded" : "installed-inactive")
      let output = "", sent = ""
      const code = await runAutomation(parsed.command, { cwd: "/tmp/other", now: () => 0, onInterrupt() {}, listen() {}, out: { write: (value) => { output += value } }, err: { write() {} }, client: { send: async (command) => { expect(command).toMatchObject({ directory: "/tmp/project" }); sent = command.type; return { ok: true, result: report } }, subscribe: async () => ({ ok: true }) } })
      expect(code).toBe(report.ok ? EXIT.ok : EXIT.failed)
      expect(sent).toBe(["status", "doctor"].includes(operation) ? "tsm.query" : "tsm.change")
      expect(JSON.parse(output)).toMatchObject({ kind: "result", command: "tsm", data: { lifecycle: report.lifecycle } })
    }
    const parsed = parseAutomation(["tsm", "activate"])
    if (parsed.ok !== true) throw new Error("Parse failed")
    let error = ""
    const code = await runAutomation(parsed.command, { cwd: "/tmp/project", now: () => 0, onInterrupt() {}, listen() {}, out: { write() {} }, err: { write: (value) => { error += value } }, client: { send: async () => ({ ok: false, error: { code: "invalid_command", message: "Cannot activate TSM: binary not found" } }), subscribe: async () => ({ ok: true }) } })
    expect(code).toBe(EXIT.failed)
    expect(error).toContain("Cannot activate TSM")
  })
})
describe("B72 app factories and panel grid", () => {
  test("Tab only completes /tsm; actions/details and workspace open preserve the conversation", async () => {
    const h = b72Harness()
    try {
      await h.type("/ts\t")
      expect(h.sentOf("tsm.query")).toHaveLength(0)
      await h.type("\r")
      expect(h.text().join("\n")).toContain("TSM · installed-inactive")
      await h.keys("\x1b[B", "\r")
      expect(h.text().join("\n")).toContain("Base checkout: /work/mendcode")
      await h.reopen("/tsm open main")
      expect(h.text().join("\n")).toContain("TSM integration is not active")
      expect(h.sentOf("session.create")).toHaveLength(0)
      expect(h.sentOf("session.get")).toHaveLength(0)
      expect(h.subscriptions).toHaveLength(0)
    } finally { await h.app.onKey("\x03") }
  })
  test("setup plan and activation mux work through the action menu; deactivation is persistent", async () => {
    const h = b72Harness()
    try {
      await h.type("/tsm\r")
      await h.keys(...Array(3).fill("\x1b[B"), "\r")
      expect(h.text().join("\n")).toContain("brew install")
      expect(h.sentOf("tsm.change")[0]).toMatchObject({ change: { operation: "plan" } })
      await h.keys("\t", "\x1b[B", "\r")
      expect(h.sentOf("tsm.change")[1]).toMatchObject({ change: { operation: "setup" } })
      await h.keys("\t", "\x1b[B", "m", "\r")
      expect(h.sentOf("tsm.change")[2]).toMatchObject({ change: { operation: "activate", muxBackend: "cmux" } })
      expect(h.report()).toMatchObject({ enabled: true, defaultMuxBackend: "cmux" })
      await h.keys("\t", "\x1b[B", "\r")
      expect(h.report().enabled).toBe(false)
      expect(h.sentOf("tsm.change")[3]).toMatchObject({ change: { operation: "deactivate" } })
    } finally { await h.app.onKey("\x03") }
  })
  test("remove requires explicit confirmation in menu and slash, cancel preserves scaffold", async () => {
    const h = b72Harness()
    try {
      await h.type("/tsm setup\r")
      await h.reopen()
      await h.keys(...Array(7).fill("\x1b[B"), "\r")
      expect(h.text().join("\n")).toContain("Remove scaffold?")
      expect(h.sentOf("tsm.change")).toHaveLength(1)
      await h.keys("n")
      expect(h.report().plan).toBeDefined()
      await h.reopen("/tsm remove")
      expect(h.sentOf("tsm.change")).toHaveLength(1)
      await h.keys("y")
      expect(h.sentOf("tsm.change")[1]).toMatchObject({ change: { operation: "remove" } })
      expect(h.text().join("\n")).toContain("Scaffold recycled")
      expect(h.report().plan).toBeUndefined()
    } finally { await h.app.onKey("\x03") }
  })
  test("doctor, disabled activation, malformed args and errors remain inside the page", async () => {
    const h = b72Harness()
    h.setReport(b72Report("not-installed"))
    try {
      await h.type("/tsm\r")
      await h.keys(...Array(5).fill("\x1b[B"), "\r")
      expect(h.sentOf("tsm.change")).toHaveLength(0)
      expect(h.text().join("\n")).toContain("Activation requires")
      await h.keys("d")
      expect(h.text().join("\n")).toContain("Doctor")
      h.error("TSM registry unavailable")
      await h.keys("r")
      expect(h.text().join("\n")).toContain("TSM registry unavailable")
      await h.reopen("/tsm typo")
      expect(h.text().join("\n")).toContain("Unknown TSM operation")
    } finally { await h.app.onKey("\x03") }
  })
  test("read-only mode sends no executable probes or scaffold mutations", async () => {
    const h = b72Harness(60, 20, true)
    try {
      await h.type("/tsm activate\r")
      expect(h.text().join("\n")).toContain("read-only mode")
      await h.reopen("/tsm remove")
      expect(h.text().join("\n")).not.toContain("Remove scaffold?")
      expect(h.sentOf("tsm.query")).toHaveLength(0)
      expect(h.sentOf("tsm.change")).toHaveLength(0)
    } finally { await h.app.onKey("\x03") }
  })
  test("all page states fit every breakpoint, with borders, header hints and no leaked footer", () => {
    for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) for (const section of ["status", "workspace", "details", "plan", "doctor", "preview"] as const) {
      const state: TsmPageState = { selected: 0, scroll: 0, detailsFocused: section !== "status", section, mux: "auto", readOnly: false, report: b72Report() }
      const rows = renderTsmPage({ state, width: width!, height: height! })
      const text = rows.map((line) => line.map((span) => span.text).join(""))
      expect(rows).toHaveLength(height!)
      expect(text.every((line) => textWidth(line) === width)).toBe(true)
      expect(text[0]).toContain("esc")
      expect(text.at(-1)).toContain("┘")
      expect(text.join("\n")).not.toMatch(/ready|start of session|no diagram/)
      if (width! < 70) expect(text[2]!.match(/┌/g)).toHaveLength(1)
    }
  })
  test("TSM stays lazy and the startup module graph stays free of schemas", () => {
    const dir = tempDir("mendcode-b72-footprint-")
    const result = Bun.spawnSync(["bun", "-e", `await import('./src/ui/app'); const has = () => Object.keys(require.cache).some(k => k.endsWith('/view/tsm-page.ts')); const before = has(); const pages = await import('./src/ui/lazy-pages'); await pages.preload('tsm'); console.log(JSON.stringify({before, after: has(), zod: Object.keys(require.cache).filter(k => k.includes('/zod/')).length}))`], { cwd: path.join(import.meta.dir, ".."), env: { ...process.env, MENDCODE_DATA_DIR: dir }, stdout: "pipe", stderr: "pipe" })
    expect(result.exitCode).toBe(0)
    expect(result.stderr.toString()).toBe("")
    expect(JSON.parse(result.stdout.toString())).toEqual({ before: false, after: true, zod: 0 })
  })
})
