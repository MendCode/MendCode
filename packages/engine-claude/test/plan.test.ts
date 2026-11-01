import { describe, expect, test } from "bun:test"
import { createIdFactory } from "@mendcode/protocol"
import type { EngineEvent } from "@mendcode/kernel"
import { claudeToolTitle, createClaudePlan, createTurnMapper } from "../src"

const ids = createIdFactory()

/** A main-thread tool call as Claude Code streams it: the block starts, its input arrives, the block stops. */
function toolUse(index: number, id: string, name: string, input: unknown) {
  return [
    { type: "stream_event", event: { type: "content_block_start", index, content_block: { type: "tool_use", id, name } } },
    { type: "stream_event", event: { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } } },
    { type: "stream_event", event: { type: "content_block_stop", index } },
  ]
}
const result = (id: string, text: string, isError = false) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: isError }] } })

function turn(plan = createClaudePlan()) {
  const events: EngineEvent[] = []
  const mapper = createTurnMapper({ newItemId: () => ids("item"), emit: (event) => void events.push(event), model: "claude-sonnet-5-5", plan })
  const feed = (...messages: unknown[]) => { for (const message of messages.flat()) mapper.accept(message as never) }
  const completed = () => events.filter((event): event is Extract<EngineEvent, { type: "item.completed" }> => event.type === "item.completed")
  return { events, feed, completed, plan }
}

describe("Claude Code task lists become MendCode's list card", () => {
  test("TodoWrite: the card is named todo d/n from the start and ends with the checklist, the item in progress as its activeForm", () => {
    const t = turn()
    const todos = [
      { content: "Read the parser", status: "completed", activeForm: "Reading the parser" },
      { content: "Fix the off-by-one", status: "in_progress", activeForm: "Fixing the off-by-one" },
      { content: "Run the tests", status: "pending", activeForm: "Running the tests" },
    ]
    t.feed(toolUse(0, "toolu_1", "TodoWrite", { todos }), result("toolu_1", "Todos have been modified successfully. Ensure that you continue to use the todo list to track your progress."))
    expect(t.events.find((event) => event.type === "item.started")).toMatchObject({ kind: "tool_call", meta: { tool: "todo 1/3" } })
    expect(t.completed().at(-1)).toMatchObject({ status: "ok", text: "[x] Read the parser\n[~] Fixing the off-by-one\n[ ] Run the tests", meta: { tool: "todo 1/3", retitled: true } })
    expect(claudeToolTitle("TodoWrite", { todos: [] })).toBe("todo 0/0")
  })

  test("TaskCreate and TaskUpdate add up to one list across turns; a deleted task leaves it and a failed call changes nothing", () => {
    const plan = createClaudePlan()
    const first = turn(plan)
    first.feed(
      toolUse(0, "toolu_a", "TaskCreate", { subject: "Write the migration", activeForm: "Writing the migration" }), result("toolu_a", "Task #1 created successfully: Write the migration"),
      toolUse(1, "toolu_b", "TaskCreate", { subject: "Backfill old rows" }), result("toolu_b", "Task #2 created successfully: Backfill old rows"),
      toolUse(2, "toolu_c", "TaskCreate", { subject: "Drop the column" }), result("toolu_c", "Task #3 created successfully: Drop the column"),
    )
    // Until its result names the task, the card has Claude Code's own name; the result renames it.
    expect(first.events.filter((event) => event.type === "item.started").map((event) => (event as { meta?: { tool?: string } }).meta?.tool)).toEqual(["TaskCreate", "TaskCreate", "TaskCreate"])
    expect(first.completed().at(-1)).toMatchObject({ text: "[ ] Write the migration\n[ ] Backfill old rows\n[ ] Drop the column", meta: { tool: "todo 0/3", retitled: true } })
    const second = turn(plan)
    second.feed(
      toolUse(0, "toolu_d", "TaskUpdate", { taskId: "1", status: "in_progress" }), result("toolu_d", "Updated task #1 status"),
      toolUse(1, "toolu_e", "TaskUpdate", { taskId: "3", status: "deleted" }), result("toolu_e", "Updated task #3 deleted"),
      toolUse(2, "toolu_f", "TaskUpdate", { taskId: "2", status: "completed" }), result("toolu_f", "Task #2 not found", true),
    )
    const cards = second.completed()
    expect(cards[0]).toMatchObject({ text: "[~] Writing the migration\n[ ] Backfill old rows\n[ ] Drop the column", meta: { tool: "todo 0/3" } })
    expect(cards[1]).toMatchObject({ text: "[~] Writing the migration\n[ ] Backfill old rows", meta: { tool: "todo 0/2" } })
    expect(cards[2]).toMatchObject({ status: "error", text: "Task #2 not found" })
    expect(cards[2]).not.toHaveProperty("meta")
  })

  test("a task first seen in an update (a resumed process) joins the list under its id until it is named", () => {
    const t = turn()
    t.feed(toolUse(0, "toolu_g", "TaskUpdate", { taskId: "7", status: "completed" }), result("toolu_g", "Updated task #7 status"))
    expect(t.completed().at(-1)).toMatchObject({ text: "[x] Task #7", meta: { tool: "todo 1/1" } })
  })

  test("a sub-agent's TodoWrite shows its checklist in the agent's thread and never touches the session's list", () => {
    const plan = createClaudePlan()
    const t = turn(plan)
    t.feed(toolUse(0, "toolu_agent", "Agent", { description: "Look around", subagent_type: "general-purpose", prompt: "Look" }))
    const agentCall = t.events.find((event) => event.type === "item.started")!
    t.feed(
      { type: "assistant", message: { id: "msg_a", content: [{ type: "tool_use", id: "toolu_sub", name: "TodoWrite", input: { todos: [{ content: "Scan", status: "in_progress", activeForm: "Scanning" }] } }] }, parent_tool_use_id: "toolu_agent" },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "toolu_sub", content: "Todos have been modified successfully." }] }, parent_tool_use_id: "toolu_agent" },
    )
    const done = t.completed().find((event) => event.meta?.agentParent === ("itemId" in agentCall ? agentCall.itemId : ""))
    expect(done?.text).toBe("[~] Scanning")
    expect(plan.apply("TaskUpdate", { taskId: "1", status: "pending" }, "")).toMatchObject({ text: "[ ] Task #1" })
  })
})
