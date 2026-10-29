import type { GlobalEvent, StatusSegment } from "@mendcode/protocol"
import { appHarness, conversation, NOW, tempDir } from "./session-ui-harness"

export const B60_LEFT: StatusSegment[][] = [
  [{ text: "main", fg: "#70ffaf", bold: true }, { text: " · clean" }],
  [{ text: "checks: " }, { text: "passed", fg: "#70ffaf" }],
  [{ text: "project: /work/mendcode" }],
]
export const B60_RIGHT: StatusSegment[][] = [
  [{ text: "12:04", fg: "#fff" }],
  [{ text: "branch: main" }],
  [{ text: "tools: 2 running" }],
  [{ text: "queue: 1" }],
]

export function b60Harness(width = 100, height = 30) {
  const directory = tempDir("mendcode-b60-project-")
  const h = appHarness({ width, height, directory, dataDir: tempDir("mendcode-b60-data-"), reply: (command) => {
    if (command.type === "models.list") return { ok: true, result: { engine: "faux", selectable: false, models: [], defaults: { model: "local" }, effective: { model: "local" }, roles: {} } }
    return undefined
  } })
  h.app.applySettings({ onboarded: true, pet: "off" })
  const status = (patch: Partial<Extract<GlobalEvent, { type: "status.line" }>> = {}) => h.app.onGlobal({
    type: "status.line", gseq: 0, at: NOW, directory, left: [], right: [], problems: [], ...patch,
  })
  return { ...h, directory, status, chat: conversation(h.sessionId, h.app.onEvent).exchange }
}
