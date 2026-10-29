import type { ChangesReport, RewindReport, TimelineEntry } from "@mendcode/protocol"
import type { CommandReply } from "@mendcode/client"
import { appHarness, conversation, NOW, tempDir } from "./session-ui-harness"

export function b55Harness(width = 100, height = 30, options: { conflict?: boolean; external?: boolean; partial?: boolean } = {}) {
  let entries: TimelineEntry[] = []
  let cursor = 2
  const changes: ChangesReport = { root: "/work/parity", scope: "session", complete: !options.partial, omittedFiles: options.partial ? 1 : 0, files: [
    { path: "src/runner.ts", status: "modified", additions: 2, deletions: 1, binary: false, truncated: false, diff: "@@ -1 +1,2 @@\n-oldRunner()\n+await runTurn()\n+saveSummary()\n" },
    { path: "src/created.ts", status: "added", additions: 1, deletions: 0, binary: false, truncated: false, diff: "@@ -0,0 +1 @@\n+export const enabled = true\n" },
  ] }
  const report: RewindReport = { turnIds: [], files: { restored: ["src/runner.ts"], removed: ["src/created.ts"], skipped: [] }, history: { messages: options.external ? 0 : 4, tracked: !options.external }, shellUntracked: true, worktreeTracked: true, notes: ["Git history/index and shell effects outside the worktree are not rewound."], prompt: { text: "Update runner and save changes", attachments: [] }, changes: changes.files.map(({ path, additions, deletions }) => ({ path, additions, deletions })) }
  const h = appHarness({ width, height, dataDir: tempDir(), directory: "/work/parity", reply: (command): CommandReply | undefined => {
    if (command.type === "session.timeline") return { ok: true, result: { entries } }
    if (command.type === "session.changes") return { ok: true, result: { ...changes, scope: command.atItemId ? "message" : "session" } }
    if (command.type === "session.undo" || command.type === "session.redo") {
      if (options.conflict && !command.force) return { ok: false, error: { code: "target_mismatch", message: `${command.type === "session.undo" ? "undo" : "redo"} would overwrite changes made after the turn to src/runner.ts; send force to do it anyway` } }
      const entry = entries[command.type === "session.undo" ? --cursor : cursor++]!
      if (command.type === "session.undo") chat.undo(entry.turnId)
      else chat.redo(entry.turnId)
      return { ok: true, result: { ...report, ...(command.type === "session.redo" ? { files: { restored: ["src/runner.ts", "src/created.ts"], removed: [], skipped: [] } } : {}), turnIds: [entry.turnId], itemId: entry.itemId, prompt: { text: entry.preview, attachments: [] }, canRedo: cursor < entries.length } }
    }
    if (command.type === "changes.query") return { ok: true, result: { root: "/work/parity", files: [], omittedFiles: 0 } }
    return undefined
  } })
  const chat = conversation(h.sessionId, (event) => h.app.onEvent(event))
  const first = chat.exchange("Inspect the runner", "The runner writes a persistent summary.")
  const second = chat.exchange(report.prompt!.text, "Updated runner and saved the summary.")
  entries = [first, second].map((exchange, i) => ({ ...exchange, at: NOW - (2 - i) * 60_000, preview: i ? report.prompt!.text : "Inspect the runner", reverted: false }))
  h.app.applySettings({ onboarded: true })
  return h
}
