import { writeFileSync } from "node:fs"
import path from "node:path"
import type { Line } from "../apps/cli/src/ui/theme"
import type { CommandInput } from "@mendcode/client"
import type { SessionSummary } from "@mendcode/protocol"
import { appHarness, tempDir, conversation, ids, NOW } from "../apps/cli/test/session-ui-harness"
import { createSessionExportPicker } from "../apps/cli/src/session-transfer-prompt"
import { exportSessionPrompt } from "../apps/cli/src/session-transfer-automation"
import { parseAutomation, runAutomation } from "../apps/cli/src/automation"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth, wrap } from "../apps/cli/src/view/wrap"

export async function renderB36Frames(directory: string, sizes: string[]) {
  const sessionId = ids("session")
  const sessions = [{ sessionId, title: "Protocol review", updatedAt: NOW }, { sessionId: ids("session"), title: "Tool fixture", updatedAt: NOW - 60_000 }] as SessionSummary[]
  for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
    const match = /^(\d+)x(\d+)$/.exec(size)
    if (!match) throw new Error(`invalid size ${size}`)
    const width = Number(match[1])
    const height = Number(match[2])
    const save = (name: string, rows: Line[]) => {
      if (rows.length !== height || rows.some((row) => textWidth(row.map((span) => span.text).join("")) > width)) throw new Error(`overflow: ${name} ${size}`)
      const text = rows.map((row) => fit(row, width).map((span) => span.text).join(""))
      if (text.some((row) => row.includes("\x1b"))) throw new Error(`ANSI: ${name}`)
      writeFileSync(path.join(directory, `${name}-${size}.txt`), `${text.join("\n")}\n`)
    }
    let pickerRows: Line[] = []
    const picker = createSessionExportPicker({ request: exportSessionPrompt(sessions), size: () => ({ width, height }), draw: (rows) => { pickerRows = rows }, finish: () => {} })
    picker.render()
    save("export-picker", pickerRows)
    picker.paste("tool")
    save("export-picker-search", pickerRows)
    picker.paste(" missing")
    save("export-picker-empty", pickerRows)
    const h = appHarness({ width, height, sessionId, dataDir: tempDir(), directory: tempDir(), reply: (command) => command.type === "session.export" ? { ok: false, error: { code: "unknown_session", message: "Session unavailable" } } : undefined })
    h.app.applySettings({ onboarded: true })
    conversation(sessionId, h.app.onEvent).exchange("Review export parity", "Export supports JSON, Markdown and sanitization.")
    await h.type("/export\r")
    save("export-options", h.frames.at(-1)!)
    for (let i = 0; i < 8; i++) await h.type("\t")
    await h.type(" ")
    save("export-options-sanitize", h.frames.at(-1)!)
    await h.type("\r")
    save("export-options-error", h.frames.at(-1)!)
    await h.app.onKey("\x03"); await h.app.onKey("\x03")
    // Capture the actual CLI factory's stdout (local fake protocol only, no provider or network).
    for (const [name, args] of [["cli-export-json", ["export", sessionId, "--sanitize"]], ["cli-export-markdown", ["export", sessionId, "--format", "markdown", "--sanitize"]], ["cli-import", ["import", "snapshot.json"]]] as const) {
      const parsed = parseAutomation([...args])
      if (parsed.ok !== true) throw new Error(JSON.stringify(parsed))
      let text = ""
      const reply = (command: CommandInput) => ({ ok: true as const, result: command.type === "session.import" ? { sessionId, turns: 1, items: 2, truncated: false, sanitized: true, attachmentFilesOmitted: 0 } : { format: command.type === "session.export" ? command.format : "json", turns: 1, truncated: false, text: command.type === "session.export" && command.format === "markdown" ? "# [redacted:session-title]\n\n## User\n\n[redacted:user_message]\n" : JSON.stringify({ format: "mendcode-session@1", sessionId, title: "[redacted:session-title]", sanitized: true, truncated: false, turns: [] }, null, 2) } })
      await runAutomation(parsed.command, { client: { send: async (command) => reply(command), subscribe: async () => ({ ok: true }) }, cwd: "/work/mendcode", listen: () => {}, now: () => NOW, onInterrupt: () => {}, out: { write: (value) => { text += value } }, err: { write: (error) => { throw new Error(error) } } })
      const rows = wrap(text.trimEnd(), width).map((text): Line => [{ text, fg: "text" }])
      while (rows.length < height) rows.push([])
      save(name, rows)
    }
  }
}
