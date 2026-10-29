import type { QuestionInfo } from "@mendcode/protocol"
import { appHarness, conversation, ids, tempDir } from "./session-ui-harness"

export const QUESTIONS: QuestionInfo[] = [
  { header: "Database", question: "Which database should the service use?", options: [{ label: "SQLite", description: "One local file" }, { label: "Postgres", description: "Shared server" }] },
  { header: "Checks", question: "Which checks should run?", options: [{ label: "Types", description: "Validate interfaces" }, { label: "Tests", description: "Exercise behavior" }], multiple: true },
  { header: "Notes", question: "What should the implementation preserve?", options: [] },
]

export function b57Harness(width = 100, height = 30, questions = QUESTIONS) {
  const h = appHarness({ width, height, dataDir: tempDir(), directory: "/work/project", mode: "balanced" })
  h.app.applySettings({ onboarded: true })
  const chat = conversation(h.sessionId, h.app.onEvent)
  chat.exchange("Implement the service", "I need your choices before continuing.")
  const turnId = ids("turn"), requestId = ids("request")
  chat.emit({ type: "turn.started", turnId, queueId: ids("queue") })
  chat.emit({ type: "server.request", requestId, turnId, kind: "question", title: `Asked ${questions.length} questions`, detail: "", questions })
  chat.emit({ type: "foreground.state", state: "waiting_approval", turnId })
  h.app.render()
  return { ...h, chat, turnId, requestId }
}
