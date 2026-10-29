import { afterEach, expect, test } from "bun:test"
import { existsSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { HistoryReport } from "@mendcode/protocol"
import { b56Harness } from "./b56-harness"
import { cleanTemps, tempDir } from "./session-ui-harness"
import { osc52Copy } from "../src/ui/osc52"
import { writeExport } from "../src/ui/export-file"
import { textWidth } from "../src/view/wrap"

afterEach(cleanTemps)

test("/copy copies the complete daemon transcript; /copy n retains the answer shortcut", async () => {
  const h = b56Harness()
  await h.type("/copy\r")
  expect(h.sentOf("session.export")[0]).toMatchObject({ format: "markdown", toolDetails: true, reasoning: true, assistantMetadata: false, timestamps: false })
  expect(h.written).toEqual([osc52Copy(h.exported)!])
  await h.type("/copy 2\r")
  expect(h.written[1]).toContain(Buffer.from(h.turns[0]!.items[1]!.text).toString("base64"))
})

test("/copy of a session too long for the clipboard copies its last answer and says where the rest is", async () => {
  const h = b56Harness({ reply: (command) => (command.type === "session.export" ? { ok: true, result: { format: "markdown", text: "# cut", truncated: true, turns: 2 } } as never : undefined) })
  await h.type("/copy\r")
  expect(h.written).toEqual([osc52Copy(h.turns[1]!.items[1]!.text)!])
  const shown = h.text().join("\n")
  expect(shown).toContain("copied the last answer")
  expect(shown).toContain("/export")
  expect(shown).not.toContain("Transcript is truncated")
})

test("/copy pick selects an older response without running until Enter", async () => {
  const h = b56Harness()
  await h.type("/copy pick\r")
  expect(h.text().join("\n")).toContain("Copy response")
  expect(h.written).toHaveLength(0)
  await h.type("\x1b[A\r")
  expect(h.written).toEqual([osc52Copy(h.turns[0]!.items[1]!.text)!])
})

test("message menu copies the chosen user prompt; Escape returns to selection then chat", async () => {
  const h = b56Harness()
  await h.type("/messages\r\x1b[A\r")
  expect(h.text().join("\n")).toContain("Message Actions")
  expect(h.text().join("\n")).toContain("Revert")
  await h.type("\x1b")
  expect(h.text()[0]).toContain("Messages")
  await h.type("\r\r")
  expect(h.written).toEqual([osc52Copy(h.turns[1]!.items[0]!.text)!])
})

test("timeline actions target the selected turn; revert restores that prompt and retains the target on force", async () => {
  const h = b56Harness({ reply: (command) => command.type === "session.undo" && !command.force ? { ok: false, error: { code: "target_mismatch", message: "undo would overwrite changes to src/a.ts; send force to do it anyway" } } : undefined })
  await h.type("/timeline\r\x1b[A\x01")
  expect(h.text()[0]).toContain("Message Actions")
  await h.type("r")
  expect(h.sentOf("session.undo")[0]).toMatchObject({ atItemId: h.turns[0]!.items[0]!.itemId })
  await h.type("y")
  expect(h.sentOf("session.undo")[1]).toMatchObject({ atItemId: h.turns[0]!.items[0]!.itemId, force: true })
  await h.type("\x1b")
  await h.type("\r")
  expect(h.sentOf("user.submit")[0]).toMatchObject({ text: h.turns[0]!.items[0]!.text })
})

test("fork from a selected message switches session and prepares the prompt", async () => {
  const h = b56Harness()
  await h.type("/messages\r\x1b[A\r")
  await h.type("f")
  expect(h.sentOf("session.fork")[0]).toMatchObject({ atItemId: h.turns[1]!.items[0]!.itemId })
  await h.type("\r")
  expect(h.sentOf("user.submit")[0]).toMatchObject({ sessionId: h.forkId, text: h.turns[1]!.items[0]!.text })
})

test("message revert and fork restore submitted image references together with the prompt", async () => {
  for (const action of ["r", "f"]) {
    const h = b56Harness()
    const ref = { sha256: "a".repeat(64), mime: "image/png", bytes: 12, name: "diagram.png" }
    h.turns[1]!.items[0]!.attachmentRefs = [ref]
    h.turns[1]!.items[0]!.attachments = [ref.name]
    await h.type("/messages\r\x1b[A\r")
    await h.type(action)
    if (action === "r") await h.type("\x1b")
    await h.type("\r")
    expect(h.sentOf("user.submit")[0]).toMatchObject({ text: h.turns[1]!.items[0]!.text, attachments: [ref] })
  }
})

test("message pages use history cursors; truncated responses cannot be copied", async () => {
  let older = false
  const h = b56Harness({ reply: (command) => {
    if (command.type !== "session.history") return
    older = !!command.before
    return { ok: true, result: { turns: [{ turnId: h.turns[0]!.turnId, seq: older ? 1 : 10, at: 0, preview: "Prompt", outcome: "completed", items: [{ ...h.turns[0]!.items[0]! }, { ...h.turns[0]!.items[1]!, truncated: true }] }], ...(older ? { newer: 1 } : { older: 10 }) } satisfies HistoryReport }
  } })
  await h.type("/copy pick\r\x1b[5~")
  expect(h.sentOf("session.history")[1]).toMatchObject({ before: 10 })
  await h.type("\x1b[6~\r")
  expect(h.sentOf("session.history")[2]).toMatchObject({ after: 1 })
  expect(h.written).toHaveLength(0)
  expect(h.text().join("\n")).toContain("copy unavailable")
})

test("a plain click on the transcript never opens Message Actions; ctrl+x k and /messages do", async () => {
  const h = b56Harness({ width: 100, height: 30 })
  const row = h.text().findIndex((row) => row.includes("Export reasoning"))
  expect(row).toBeGreaterThan(0)
  await h.type(`\x1b[<0;10;${row + 1}M\x1b[<0;10;${row + 1}m`)
  expect(h.app.page).toBe("chat")
  expect(h.text()[0]).not.toContain("Message Actions")
  await h.type("\x18k")
  expect(h.app.page).toBe("messages")
  await h.type("\x1b")
  expect(h.app.page).toBe("chat")
})

test("the message preview renders markdown instead of showing its markers", async () => {
  const h = b56Harness({ width: 120, height: 30 })
  h.turns[1]!.items[1]!.text = "## Plan\n\nUse **bold** text and `code` here.\n\n- first item"
  await h.type("/messages\r")
  const rows = h.text().map((row) => row.slice(50)).join("\n")
  expect(rows).toContain("Plan")
  expect(rows).toContain("Use bold text and code here.")
  expect(rows).not.toContain("**bold**")
  expect(rows).not.toContain("## Plan")
})

test("/export and leader x open options; toggles reach the daemon and only confirm writes a file", async () => {
  const h = b56Harness()
  await h.type("\x18x")
  expect(h.text()[0]).toContain("Export Options")
  expect(h.sentOf("session.export")).toHaveLength(0)
  expect(readdirSync(h.directory)).toEqual([])
  await h.type("\t\t \t \t \t \r")
  expect(h.sentOf("session.export")[0]).toMatchObject({ reasoning: false, toolDetails: false, assistantMetadata: true, timestamps: true })
  expect(readFileSync(path.join(h.directory, "transcript.md"), "utf8")).toBe(h.exported)
})

test("long export filenames keep all options and the selected field visible in compact mode", async () => {
  const h = b56Harness({ width: 60, height: 20 })
  await h.type("/export\r\x15")
  await h.type(`${"folder/".repeat(30)}notes.md`)
  for (let i = 0; i < 7; i++) await h.type("\t")
  const frame = h.text().join("\n")
  expect(frame).toContain("Filename:")
  expect(frame).toContain("…")
  expect(frame).toContain("› [ ] Open in editor")
  expect(frame).toContain("Destination: file")
  expect(h.sentOf("session.export")).toHaveLength(0)
})

test("editor-only export returns control, saves no project file, and file export keeps editor changes", async () => {
  const requests: Array<{ text: string; fileName?: string }> = []
  const h = b56Harness({ editorLauncher: async () => async (request) => { requests.push(request); request.suspend?.(); request.resume?.(); return { ok: true, text: "# Edited", changed: true } } })
  await h.type("/export --no-save --reasoning\r")
  expect(requests[0]).toMatchObject({ text: h.exported, fileName: "transcript.md" })
  expect(readdirSync(h.directory)).toEqual([])
  await h.type("/export edited.md --editor\r")
  expect(readFileSync(path.join(h.directory, "edited.md"), "utf8")).toBe("# Edited\n")
})

test("failed editor and existing file keep options open without overwriting", async () => {
  const h = b56Harness({ env: { EDITOR: "fake-editor" }, editorLauncher: async () => async () => ({ ok: false, reason: "exit-code", message: "fake-editor exited with code 7" }) })
  await h.type("/export\r\r")
  expect(h.text()[0]).toContain("Export Options")
  expect(h.text().join("\n")).toContain("exited with code 7")
  expect(readdirSync(h.directory)).toEqual([])
  await h.type("\x1b")
  writeFileSync(path.join(h.directory, "saved.md"), "Keep")
  await h.type("/export saved.md\r")
  expect(readFileSync(path.join(h.directory, "saved.md"), "utf8")).toBe("Keep")
})

test("export blocks symlink files and cannot create folders through a symlink outside the project", () => {
  const root = tempDir()
  const outside = tempDir()
  writeFileSync(path.join(outside, "keep.md"), "Keep")
  symlinkSync(path.join(outside, "keep.md"), path.join(root, "escape.md"))
  expect(writeExport({ cwd: root, target: "escape.md", text: "Overwrite", explicit: true, force: true }).ok).toBe(false)
  symlinkSync(outside, path.join(root, "link"))
  expect(writeExport({ cwd: root, target: "link/new/file.md", text: "Escape", explicit: true, force: true }).ok).toBe(false)
  expect(readFileSync(path.join(outside, "keep.md"), "utf8")).toBe("Keep")
  expect(existsSync(path.join(outside, "new"))).toBe(false)
})

test("B56 pages render exactly at compact and large sizes with hints in the header", async () => {
  for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) {
    const h = b56Harness({ width, height })
    for (const command of ["/messages\r", "/copy pick\r", "/export\r", "/timeline\r"]) {
      await h.type(command)
      const frame = h.text()
      expect(frame).toHaveLength(height)
      expect(frame.every((row) => textWidth(row) <= width && !row.includes("\x1b"))).toBe(true)
      expect(frame[0]).toContain("esc")
      await h.type("\x1b")
    }
  }
})
