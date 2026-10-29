import { writeFileSync } from "node:fs"
import path from "node:path"
import { b57Harness, QUESTIONS } from "../apps/cli/test/b57-harness"
import { appHarness, conversation, ids, tempDir } from "../apps/cli/test/session-ui-harness"
import { DEFAULT_TUI_PROFILE, writeTuiProfile } from "../apps/cli/src/view/tui-profile"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth } from "../apps/cli/src/view/wrap"

export async function renderB57Frames(directory: string, sizes: string[]) {
  for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
    const match = /^(\d+)x(\d+)$/.exec(size)
    if (!match) throw new Error(`Invalid size: ${size}`)
    const width = Number(match[1]), height = Number(match[2])
    const save = (h: ReturnType<typeof appHarness>, name: string) => {
      h.app.render()
      const frame = h.frames.at(-1)!
      if (frame.length !== height || frame.some((row) => textWidth(row.map((span) => span.text).join("")) > width)) throw new Error(`Overflow: ${name} ${size}`)
      const rows = frame.map((row) => fit(row, width).map((span) => span.text).join(""))
      if (rows.some((row) => /[\x00\x1b]/.test(row))) throw new Error(`Control sequence: ${name}`)
      writeFileSync(path.join(directory, `${name}-${size}.txt`), rows.join("\n") + "\n")
    }
    const h = b57Harness(width, height)
    save(h, "question-batch-choice")
    await h.app.onKey("2")
    await h.app.onKey("1")
    await h.app.onKey("2")
    save(h, "question-batch-multiple")
    await h.app.onKey("3")
    await h.type("Lint")
    save(h, "question-batch-custom-edit")
    await h.app.onKey("\r")
    save(h, "question-batch-custom-saved")
    await h.app.onKey("\t")
    save(h, "question-batch-free-text")
    await h.type("Keep the client API\r")
    save(h, "question-batch-review")
    const empty = b57Harness(width, height)
    await empty.app.onKey("\x1b[Z")
    save(empty, "question-batch-unanswered")
    const closed = b57Harness(width, height, [{ ...QUESTIONS[0]!, custom: false }])
    save(closed, "question-batch-closed-choice")
    const long = b57Harness(width, height, [{ header: "Checks", question: "Select checks", multiple: true, options: Array.from({ length: 9 }, (_, i) => ({ label: `Check ${i + 1}`, description: "Validate service interfaces and rejection paths ".repeat(5) })) }])
    await long.app.onKey("9")
    save(long, "question-batch-scroll")
    const intro = b57Harness(width, height, [{ header: "Details", question: "Explain which integration should be preserved. ".repeat(10), context: "Keep the existing interfaces while migrating the service. ".repeat(50), options: [{ label: "Keep API" }] }])
    save(intro, "question-batch-long-intro")
    h.chat.emit({ type: "server.request.resolved", requestId: h.requestId, resolution: "answered" })
    h.chat.emit({ type: "turn.completed", turnId: h.turnId })
    h.chat.emit({ type: "foreground.state", state: "idle" })
    const itemId = ids("item"), turnId = ids("turn")
    const text = "[x] (medium) Read contracts\n[~] (high) Verify interfaces\n[-] (low) Retire client\n[ ] Add fixtures"
    h.chat.emit({ type: "turn.started", turnId, queueId: ids("queue") })
    h.chat.emit({ type: "item.started", turnId, itemId, kind: "tool_call", meta: { tool: "todo" } })
    h.chat.emit({ type: "item.completed", itemId, status: "ok", text, meta: { done: 1, total: 4 } })
    h.chat.emit({ type: "turn.completed", turnId })
    save(h, "todo-card")
    await h.app.onKey("\x14")
    save(h, "todo-dock")
    const clearId = ids("item"), clearTurn = ids("turn")
    h.chat.emit({ type: "turn.started", turnId: clearTurn, queueId: ids("queue") })
    h.chat.emit({ type: "item.started", turnId: clearTurn, itemId: clearId, kind: "tool_call", meta: { tool: "todo" } })
    h.chat.emit({ type: "item.completed", itemId: clearId, status: "ok", text: "", meta: { done: 0, total: 0 } })
    h.chat.emit({ type: "turn.completed", turnId: clearTurn })
    save(h, "todo-cleared")
    const dataDir = tempDir()
    writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, rightSidebar: true, sidebarWidgets: [{ type: "todos", options: {} }] })
    const bar = appHarness({ width, height, dataDir, directory: "/work/project", mode: "balanced" })
    const chat = conversation(bar.sessionId, bar.app.onEvent)
    chat.exchange("Track the tasks", "The sidebar shows the current task list.")
    const barTurn = ids("turn"), barItem = ids("item")
    chat.emit({ type: "turn.started", turnId: barTurn, queueId: ids("queue") })
    chat.emit({ type: "item.started", turnId: barTurn, itemId: barItem, kind: "tool_call", meta: { tool: "todo" } })
    chat.emit({ type: "item.completed", itemId: barItem, status: "ok", text, meta: { done: 1, total: 4 } })
    chat.emit({ type: "turn.completed", turnId: barTurn })
    save(bar, "todo-sidebar-opt-in")
    for (const scene of [empty, closed, long, intro]) {
      scene.chat.emit({ type: "server.request.resolved", requestId: scene.requestId, resolution: "denied" })
      scene.chat.emit({ type: "turn.completed", turnId: scene.turnId })
      await scene.app.onKey("\x03")
    }
    await h.app.onKey("\x03")
    await bar.app.onKey("\x03")
  }
}
