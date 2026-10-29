import type { ModelsReport, TuiRequestInput } from "@mendcode/protocol"
import { appHarness, ids, NOW } from "./session-ui-harness"

export function b84Harness(width = 100, height = 30) {
  const directory = "/work/project"
  const sessionId = ids("session"), second = ids("session")
  const sessions = [sessionId, second].map((id, i) => ({ sessionId: id, title: i ? "Review transport" : "Control terminal", directory, createdAt: NOW - 3_600_000, updatedAt: NOW, state: "idle" }))
  const models: ModelsReport = { engine: "native", selectable: true, defaults: { model: "local:fixture" }, effective: { model: "local:fixture" }, roles: {}, models: [{ id: "local:fixture", name: "Fixture", provider: "local", contextWindow: 128_000, efforts: ["medium", "high"] }] }
  const h = appHarness({ width, height, directory, sessionId, tuiControl: true, reply: (command) => {
    const result = command.type === "session.list" ? { sessions } : command.type === "session.get" ? { session: sessions.find((entry) => entry.sessionId === command.sessionId), entries: [] } : command.type === "models.list" ? models : command.type === "themes.list" ? { themes: [] } : undefined
    return { ok: true, ...(result ? { result } : {}) }
  } })
  return {
    ...h, second, directory,
    async control(request: TuiRequestInput) {
      const requestID = ids("command")
      await h.app.onGlobal({ type: "tui.control.request", directory, requestID, request, gseq: 0, at: NOW })
      h.app.render()
      return h.sent.findLast((entry) => entry.type === "tui.control.response" && entry.requestID === requestID)
    },
  }
}
