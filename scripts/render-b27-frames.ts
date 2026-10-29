import { writeFileSync } from "node:fs"
import path from "node:path"
import { appHarness, conversation, ids, NOW, tempDir } from "../apps/cli/test/session-ui-harness"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth } from "../apps/cli/src/view/wrap"
import type { ContinuitySummary } from "@mendcode/protocol"

export async function renderB27Frames(directory: string, sizes: string[]) {
  for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
    const match = /^(\d+)x(\d+)$/.exec(size)
    if (!match) throw new Error(`Invalid size: ${size}`)
    const width = Number(match[1]), height = Number(match[2])
    const h = appHarness({ width, height, dataDir: tempDir(), directory: "/work/project" })
    h.app.applySettings({ onboarded: true, experimental: { async_tools: true, async_questions: true } })
    const chat = conversation(h.sessionId, h.app.onEvent), turnId = ids("turn")
    chat.exchange("Read the service and inspect its routes", "I started the file jobs and continued planning the API.")
    const save = (name: string) => {
      h.app.render()
      const frame = h.frames.at(-1)!
      if (frame.length !== height || frame.some((row) => textWidth(row.map((span) => span.text).join("")) > width)) throw new Error(`Overflow: ${name} ${size}`)
      const rows = frame.map((row) => fit(row, width).map((span) => span.text).join(""))
      if (rows.some((row) => /[\x00\x1b]/.test(row))) throw new Error(`Control sequence: ${name}`)
      writeFileSync(path.join(directory, `${name}-${size}.txt`), rows.join("\n") + "\n")
    }
    const records: ContinuitySummary[] = ["read", "grep", "glob"].map((tool, i) => ({ id: `job_${tool}`, sessionId: h.sessionId, turnId, kind: "job", tool, generation: 0, status: ["running", "queued", "completed"][i] as ContinuitySummary["status"], createdAt: NOW - 5000, updatedAt: NOW }))
    for (const record of records) chat.emit({ type: "continuity.updated", record })
    await h.app.onKey("\x14")
    save("async-jobs-active")
    for (const [i, status] of ["failed", "cancelled", "interrupted"].entries()) chat.emit({ type: "continuity.updated", record: { ...records[i]!, status: status as ContinuitySummary["status"], updatedAt: NOW + 1 } })
    save("async-jobs-terminal")
    await h.app.onKey("\x14")
    const questionTurn = ids("turn"), requestId = ids("request")
    chat.emit({ type: "turn.started", turnId: questionTurn, queueId: ids("queue") })
    chat.emit({ type: "server.request", requestId, turnId: questionTurn, kind: "question", async: true, title: "Asked 1 question", detail: "", questions: [{ header: "Database", question: "Which store should the service use?", options: [{ label: "SQLite", description: "One local file" }, { label: "Postgres", description: "Shared server" }] }] })
    chat.emit({ type: "turn.completed", turnId: questionTurn })
    save("async-question-after-turn")
    await h.app.onKey("2")
    chat.emit({ type: "server.request.resolved", requestId, resolution: "answered" })
    const answerTurn = ids("turn"), noticeItem = ids("item"), answerItem = ids("item")
    chat.emit({ type: "turn.started", turnId: answerTurn, queueId: ids("queue") })
    chat.emit({ type: "item.started", turnId: answerTurn, itemId: noticeItem, kind: "user_message", meta: { notice: true } })
    chat.emit({ type: "item.completed", itemId: noticeItem, status: "ok", text: "[Async question question_database] answered\n[[\"Postgres\"]]" })
    chat.emit({ type: "item.started", turnId: answerTurn, itemId: answerItem, kind: "agent_message" })
    chat.emit({ type: "item.completed", itemId: answerItem, status: "ok", text: "I will use Postgres for the service." })
    chat.emit({ type: "turn.completed", turnId: answerTurn })
    save("async-question-answered")
    await h.app.onKey("\x03")
  }
}
