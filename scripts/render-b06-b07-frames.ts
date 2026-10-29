import { writeFileSync } from "node:fs"
import path from "node:path"
import type { ExtractionJob, Settings, TaskRecord } from "@mendcode/protocol"
import { parityHarness } from "../apps/cli/test/parity-b01-b02-harness"
import { conversation, ids, NOW, type Harness } from "../apps/cli/test/session-ui-harness"
import { fit } from "../apps/cli/src/view/deck"
import { MODEL_PAGE_ROWS } from "../apps/cli/src/view/model-page"
import { EXTRACTION_OPTIONS } from "../apps/cli/src/view/memory-extraction-tab"
import { textWidth } from "../apps/cli/src/view/wrap"

export async function renderB06B07Frames(directory: string, sizes: string[]) {
  for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
    const match = /^(\d+)x(\d+)$/.exec(size)
    if (!match) throw new Error(`Invalid size: ${size}`)
    const width = Number(match[1]), height = Number(match[2])
    const sessionId = ids("session")
    const child: TaskRecord = { taskId: ids("session"), parentId: sessionId, rootId: sessionId, depth: 1, generation: 2, description: "Review CLI factories", agent: "explore", state: "completed", background: true, result: "Entry point: apps/cli/src/ui/app.ts\nFeatures: app/slash.ts, app/page-keys.ts\nViews use Line[] and the shared panel grid.", createdAt: NOW - 10_000, updatedAt: NOW }
    let tasks: TaskRecord[] = []
    let jobs: Omit<ExtractionJob, "text">[] = []
    let detached = false
    let configured = false
    let settings: Settings = { onboarded: true, memoryUse: true, memoryGenerate: false }
    const h = parityHarness({ width, height, sessionId, reply: (command) => {
      if (command.type === "session.detach") detached = true
      if (command.type === "session.list" && detached) return { ok: true, result: { sessions: [{ sessionId, title: "Review the factories", directory: "/work/mendcode", state: "generating", createdAt: NOW, updatedAt: NOW, queued: 0, lastSeq: 1 }] } }
      if (command.type === "settings.set") settings = { ...settings, ...command.patch }
      if (command.type === "memory.extraction.retry") jobs = jobs.map((job) => job.jobId === command.jobId ? { ...job, state: "queued", attempts: 0, reason: "" } : job)
      const result = command.type === "task.list" ? { tasks } : command.type === "memory.extraction.list" ? { configured, jobs, maintenance: { policy: settings.memoryMaintenance ?? "disabled", duplicates: [] } } : command.type === "memory.list" ? { memories: [] } : command.type === "memory.categories" ? { categories: [] } : command.type === "session.create" ? { sessionId: ids("session") } : command.type === "settings.set" ? { settings } : undefined
      return result ? { ok: true, result } : undefined
    } })
    const save = (name: string, page: string) => {
      if (h.app.page !== page) throw new Error(`${name}: expected ${page}, got ${h.app.page}`)
      h.app.render()
      const frame = h.frames.at(-1)!
      if (frame.length !== height || frame.some((line) => textWidth(line.map((span) => span.text).join("")) > width)) throw new Error(`Overflow: ${name} ${size}`)
      const rows = frame.map((line) => fit(line, width).map((span) => span.text).join(""))
      if (rows.some((row) => /[\x00\x1b]/.test(row))) throw new Error(`Control sequence: ${name}`)
      writeFileSync(path.join(directory, `${name}-${size}.txt`), rows.join("\n") + "\n")
    }
    const open = async (command: string) => { await h.app.onKey("\x1b"); await h.type(command + "\r") }
    await h.type("/tasks\r")
    save("tasks-empty", "tasks")
    tasks = [child, { ...child, taskId: ids("session"), description: "Check permissions", state: "needs_input", result: "", generation: 1 }]
    await h.app.onKey("r")
    save("tasks-completed", "tasks")
    await h.app.onKey("\x1b[B")
    save("tasks-needs-input", "tasks")
    await open("/memory")
    await h.app.onKey("8")
    save("memory-extraction-unconfigured", "memory")
    configured = true
    settings = { ...settings, memoryGenerate: true, memoryMaintenance: "preview" }
    h.app.applySettings(settings)
    jobs = ["queued", "running", "failed", "completed"].map((state, index) => ({ jobId: `extract_${index + 1}`, sessionId, turnId: ids("turn"), directory: "/work/mendcode", state: state as ExtractionJob["state"], attempts: index, nextAttemptAt: NOW, proposed: state === "completed" ? 2 : 0, reason: state === "failed" ? "Invalid extraction result" : "", createdAt: NOW, updatedAt: NOW }))
    await h.app.onKey("r")
    save("memory-extraction-queue", "memory")
    for (let index = 0; index < EXTRACTION_OPTIONS.length + 2; index++) await h.app.onKey("\x1b[B")
    save("memory-extraction-failed", "memory")
    await h.app.onKey("r")
    save("memory-extraction-retry", "memory")
    for (let index = 0; index < EXTRACTION_OPTIONS.length - 2; index++) await h.app.onKey("\x1b[A")
    await h.app.onKey("\r")
    save("memory-extraction-edit-cap", "memory")
    await h.app.onKey("\x1b")
    await open("/model")
    for (let index = 0; index < MODEL_PAGE_ROWS.indexOf("memoryExtractor"); index++) await h.app.onKey("\x1b[B")
    save("model-memory-extractor", "model")
    await h.app.onKey("\x1b")
    const chat = conversation(h.sessionId, h.app.onEvent)
    chat.exchange("Review the factories", "The child session owns the review transcript.")
    const turnId = ids("turn"), itemId = ids("item")
    chat.emit({ type: "turn.started", turnId, queueId: ids("queue") })
    chat.emit({ type: "item.started", turnId, itemId, kind: "tool_call", meta: { tool: "task", description: child.description, agent: child.agent } })
    chat.emit({ type: "item.completed", itemId, status: "ok", text: `task_id: ${child.taskId}\nstate: completed\n${child.result}` })
    chat.emit({ type: "turn.completed", turnId })
    save("chat-persistent-task", "chat")
    h.app.onGlobal({ type: "session.activity", gseq: 1, at: NOW, sessionId, title: "Review the factories", directory: "/work/mendcode", state: "generating", updatedAt: NOW })
    await h.type("/bg\r")
    save("home-detached-agent-view", "chat")
    await dispose(h)
  }
}
async function dispose(h: Harness) { await h.app.onKey("\x03"); await h.app.onKey("\x03") }
