import { afterEach, describe, expect, test } from "bun:test"
import { parseAutomation, runAutomation, EXIT, helpText } from "../src/automation"
import { preload } from "../src/ui/lazy-pages"
import { renderMflowPage } from "../src/view/mflow-page"
import { textWidth } from "../src/view/wrap"
import { b73Harness, b73Report } from "./b73-fixtures"
import { cleanTemps, NOW, ids, conversation } from "./session-ui-harness"

afterEach(cleanTemps)
describe("B73 automation", () => {
  test("all audited operations parse standalone and control-plane with exact data/project flags", () => {
    for (const prefix of [[], ["control-plane"]]) for (const operation of ["status", "activate", "deactivate", "remove", "setup", "scan", "relay-guide", "plan", "doctor", "legacy-status", "start", "stop"]) {
      expect(parseAutomation(["--dir", "/tmp/data", ...prefix, "mflow", operation, "--project", "/tmp/project", "--json"])).toMatchObject({ ok: true, command: { kind: "mflow", dir: "/tmp/data", projectDir: "/tmp/project", json: true } })
    }
    expect(parseAutomation(["control-plane", "mflow", "activate", "--room=team/source", "--url", "http://127.0.0.1:8787", "--token-file", "/tmp/private", "--priority", "7"])).toMatchObject({ ok: true, command: { request: { change: { input: { room: "team/source", signaling: "http://127.0.0.1:8787", tokenFile: "/tmp/private", hookPriority: 7 } } } } })
    expect(helpText("control-plane")).toContain("mflow")
    expect(parseAutomation(["mflow", "--help"])).toMatchObject({ ok: true, command: { kind: "help", topic: "mflow" } })
  })
  test("invalid operations/options cannot silently enable public relays, echo secrets or alter other operations", () => {
    for (const args of [["activate", "--relay", "public"], ["activate", "--secret", "private-data"], ["activate", "--priority", "10"], ["setup", "--room", " "], ["setup", "--room", "x".repeat(201)], ["scan", "--room", "other"], ["activate", "--url"], ["status", "extra"], ["typo"], ["remove", "--force"], ["activate", "--room", "line\nbreak"]]) {
      const result = parseAutomation(["mflow", ...args])
      expect(result.ok).toBe(false)
      expect(JSON.stringify(result)).not.toContain("private-data")
    }
  })
  test("runner sends the daemon request and preserves JSON envelope and failure exit code", async () => {
    for (const operation of ["status", "activate", "deactivate", "remove", "setup", "scan", "relay-guide", "plan", "doctor", "legacy-status"]) {
      const parsed = parseAutomation(["mflow", operation, "--json", "--project", "/tmp/project"])
      if (parsed.ok !== true) throw new Error("Parse failed")
      const report = b73Report()
      report.ok = operation !== "doctor"
      let output = "", error = ""
      const sent: string[] = []
      const code = await runAutomation(parsed.command, { cwd: "/tmp/other", now: () => NOW, onInterrupt() {}, listen() {}, out: { write: (text) => { output += text } }, err: { write: (text) => { error += text } }, client: { send: async (command) => { expect(command).toMatchObject({ directory: "/tmp/project" }); sent.push(command.type); return { ok: true, result: report as unknown as Record<string, never> } }, subscribe: async () => ({ ok: true }) } })
      expect(code).toBe(report.ok ? EXIT.ok : EXIT.failed)
      expect(JSON.parse(output)).toMatchObject({ kind: "result", command: "mflow", data: { ok: report.ok } })
      expect(sent).toEqual([["activate", "deactivate", "remove", "setup", "plan"].includes(operation) ? "mflow.change" : "mflow.query"])
      expect(error).toBe("")
    }
  })
})
describe("B73 app factory and panel grid", () => {
  test("Tab completes without running; Enter opens the page lazily and page hints stay in the header", async () => {
    const h = b73Harness()
    try {
      await h.type("/mf\t")
      expect(h.sentOf("mflow.query")).toHaveLength(0)
      await h.type("\r")
      const frame = h.text().join("\n")
      expect(frame).toContain("Mflow")
      expect(frame).toContain("Configure and turn on")
      expect(frame).toContain("┌")
      expect(h.text()[0]).toContain("esc")
      expect(frame).not.toContain("start of session")
      expect(h.sentOf("mflow.query")).toHaveLength(1)
    } finally { await h.app.onKey("\x03") }
  })
  test("configuration edits in the page; activation, start/stop/off and remove confirmation are real commands", async () => {
    const h = b73Harness()
    try {
      await h.type("/mflow setup\r")
      expect(h.sentOf("mflow.change")).toHaveLength(0)
      await h.type("\x15team/source\t\t\t\x157\r")
      expect(h.sentOf("mflow.change")[0]).toMatchObject({ change: { operation: "activate", input: { room: "team/source", signaling: "embedded", hookPriority: 7 } } })
      await h.type("\x1b[B\r")
      expect(h.report().mode).toBe("running")
      expect(h.text().join("\n")).toContain("src/client/connection.ts")
      await h.type("\x1b[B\r")
      expect(h.report().mode).toBe("enabled-stopped")
      await h.type("\x1b[B\r")
      expect(h.report().mode).toBe("disabled")
      await h.type("\x1b[B\r")
      const before = h.sentOf("mflow.change").length
      expect(h.text().join("\n")).toContain("Remove Mflow config?")
      await h.type("n")
      expect(h.sentOf("mflow.change")).toHaveLength(before)
      await h.type("\ry")
      expect(h.sentOf("mflow.change").at(-1)).toMatchObject({ change: { operation: "remove" } })
    } finally { await h.app.onKey("\x03") }
  })
  test("details, scan, guide, plan, doctor and legacy stay on-page; errors and read-only do not mutate", async () => {
    const h = b73Harness()
    try {
      for (const operation of ["scan", "relay-guide", "plan", "doctor", "legacy-status"]) {
        await h.type(`/mflow ${operation}\r`)
        expect(h.text().join("\n")).toContain(operation)
        await h.keys("\x1b")
        await h.keys("\x1b")
      }
      h.failNext()
      await h.type("/mflow\r")
      expect(h.text().join("\n")).toContain("Relay unavailable")
      await h.type("r")
      expect(h.text().join("\n")).not.toContain("Relay unavailable")
      await h.type("\t\x1b[B\x1b[6~\x1b[5~\t")
      expect(h.text().join("\n")).toContain("Actions")
    } finally { await h.app.onKey("\x03") }
    const read = b73Harness({ remote: { host: "127.0.0.1", readOnly: true } })
    try {
      await read.type("/mflow activate\r")
      expect(read.sentOf("mflow.change")).toHaveLength(0)
      expect(read.text().join("\n")).toContain("full-access peer")
    } finally { await read.app.onKey("\x03") }
  })
  test("lock waits occupy the live footer only in the owning session and clear at turn end", async () => {
    const h = b73Harness()
    try {
      const chat = conversation(h.sessionId, (event) => h.app.onEvent(event))
      chat.exchange("Review leases", "Checking the room")
      h.app.onGlobal({ type: "mflow.waiting", sessionId: ids("session"), gseq: 1, at: NOW, file: "other.ts", deadlineAt: NOW + 90_000 })
      h.app.render()
      expect(h.text().join("\n")).not.toContain("Mflow other.ts")
      h.app.onGlobal({ type: "mflow.waiting", sessionId: h.sessionId, gseq: 2, at: NOW, file: "src/common.ts", deadlineAt: NOW + 90_000 })
      h.app.render()
      expect(h.text().join("\n")).toContain("Mflow src/common.ts · 90s")
      chat.emit({ type: "turn.cancelled", turnId: ids("turn") })
      h.app.render()
      expect(h.text().join("\n")).not.toContain("Mflow src/common.ts")
    } finally { await h.app.onKey("\x03") }
  })
  test("compact/medium/wide frames fit the grid; details, long fields and confirmation remain bounded", async () => {
    await preload("mflow")
    for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) {
      const report = b73Report()
      report.config.room = "long-room/".repeat(20)
      const base = { selected: 10, scroll: 1000, details: false, readOnly: false, report }
      for (const state of [base, { ...base, details: true }, { ...base, confirm: true }, { ...base, form: { selected: 2, values: ["room", "embedded", "/long-path".repeat(100), "0"], cursors: [4, 8, 1000, 1] } }]) {
        const frame = renderMflowPage({ state, width: width!, height: height!, now: NOW })
        expect(frame).toHaveLength(height!)
        expect(frame.every((line) => textWidth(line.map((span) => span.text).join("")) <= width!)).toBe(true)
        expect(frame.map((line) => line.map((span) => span.text).join("")).join("\n")).toContain("┌")
      }
    }
  })
  test("new page and command keep the startup graph free of schemas and load the view only on demand", () => {
    const probe = Bun.spawnSync(["bun", "-e", 'await import("./apps/cli/src/ui/app"); await import("@mendcode/client"); const before = Object.keys(require.cache); await (await import("./apps/cli/src/ui/lazy-pages")).preload("mflow"); const after = Object.keys(require.cache); console.log(JSON.stringify({ atStart: before.some((key) => key.endsWith("/view/mflow-page.ts")), loaded: after.some((key) => key.endsWith("/view/mflow-page.ts")), zod: after.some((key) => key.includes("/zod/")), schemas: after.some((key) => /protocol\\/src\\/(commands|events|queries|frames)\\.ts$/.test(key)) }))'], { cwd: pathToRoot(), stdout: "pipe", stderr: "pipe" })
    expect(probe.exitCode).toBe(0)
    expect(JSON.parse(probe.stdout.toString())).toEqual({ atStart: false, loaded: true, zod: false, schemas: false })
  })
})
function pathToRoot() { return new URL("../../..", import.meta.url).pathname }
