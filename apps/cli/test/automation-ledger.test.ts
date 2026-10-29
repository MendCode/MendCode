import { afterEach, expect, test } from "bun:test"
import type { CommandInput } from "@mendcode/client"
import { parseAutomation, runAutomation, type AutomationDeps } from "../src/automation"
import { automationLedgerHarness } from "./automation-ledger-harness"
import { cleanTemps } from "./session-ui-harness"
import { textWidth } from "../src/view/wrap"

afterEach(cleanTemps)

test("v1 workflows aliases, export format and pagination parse; invalid bounds are rejected", () => {
  for (const prefix of [["workflow"], ["workflows"], ["control-plane", "workflows"]]) {
    expect(parseAutomation([...prefix, "events", "wfl_1", "--limit", "12", "--before", "90"])).toMatchObject({ ok: true, command: { kind: "automation.ledger", scope: "workflow", operation: "events", limit: 12, before: 90 } })
    expect(parseAutomation([...prefix, "export", "wfl_1", "--format", "markdown"])).toMatchObject({ ok: true, command: { exportFormat: "markdown", json: false } })
  }
  expect(parseAutomation(["loop", "artifacts", "lop_1", "--run", "4"])).toMatchObject({ ok: true, command: { scope: "loop", operation: "artifacts", run: 4 } })
  for (const args of [["--limit", "101"], ["--before", "0"], ["--run", "-1"], ["--limit", "1.5"]]) expect(parseAutomation(["workflow", "events", "wfl_1", ...args]).ok).toBe(false)
  expect(parseAutomation(["workflow", "events"]).ok).toBe(false)
})

test("automation reads call the daemon, preserve the envelope and print real export text", async () => {
  const commands: CommandInput[] = []
  const out: string[] = []
  const deps: AutomationDeps = {
    client: { send: async (command) => { commands.push(command); return { ok: true, result: command.type === "workflow.export" ? { export: { text: "# actual evidence", format: "markdown", page: {} } } : { ledger: { entries: [{ sequence: 2, kind: "gate", data: { status: "fail" } }], nextBefore: 2, truncated: true, historical: true } } } }, subscribe: async () => ({ ok: true }) },
    out: { write: (text) => out.push(text) }, err: { write: () => {} }, cwd: "/tmp/local-project", now: () => 1, listen() {}, onInterrupt() {},
  }
  let parsed = parseAutomation(["control-plane", "workflows", "artifacts", "wfl_1", "--before", "5", "--json"])
  if (parsed.ok !== true) throw new Error("not parsed")
  expect(await runAutomation(parsed.command, deps)).toBe(0)
  expect(commands[0]).toEqual({ type: "workflow.artifacts", workflowId: "wfl_1", before: 5 })
  expect(JSON.parse(out.join("")).data.ledger.nextBefore).toBe(2)
  out.length = 0
  parsed = parseAutomation(["workflow", "export", "wfl_1", "--format", "markdown"])
  if (parsed.ok !== true) throw new Error("not parsed")
  expect(await runAutomation(parsed.command, deps)).toBe(0)
  expect(out.join("")).toBe("# actual evidence\n")
})

test("app opens both ledgers, selects evidence and receipts, previews/copies export and restores the page", async () => {
  const h = automationLedgerHarness()
  try {
    for (const scope of ["workflow", "loop"] as const) {
      await h.type(scope === "workflow" ? "/workflows\r" : "/loops\r")
      expect(h.text().join("\n")).toContain("b evidence")
      await h.type("b")
      expect(h.text().join("\n")).toContain("evidence")
      expect(h.sentOf(`${scope}.events`).length).toBe(1)
      await h.type("2")
      expect(h.sentOf(`${scope}.artifacts`).length).toBe(1)
      await h.type("3")
      expect(h.text().join("\n")).toContain("Verification: unverified")
      await h.type("e")
      expect(h.text().join("\n")).toContain("JSON export")
      await h.type("y")
      expect(h.written.join("")).toContain("\x1b]52;")
      await h.type("\x1b")
      await h.type("m")
      expect(h.text().join("\n")).toContain("Markdown export")
      await h.app.onKey("\x1b")
      await h.app.onKey("\x1b")
      expect(h.text().join("\n")).toContain(scope === "workflow" ? "Workflows" : "Loops")
      await h.type("\x1b")
    }
  } finally { await h.close() }
})

test("app ledger and changed list panels fit all required terminal sizes without footer hints", async () => {
  for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) {
    const h = automationLedgerHarness(width, height)
    try {
      for (const slash of ["/workflows\r", "/loops\r"]) {
        await h.type(slash)
        await h.type("b")
        for (const key of ["1", "2", "3", "e", "\x1b", "m", "\x1b"]) {
          await h.type(key)
          const frame = h.frames.at(-1)!
          expect(frame).toHaveLength(height)
          expect(frame.every((line) => textWidth(line.map((span) => span.text).join("")) <= width)).toBe(true)
          expect(h.text().join("\n")).toMatch(/[╭┌]/)
        }
        await h.app.onKey("\x1b")
        await h.app.onKey("\x1b")
      }
    } finally { await h.close() }
  }
})
