import { appHarness, conversation, ids, NOW, tempDir } from "./session-ui-harness"

export async function projectRestHarness(width: number, height: number) {
  const root = "/work/project", target = "/work/project-review"
  const sessionId = ids("session")
  const h = appHarness({ sessionId, width, height, dataDir: tempDir(), directory: root, version: "0.0.1-dev", reply: (command) => {
    if (command.type === "models.list") return { ok: true, result: { selectable: true, engine: "native", defaults: { model: "alpha" }, effective: { model: "alpha" }, roles: {}, models: [{ id: "alpha", name: "Alpha", provider: "openai", efforts: [] }] } }
    if (command.type === "session.list") return { ok: true, result: { sessions: [{ sessionId, directory: root, title: "Worktree review", createdAt: NOW, updatedAt: NOW, lastSeq: 0, queued: 0 }] } }
    if (command.type === "git.branch") return { ok: true, result: { branch: command.directory === target ? "mend/review" : "main" } }
    if (command.type === "changes.query") return { ok: true, result: { files: [], directory: command.directory, branch: command.directory === target ? "mend/review" : "main", additions: 0, deletions: 0, truncated: false } }
    if (command.type === "settings.get") return { ok: true, result: { settings: { onboarded: true, pet: "off" } } }
    return undefined
  } })
  h.app.applySettings({ onboarded: true, pet: "off" })
  await h.app.start()
  const transcript = conversation(h.sessionId, (event) => h.app.onEvent(event))
  transcript.exchange("Review the worktree changes.", "The session history follows the selected worktree.")
  const move = async (directory: string, workspaceID: string | null) => {
    transcript.emit({ type: "session.workspace.changed", directory, workspaceID })
    await Promise.resolve()
    await Promise.resolve()
    h.app.render()
  }
  return { ...h, root, target, warp: () => move(target, `ws_${"a".repeat(24)}`), detach: () => move(root, null) }
}
