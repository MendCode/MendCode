/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"
import {
  SessionQuestionsWidget,
  SessionJobsWidget,
  splitWidgetQuestions,
  widgetReasoningLabel,
  type AsyncQuestionRequest,
  type WidgetJob,
} from "@/mend/tui/widgets-runtime"

test("reasoning indicator labels the actual last request and distinguishes manual selection", () => {
  const state = {
    sessionID: "session1",
    mode: "auto" as const,
    effort: "medium",
    reason: "balanced",
    modelID: "model",
    providerID: "provider",
    messageID: "message",
    requestedAt: 1,
  }
  expect(widgetReasoningLabel(state)).toBe("Last request: Auto medium")
  expect(widgetReasoningLabel({ ...state, mode: "manual", effort: "high" })).toBe("Last request: Manual high")
})

const theme = {
  text: RGBA.fromHex("#ffffff"),
  textMuted: RGBA.fromHex("#999999"),
  accent: RGBA.fromHex("#00ff00"),
  backgroundPanel: RGBA.fromHex("#000000"),
}
const request: AsyncQuestionRequest = {
  id: "question1",
  sessionID: "session1",
  async: true,
  questions: [
    {
      question: "Which verification should run next?",
      header: "Verify",
      options: [{ label: "Tests", description: "Run tests" }],
    },
  ],
}

test("async questions stay separate from blocking requests", () => {
  const groups = splitWidgetQuestions([request, { ...request, id: "blocking", async: undefined }])
  expect(groups.blocking.map((item) => item.id)).toEqual(["blocking"])
  expect(groups.asynchronous.map((item) => item.id)).toEqual(["question1"])
})

test("async answer is explicit and job completion updates the widget", async () => {
  const answers: string[] = []
  const cancelled: string[] = []
  const [jobs, setJobs] = createSignal<WidgetJob[]>([
    { id: "job1", sessionID: "session1", kind: "job", status: "running", data: { tool: "grep" }, timeUpdated: 1 },
  ])
  const app = await testRender(
    () => (
      <box flexDirection="column">
        <SessionQuestionsWidget
          questions={[request]}
          width={42}
          height={3}
          theme={theme}
          onAnswer={(id) => answers.push(id)}
        />
        <SessionJobsWidget jobs={jobs()} width={42} height={3} theme={theme} onCancel={(id) => cancelled.push(id)} />
        <input value="Unsent draft" />
      </box>
    ),
    { width: 42, height: 8 },
  )
  try {
    await app.renderOnce()
    await app.renderOnce()
    expect(answers).toEqual([])
    expect(app.captureCharFrame()).toContain("Questions · 1 pending")
    expect(app.captureCharFrame()).toContain("Tools · 1 active")
    const answer = app.renderer.root.findDescendantById("async-question-answer-question1")!
    expect(answer.x + answer.width).toBeLessThanOrEqual(42)
    await app.mockMouse.click(answer.x + 1, answer.y)
    expect(answers).toEqual(["question1"])
    const cancel = app.renderer.root.findDescendantById("async-job-cancel-job1")!
    expect(cancel.x + cancel.width).toBeLessThanOrEqual(42)
    await app.mockMouse.click(cancel.x + 1, cancel.y)
    expect(cancelled).toEqual(["job1"])
    setJobs((current) => current.map((job) => ({ ...job, status: "completed" })))
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("Tools · 0 active")
    expect(app.captureCharFrame()).toContain("grep · completed")
    expect(app.captureCharFrame()).not.toContain("[cancel]")
    expect(app.captureCharFrame()).toContain("Unsent draft")
  } finally {
    app.renderer.destroy()
  }
})
