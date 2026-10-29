import { expect, test } from "bun:test"
import type { Settings } from "@mendcode/protocol"
import { worktreeTool, type WorktreePort } from "@mendcode/tools"
import { createNativeEngine, memoryHistory } from "../src"
import { callTool, scriptedProvider, stop, turn } from "./harness"

function port(log: string[]): WorktreePort {
  return {
    status: () => "Working in the project checkout /repo.",
    preview: async () => ({ problems: [], detail: "Create a worktree and move this session into it." }),
    enter: async ({ name }) => (log.push(`enter ${name ?? ""}`), { ok: true, text: "Entered worktree wt.", directory: "/data/worktrees/wt" }),
    exit: async () => (log.push("exit"), { ok: true, text: "Left.", directory: "/repo" }),
  }
}

const on: Settings = { experimental: { worktree_tool: true } }

test("the worktree tool is offered only while experimental.worktree_tool is on", async () => {
  let settings: Settings = {}
  const script = scriptedProvider([stop("Off"), stop("On")])
  const engine = createNativeEngine({ provider: script.provider, tools: [worktreeTool], history: memoryHistory(), cwdFor: () => "/tmp", system: () => "SYS", compactionPrompt: "C", worktrees: () => port([]), permissionPolicy: () => settings })
  const input = turn({ text: "Hello" }).input
  await engine.runTurn(input)
  settings = on
  await engine.runTurn({ ...input })
  expect(script.requests[0]!.tools.map((tool) => tool.name)).not.toContain("worktree")
  expect(script.requests[1]!.tools.map((tool) => tool.name)).toContain("worktree")
})

test("entering a worktree asks the user first and runs through the session's port only when approved", async () => {
  const log: string[] = []
  const script = scriptedProvider([callTool("worktree", { action: "enter", name: "idea" }), stop("Entered")])
  const engine = createNativeEngine({ provider: script.provider, tools: [worktreeTool], history: memoryHistory(), cwdFor: () => "/tmp", system: () => "SYS", compactionPrompt: "C", worktrees: () => port(log), permissionPolicy: () => on })
  const approved = turn({ text: "Isolate this", answers: [{ kind: "approve", scope: "once" }] })
  await engine.runTurn(approved.input)
  expect(approved.asked).toHaveLength(1)
  expect(approved.asked[0]).toMatchObject({ kind: "approval", title: "Use a git worktree" })
  expect(JSON.stringify(approved.asked[0])).toContain("Create a worktree and move this session into it.")
  expect(log).toEqual(["enter idea"])
  const refusing = scriptedProvider([callTool("worktree", { action: "enter" }), stop("Declined")])
  const second = createNativeEngine({ provider: refusing.provider, tools: [worktreeTool], history: memoryHistory(), cwdFor: () => "/tmp", system: () => "SYS", compactionPrompt: "C", worktrees: () => port(log), permissionPolicy: () => on })
  await second.runTurn(turn({ text: "Isolate this" }).input)
  expect(log).toEqual(["enter idea"])
})

test("status needs no approval", async () => {
  const log: string[] = []
  const script = scriptedProvider([callTool("worktree", { action: "status" }), stop("Checked")])
  const engine = createNativeEngine({ provider: script.provider, tools: [worktreeTool], history: memoryHistory(), cwdFor: () => "/tmp", system: () => "SYS", compactionPrompt: "C", worktrees: () => port(log), permissionPolicy: () => on })
  const current = turn({ text: "Where am I?" })
  await engine.runTurn(current.input)
  expect(current.asked).toEqual([])
  expect(script.requests[1]!.messages.some((message) => message.role === "tool" && message.output.includes("project checkout /repo"))).toBe(true)
})
