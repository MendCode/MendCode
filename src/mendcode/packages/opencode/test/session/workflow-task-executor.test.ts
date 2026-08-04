import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"

import * as MessageV2 from "@/session/message-v2"
import { SessionPrompt, type PromptInput } from "@/session/prompt"
import { WorkflowTaskExecutor } from "@/session/workflow-task-executor"
import { WorkflowPhaseID, WorkflowTaskID, type WorkflowModelRoute, type WorkflowTask } from "@/session/workflow"

const phaseID = WorkflowPhaseID.make("executor-phase")
const taskID = WorkflowTaskID.make("executor-task")

function promptMessage(text: string): MessageV2.WithParts {
  return {
    info: {
      id: "msg_executor_test" as MessageV2.Assistant["id"],
      sessionID: "ses_executor_test" as MessageV2.Assistant["sessionID"],
      role: "assistant",
      time: { created: Date.now() },
      parentID: "msg_parent" as MessageV2.Assistant["parentID"],
      modelID: "gpt-test" as MessageV2.Assistant["modelID"],
      providerID: "openai" as MessageV2.Assistant["providerID"],
      mode: "build",
      agent: "build",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 2, output: 3, reasoning: 0, cache: { read: 0, write: 0 } },
      finish: "stop",
    },
    parts: [
      {
        id: "part_executor_test" as MessageV2.TextPart["id"],
        sessionID: "ses_executor_test" as MessageV2.TextPart["sessionID"],
        messageID: "msg_executor_test" as MessageV2.TextPart["messageID"],
        type: "text",
        text,
      },
    ],
  }
}

function task(overrides?: Partial<WorkflowTask>): WorkflowTask {
  return {
    id: taskID,
    phaseID,
    name: "Executor task",
    kind: "agent",
    prompt: "Return the requested structured result.",
    dependsOn: [],
    output: { kind: "json", schema: { type: "object" } },
    model: { providerID: "openai", modelID: "gpt-5.6", variant: "fast" },
    agentProfile: "specialist",
    ...overrides,
  }
}

function runExecutor(input: {
  task: WorkflowTask
  workflowModel?: WorkflowModelRoute
  promptText: string
  calls: PromptInput[]
  message?: MessageV2.WithParts
}) {
  const promptLayer = Layer.succeed(
    SessionPrompt.Service,
    SessionPrompt.Service.of({
      cancel: () => Effect.void,
      cancelQueued: () => Effect.succeed(false),
      interrupt: () => Effect.void,
      prompt: (prompt: PromptInput) =>
        Effect.sync(() => {
          input.calls.push(prompt)
          return input.message ?? promptMessage(input.promptText)
        }),
      promptAsync: () => Effect.succeed(promptMessage(input.promptText)),
      loop: () => Effect.succeed(promptMessage(input.promptText)),
      shell: () => Effect.succeed(promptMessage(input.promptText)),
      command: () => Effect.succeed(promptMessage(input.promptText)),
      resolvePromptParts: () => Effect.succeed([]),
    }),
  )
  return Effect.runPromise(
    WorkflowTaskExecutor.Service.use((executor) =>
      executor.execute({ task: input.task, sessionID: "ses_executor_root" as never, workflowModel: input.workflowModel }),
    ).pipe(Effect.provide(WorkflowTaskExecutor.layer.pipe(Layer.provide(promptLayer)))),
  )
}

describe("workflow task executor", () => {
  test("routes the declared model and validates structured output", async () => {
    const calls: PromptInput[] = []
    const result = await runExecutor({ task: task(), promptText: '{"answer":"ok"}', calls })

    expect(result).toMatchObject({ state: "completed", usage: { inputTokens: 2, outputTokens: 3 } })
    expect(calls[0]).toMatchObject({
      agent: "specialist",
      model: { providerID: "openai", modelID: "gpt-5.6" },
      variant: "fast",
    })
  })

  test("falls back to the workflow model when a task does not override it", async () => {
    const calls: PromptInput[] = []
    const result = await runExecutor({
      task: task({ model: undefined }),
      workflowModel: { providerID: "openai", modelID: "gpt-workflow", variant: "pro" },
      promptText: '{"answer":"ok"}',
      calls,
    })

    expect(result.state).toBe("completed")
    expect(calls[0]).toMatchObject({
      model: { providerID: "openai", modelID: "gpt-workflow" },
      variant: "pro",
    })
  })

  test("fails with a quality error when JSON output is invalid", async () => {
    const result = await runExecutor({ task: task(), promptText: "not json", calls: [] })

    expect(result).toMatchObject({ state: "failed", failureClass: "quality" })
    expect(result.error).toContain("valid JSON")
  })

  test("classifies an uncollected tool result as an environment failure", async () => {
    const message = promptMessage("")
    message.parts = [
      {
        id: "part_executor_tool" as MessageV2.ToolPart["id"],
        sessionID: message.info.sessionID,
        messageID: message.info.id,
        type: "tool",
        callID: "call_executor_tool",
        tool: "image_gen",
        state: {
          status: "completed",
          input: { prompt: "A cinematic orbital station" },
          title: "image_gen retained",
          output: "result_status: unknown\nconnection_status: lost",
          metadata: { connectionLost: true, resultUnknown: true, status: "retained" },
          time: { start: Date.now(), end: Date.now() },
        },
      },
    ]

    const result = await runExecutor({ task: task(), promptText: "", calls: [], message })

    expect(result).toMatchObject({ state: "failed", failureClass: "environment" })
    expect(result.error).toContain("connection was lost")
    expect(result.error).not.toContain("JSON")
  })

  test("fails when the assistant response lacks a terminal finish", async () => {
    const message = promptMessage('{"answer":"partial"}')
    if (message.info.role === "assistant") message.info.finish = undefined

    const result = await runExecutor({ task: task(), promptText: "", calls: [], message })

    expect(result).toMatchObject({ state: "failed", failureClass: "environment" })
    expect(result.error).toContain("without a terminal finish")
  })

  test("fails when structured output violates its declared schema", async () => {
    const result = await runExecutor({
      task: task({
        output: {
          kind: "json",
          schema: {
            type: "object",
            properties: { answer: { type: "string" } },
            required: ["answer"],
          },
        },
      }),
      promptText: '{"other":"value"}',
      calls: [],
    })

    expect(result).toMatchObject({ state: "failed", failureClass: "quality" })
    expect(result.error).toContain("declared schema")
  })
})
