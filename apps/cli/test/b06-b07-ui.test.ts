import { afterEach, expect, test } from "bun:test"
import type { CommandReply } from "@mendcode/client"
import type { ExtractionJob, TaskRecord } from "@mendcode/protocol"
import { appHarness, cleanTemps, ids, NOW, tempDir } from "./session-ui-harness"
import { createMemoryPageState, memoryPageKey, renderMemoryPage } from "../src/view/memory-page"
import { EXTRACTION_OPTIONS } from "../src/view/memory-extraction-tab"
import { textWidth } from "../src/view/wrap"
import { renderTasksPage } from "../src/view/tasks-page"

afterEach(cleanTemps)
const task: TaskRecord = { taskId: ids("session"), parentId: ids("session"), rootId: ids("session"), depth: 1, generation: 2, description: "Review entry points", agent: "explore", background: true, state: "completed", result: "Found apps/cli/src/ui/app.ts and its feature factories.", createdAt: NOW, updatedAt: NOW }
const job: Omit<ExtractionJob, "text"> = { jobId: "extract_turn", sessionId: task.parentId, turnId: ids("turn"), directory: "/work/project", state: "failed", reason: "Invalid extraction result", attempts: 3, nextAttemptAt: NOW, proposed: 0, createdAt: NOW, updatedAt: NOW }

function harness() {
  let settings = { memoryUse: true, memoryGenerate: false, onboarded: true }
  return appHarness({ width: 100, height: 30, dataDir: tempDir(), directory: "/work/project", sessionId: task.parentId, reply: (command) => {
    if (command.type === "settings.set") settings = { ...settings, ...command.patch }
    const result = command.type === "session.list" ? { sessions: [{ sessionId: task.parentId, title: "Working session", directory: "/work/project", state: "generating", createdAt: NOW, updatedAt: NOW, lastSeq: 1, queued: 0 }] } : command.type === "task.list" ? { tasks: [task] } : command.type === "memory.extraction.list" ? { jobs: [job], configured: false } : command.type === "settings.set" ? { settings } : command.type === "session.create" ? { sessionId: ids("session") } : command.type === "memory.list" ? { memories: [] } : command.type === "memory.categories" ? { categories: [] } : undefined
    return { ok: true, ...(result ? { result } : {}) } as CommandReply
  } })
}

test("tasks page loads daemon records, clamps selection, opens the real child chat", async () => {
  const h = harness()
  h.app.applySettings({ onboarded: true })
  await h.type("/tasks\r")
  expect(h.text().join("\n")).toContain("Review entry points")
  expect(h.text().join("\n")).toContain(task.taskId)
  await h.app.onKey("\x1b[B")
  await h.app.onKey("\r")
  expect(h.subscriptions.at(-1)?.sessionId).toBe(task.taskId)
})

test("bg detaches first, keeps the original session alive and opens Agent View", async () => {
  const h = harness()
  h.app.applySettings({ onboarded: true })
  await h.type("/bg\r")
  const at = h.sent.findIndex((command) => command.type === "session.detach")
  expect(h.sent[at]).toMatchObject({ sessionId: task.parentId })
  expect(h.sent.slice(at).some((command) => command.type === "session.create")).toBe(true)
  expect(h.sent.some((command) => command.type === "turn.cancel")).toBe(false)
  expect(h.text().join("\n")).toContain("Agent View")
})

test("memory opens extraction controls; generation toggles through settings.set", async () => {
  const h = harness()
  h.app.applySettings({ onboarded: true })
  await h.type("/memory\r")
  await h.app.onKey("8")
  expect(h.text().join("\n")).toContain("Extractor not configured")
  await h.app.onKey("\x1b[B")
  await h.app.onKey("\x1b[B")
  await h.app.onKey("\r")
  expect(h.sent.some((command) => command.type === "settings.set" && command.patch.memoryGenerate === true)).toBe(true)
  expect(h.sent.some((command) => command.type === "memory.extraction.list")).toBe(true)
})

test("extraction retry targets only the selected failed job", async () => {
  const h = harness()
  h.app.applySettings({ onboarded: true })
  await h.type("/memory\r")
  await h.app.onKey("8")
  for (let i = 0; i < EXTRACTION_OPTIONS.length; i++) await h.app.onKey("\x1b[B")
  await h.app.onKey("r")
  expect(h.sent.find((command) => command.type === "memory.extraction.retry")).toMatchObject({ jobId: job.jobId })
})

test("numeric memory caps do not switch tabs mid edit and reject values outside the protocol cap", () => {
  const state = { ...createMemoryPageState(), tab: "extraction" as const, extraction: { selected: 4, editing: "32001" } }
  expect(memoryPageKey(state, "\r", []).action.type).toBe("none")
  const valid = memoryPageKey({ ...state, extraction: { selected: 4, editing: "2048" } }, "\r", [])
  expect(valid.action).toEqual({ type: "memorySetting", key: "memoryMaxPromptTokens", value: 2048 })
  expect(memoryPageKey(state, "8", []).state.tab).toBe("extraction")
  expect(memoryPageKey(state, "\x1b", []).state.extraction.editing).toBeUndefined()
})

test("compact extraction keeps the selected failure details visible in a full queue", () => {
  const jobs = Array.from({ length: 80 }, (_, index) => ({ ...job, jobId: `extract_${index}`, reason: `Failure ${index}` }))
  const frame = renderMemoryPage({ memories: [], state: { ...createMemoryPageState(), tab: "extraction", extraction: { selected: EXTRACTION_OPTIONS.length + 40 } }, data: { extraction: { jobs, configured: true } }, width: 60, height: 19, now: NOW })
  expect(frame.map((line) => line.map((span) => span.text).join("")).join("\n")).toContain("Failure 40")
})

for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) {
  test(`task and extraction panels fit ${width}x${height}`, () => {
    const screens = [renderTasksPage({ tasks: [task], selected: 0, width: width!, height: height! }), renderMemoryPage({ memories: [], state: { ...createMemoryPageState(), tab: "extraction" }, data: { extraction: { jobs: [job], configured: true } }, width: width!, height: height!, now: NOW })]
    for (const screen of screens) {
      expect(screen).toHaveLength(height!)
      expect(screen.every((line) => textWidth(line.map((span) => span.text).join("")) <= width!)).toBe(true)
      if (width! >= 70) expect(screen.map((line) => line.map((span) => span.text).join("")).join("\n")).toContain("┌")
    }
  })
}

test("an opened child shows what it ran on, what it spent, the files it wrote and its branch; the list row stays one line", () => {
  const isolated: TaskRecord = {
    ...task,
    result: "Moved the router.\n\n[worktree] /data/tasks/worktrees/abc · branch mend/task-abc @ 1a2b3c · 2 files +10 -2 · not merged; review: git diff 1a2b3c mend/task-abc",
    run: { model: "gpt-6-luna", name: "GPT-6-Luna", provider: "openai", engine: "native", effort: "low" },
    stats: { input: 48_213, output: 1_204, costMicros: 41_000, files: ["src/router.ts"] },
    worktree: { path: "/data/tasks/worktrees/abc", base: "1a2b3c4d", branch: "mend/task-abc", commit: "1a2b3c", files: 2, insertions: 10, deletions: 2, changed: ["src/router.ts", "src/main.ts"] },
  }
  const text = renderTasksPage({ tasks: [isolated, task], selected: 0, width: 140, height: 24 }).map((line) => line.map((span) => span.text).join("")).join("\n")
  for (const fact of ["Model    GPT-6-Luna · openai · native · low", "Usage    48.2K in · 1,204 out · $0.04", "Files    2 files · src/router.ts, src/main.ts", "Branch   mend/task-abc @ 1a2b3c · not merged", "Moved the router."]) expect(text).toContain(fact)
  expect(text).not.toContain("[worktree]")
  expect(text).toContain("› completed · Review entry points")
  // A child that never ran has no facts to show, only its result.
  const bare = renderTasksPage({ tasks: [task], selected: 0, width: 140, height: 24 }).map((line) => line.map((span) => span.text).join("")).join("\n")
  for (const label of ["Model ", "Usage ", "Files ", "Branch "]) expect(bare).not.toContain(label)
})
