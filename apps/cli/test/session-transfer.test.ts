import { afterEach, expect, test } from "bun:test"
import type { CommandInput } from "@mendcode/client"
import type { SessionSummary } from "@mendcode/protocol"
import { parseAutomation, runAutomation, type Automation, type AutomationDeps } from "../src/automation"
import { exportSessionPrompt } from "../src/session-transfer-automation"
import { createSessionExportPicker } from "../src/session-transfer-prompt"
import { appHarness, cleanTemps, conversation, ids, tempDir, plain } from "./session-ui-harness"
import { textWidth } from "../src/view/wrap"
afterEach(cleanTemps)
const id = ids("session")
const parsed = (...args: string[]): Automation => { const p = parseAutomation(args); if (p.ok !== true) throw new Error(JSON.stringify(p)); return p.command }
const sessions = [{ sessionId: id, title: "Protocol review", updatedAt: 2000 }, { sessionId: ids("session"), title: "Tool fixture", updatedAt: 1000 }] as SessionSummary[]
function fake(prompt?: AutomationDeps["prompt"]) {
  const sent: CommandInput[] = []
  let out = ""
  let err = ""
  const deps: AutomationDeps = { client: { send: async (command) => { sent.push(command); return { ok: true, result: command.type === "session.list" ? { sessions } : command.type === "session.import" ? { sessionId: id, truncated: false } : { text: '{"format":"mendcode-session@1"}', format: "json", turns: 1, truncated: false } } }, subscribe: async () => ({ ok: true }) }, listen: () => {}, cwd: "/temp-project", now: Date.now, onInterrupt: () => {}, out: { write: (text) => { out += text } }, err: { write: (text) => { err += text } }, ...(prompt ? { prompt } : {}) }
  return { deps, sent, out: () => out, err: () => err }
}

test("CLI parses optional-ID export, native JSON/Markdown flags and import, rejecting invalid/conflicting arguments", () => {
  expect(parsed("export", id, "--sanitize", "--tools", "--timestamps", "--reasoning")).toMatchObject({ kind: "session.export", id, outputFormat: "json", raw: true, sanitize: true, toolDetails: true, timestamps: true, reasoning: true })
  expect(parsed("export", "--format", "markdown", "--no-reasoning", "--no-tools")).toMatchObject({ outputFormat: "markdown", reasoning: false, toolDetails: false })
  expect(parsed("session", "export", id)).toMatchObject({ kind: "session.export", id })
  expect(parsed("import", "session.json")).toMatchObject({ kind: "session.import", source: "session.json" })
  for (const args of [["export", "--format", "csv"], ["import"], ["export", id, "extra"], ["export", "--tools", "--no-tools"], ["export", "--json", "--format", "markdown"]]) expect(parseAutomation(args).ok).toBe(false)
})

test("export without ID selects a recent session, writes JSON to stdout, cancellation and headless missing-ID are explicit", async () => {
  const h = fake(async (request) => { expect(request.options?.[0]?.value).toBe(id); return id })
  expect(await runAutomation(parsed("export", "--sanitize"), h.deps)).toBe(0)
  expect(h.sent.at(-1)).toMatchObject({ type: "session.export", sessionId: id, format: "json", sanitize: true })
  expect(JSON.parse(h.out())).toEqual({ format: "mendcode-session@1" })
  const headless = fake()
  expect(await runAutomation(parsed("export"), headless.deps)).toBe(64)
  expect(headless.err()).toContain("session ID")
  const cancelled = fake(async () => undefined)
  expect(await runAutomation(parsed("export"), cancelled.deps)).toBe(2)
  expect(cancelled.sent.some((c) => c.type === "session.export")).toBe(false)
})

test("CLI imports through the daemon and refuses remote file or URL import", async () => {
  const h = fake()
  expect(await runAutomation(parsed("import", "snapshot.json"), h.deps)).toBe(0)
  expect(h.sent.at(-1)).toEqual({ type: "session.import", source: "snapshot.json", directory: "/temp-project" })
  const remote = fake()
  remote.deps.allowFiles = false
  expect(await runAutomation(parsed("import", "https://example.invalid/data"), remote.deps)).toBe(64)
  expect(remote.sent).toHaveLength(0)
})

test("export autocomplete searches, navigates, handles empty results and cancels without selecting", () => {
  let rows: string[] = []
  let choice: string | undefined | null = null
  const picker = createSessionExportPicker({ request: exportSessionPrompt(sessions), size: () => ({ width: 100, height: 30 }), draw: (frame) => { rows = frame.map(plain) }, finish: (value) => { choice = value } })
  picker.paste("tool")
  expect(rows.join("\n")).toContain("Sessions · tool")
  expect(rows.join("\n")).not.toContain("Protocol review")
  picker.key("\r")
  expect(choice).toBe(sessions[1]!.sessionId)
  const empty = createSessionExportPicker({ request: exportSessionPrompt(sessions), size: () => ({ width: 60, height: 20 }), draw: (frame) => { rows = frame.map(plain) }, finish: (value) => { choice = value } })
  choice = null
  empty.paste("missing")
  empty.key("\r")
  expect(choice).toBe(null)
  expect(rows.join("\n")).toContain("No matching sessions")
  empty.key("\x15")
  empty.key("\x1b[B")
  empty.key("\r")
  expect(choice).toBe(sessions[1]!.sessionId)
})

test("sanitize toggle and direct slash flag reach daemon export; options/error screens fit each terminal breakpoint", async () => {
  for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) {
    const h = appHarness({ width, height, dataDir: tempDir(), directory: tempDir(), reply: (c) => c.type === "session.export" ? { ok: false, error: { code: "unknown_session", message: "Session unavailable" } } : undefined })
    h.app.applySettings({ onboarded: true })
    conversation(h.sessionId, h.app.onEvent).exchange("Review exports", "Reviewed")
    await h.type("/export\r")
    for (let i = 0; i < 8; i++) await h.type("\t")
    await h.type(" ")
    expect(h.text().join("\n")).toContain("[x] Sanitize content")
    await h.type("\r")
    expect(h.sentOf("session.export").at(-1)).toMatchObject({ sanitize: true })
    expect(h.text().join("\n")).toContain("Session unavailable")
    expect(h.frames.at(-1)).toHaveLength(height!)
    for (const row of h.text()) expect(textWidth(row)).toBeLessThanOrEqual(width!)
    await h.type("\x1b")
    await h.type("/export json --copy --sanitize\r")
    expect(h.sentOf("session.export").at(-1)).toMatchObject({ format: "json", sanitize: true })
    await h.app.onKey("\x03"); await h.app.onKey("\x03")
  }
})
