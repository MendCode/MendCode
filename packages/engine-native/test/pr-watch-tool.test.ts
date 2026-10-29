import { expect, test } from "bun:test"
import type { Settings } from "@mendcode/protocol"
import { prWatchTool, worktreeTool, type PrWatchPort, type WorktreePort } from "@mendcode/tools"
import { createNativeEngine, memoryHistory } from "../src"
import { callTool, scriptedProvider, stop, turn } from "./harness"

function port(log: string[]): PrWatchPort {
  return {
    preview: async ({ pr }) => ({ problems: [], detail: `Run gh pr view ${pr ?? "(current branch)"} now and about every minute.` }),
    watch: async ({ pr }) => (log.push(`watch ${pr ?? ""}`), { ok: true, text: "Watching PR #7" }),
    unwatch: ({ pr }) => (log.push(`unwatch ${pr ?? ""}`), { ok: true, text: "Stopped watching #7." }),
    list: () => "#7 watching",
  }
}

const on: Settings = { experimental: { pr_watch: true } }
const options = (script: ReturnType<typeof scriptedProvider>, log: string[], settings: () => Settings) => ({ provider: script.provider, tools: [prWatchTool], history: memoryHistory(), cwdFor: () => "/tmp", system: () => "SYS", compactionPrompt: "C", prWatch: () => port(log), permissionPolicy: settings })

test("the pr_watch tool is offered only while experimental.pr_watch is on and a port exists", async () => {
  let settings: Settings = {}
  const script = scriptedProvider([stop("Off"), stop("On")])
  const engine = createNativeEngine(options(script, [], () => settings))
  const input = turn({ text: "Hello" }).input
  await engine.runTurn(input)
  settings = on
  await engine.runTurn({ ...input })
  expect(script.requests[0]!.tools.map((tool) => tool.name)).not.toContain("pr_watch")
  expect(script.requests[1]!.tools.map((tool) => tool.name)).toContain("pr_watch")
  const none = scriptedProvider([stop("No port")])
  const { prWatch: _absent, ...withoutPort } = options(none, [], () => on)
  await createNativeEngine(withoutPort).runTurn(turn({ text: "Hello" }).input)
  expect(none.requests[0]!.tools.map((tool) => tool.name)).not.toContain("pr_watch")
})

test("the minimalist tier keeps it out even with the flag on", async () => {
  const script = scriptedProvider([stop("Quiet")])
  await createNativeEngine(options(script, [], () => ({ ...on, tier: "minimalist" }))).runTurn(turn({ text: "Hello" }).input)
  expect(script.requests[0]!.tools.map((tool) => tool.name)).not.toContain("pr_watch")
})

test("starting a watch asks first, with the network use in the approval, and runs only when approved", async () => {
  const log: string[] = []
  const script = scriptedProvider([callTool("pr_watch", { action: "watch", pr: "7" }), stop("Watching")])
  const approved = turn({ text: "Watch PR 7", answers: [{ kind: "approve", scope: "once" }] })
  await createNativeEngine(options(script, log, () => on)).runTurn(approved.input)
  expect(approved.asked).toHaveLength(1)
  expect(JSON.stringify(approved.asked[0])).toContain("Run gh pr view 7 now and about every minute.")
  expect(log).toEqual(["watch 7"])
  const refusing = scriptedProvider([callTool("pr_watch", { action: "watch", pr: "8" }), stop("Declined")])
  await createNativeEngine(options(refusing, log, () => on)).runTurn(turn({ text: "Watch PR 8" }).input)
  expect(log).toEqual(["watch 7"])
})

test("list and unwatch need no approval", async () => {
  const log: string[] = []
  const script = scriptedProvider([callTool("pr_watch", { action: "list" }), callTool("pr_watch", { action: "unwatch" }), stop("Done")])
  const current = turn({ text: "What am I watching?" })
  await createNativeEngine(options(script, log, () => on)).runTurn(current.input)
  expect(current.asked).toEqual([])
  expect(log).toEqual(["unwatch "])
  expect(script.requests[1]!.messages.some((message) => message.role === "tool" && message.output.includes("#7 watching"))).toBe(true)
})

function treePort(log: string[]): WorktreePort {
  return {
    status: () => "Working in the project checkout /repo.",
    preview: async ({ action, target }) => ({ problems: [], detail: `${action} ${target ?? ""} preview` }),
    enter: async ({ name, branch, base }) => (log.push(`enter ${name ?? ""} ${branch ?? ""} ${base ?? ""}`), { ok: true, text: "Entered.", directory: "/data/wt" }),
    exit: async () => ({ ok: true, text: "Left.", directory: "/repo" }),
    list: async () => "1 worktree of this project\n- wt · branch mend/wt · /data/wt",
    handoff: async ({ target }) => (log.push(`handoff ${target}`), { ok: true, text: "Moved.", directory: "/data/wt" }),
    close: async ({ target }) => (log.push(`close ${target ?? ""}`), { ok: true, text: "Closed." }),
  }
}

test("worktree list is a read; enter with a base, handoff and close ask first and reach the port", async () => {
  const log: string[] = []
  const settings: Settings = { experimental: { worktree_tool: true } }
  const make = (steps: ReturnType<typeof callTool>[], answers: Array<{ kind: "approve"; scope: "once" }>) => {
    const script = scriptedProvider([...steps, stop("Done")])
    const current = turn({ text: "Go", answers })
    return { run: () => createNativeEngine({ provider: script.provider, tools: [worktreeTool], history: memoryHistory(), cwdFor: () => "/tmp", system: () => "SYS", compactionPrompt: "C", worktrees: () => treePort(log), permissionPolicy: () => settings }).runTurn(current.input), current, script }
  }
  const listing = make([callTool("worktree", { action: "list" })], [])
  await listing.run()
  expect(listing.current.asked).toEqual([])
  expect(listing.script.requests[1]!.messages.some((message) => message.role === "tool" && message.output.includes("branch mend/wt"))).toBe(true)
  const stacked = make([callTool("worktree", { action: "enter", name: "child", branch: "fix", base: "parent" })], [{ kind: "approve", scope: "once" }])
  await stacked.run()
  expect(stacked.current.asked).toHaveLength(1)
  const handoff = make([callTool("worktree", { action: "handoff", target: "wt" })], [{ kind: "approve", scope: "once" }])
  await handoff.run()
  expect(JSON.stringify(handoff.current.asked[0])).toContain("handoff wt preview")
  const closing = make([callTool("worktree", { action: "close", target: "wt" })], [{ kind: "approve", scope: "once" }])
  await closing.run()
  const missing = make([callTool("worktree", { action: "handoff" })], [{ kind: "approve", scope: "once" }])
  await missing.run()
  expect(log).toEqual(["enter child fix parent", "handoff wt", "close wt"])
  expect(missing.script.requests[1]!.messages.some((message) => message.role === "tool" && message.output.includes("handoff needs target"))).toBe(true)
})
