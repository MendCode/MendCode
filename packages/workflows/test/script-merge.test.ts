import { describe, expect, test } from "bun:test"
import type { MergeOutcome, ScriptMergePort, WorktreeSummary } from "../src"
import { scriptHarness, settle } from "./script-harness"

const META = `{ name: "merge", budget: { agents: 8 } }`
const wf = (body: string) => `export const meta = ${META}\n${body}`

/** A fake git side: records every call, and answers `prepare`/`apply` from a script of outcomes. */
function fakeGit(outcomes: { prepare?: MergeOutcome[]; apply?: MergeOutcome[] } = {}) {
  const calls: Array<{ kind: string; input: unknown }> = []
  const prepare = [...(outcomes.prepare ?? [])]
  const apply = [...(outcomes.apply ?? [])]
  const port: ScriptMergePort = {
    async summarize(input): Promise<WorktreeSummary> {
      calls.push({ kind: "summarize", input })
      return { branch: `mend/wf-${input.taskId.slice(-4)}`, commit: "abc1234", files: 2, insertions: 5, deletions: 1, changed: ["a.ts", "b.ts"] }
    },
    async prepare(input) {
      calls.push({ kind: "prepare", input })
      return prepare.shift() ?? { ok: true, value: { branch: "mend/merge-run", worktree: "/data/merge/run", base: "base", commit: "def5678", merged: input.workspaces.map((entry) => entry.branch), files: 4, insertions: 10, deletions: 2, changed: ["a.ts", "b.ts"] } }
    },
    async apply(input) {
      calls.push({ kind: "apply", input })
      return apply.shift() ?? { ok: true, value: { head: "fff0000", into: "main" } }
    },
  }
  return { port, calls }
}

const TWO_WORKTREES = `
  const results = await parallel([
    () => agent("change a", { mode: "work", worktree: true, detail: true, label: "a" }),
    () => agent("change b", { mode: "work", worktree: true, detail: true, label: "b" }),
  ])
`

describe("worktree results and merge()", () => {
  test("a worktree agent's detail result exposes its branch and the size of its change", async () => {
    const git = fakeGit()
    const h = scriptHarness({ responder: () => "done", worktrees: true, merge: git.port })
    const run = h.start(wf(`const r = await agent("x", { mode: "work", worktree: true, detail: true })\nreturn r`))
    await settle(40)
    const result = JSON.parse(h.get(run).script!.result!)
    expect(result).toMatchObject({ text: "done", branch: expect.stringMatching(/^mend\/wf-/), diff: { commit: "abc1234", files: 2, insertions: 5, deletions: 1, changed: ["a.ts", "b.ts"] } })
    expect(git.calls.filter((call) => call.kind === "summarize")).toHaveLength(1)
    expect(h.get(run).state).toBe("completed")
  })

  test("strategy branch builds the integration branch and returns its summary; nothing is applied and nobody is asked", async () => {
    const git = fakeGit()
    const h = scriptHarness({ responder: () => "done", worktrees: true, merge: git.port })
    const run = h.start(wf(`${TWO_WORKTREES}\nreturn await merge(results, { message: "combine" })`))
    await settle(60)
    const state = h.get(run)
    expect(state.state).toBe("completed")
    expect(JSON.parse(state.script!.result!)).toMatchObject({ branch: "mend/merge-run", files: 4, insertions: 10, deletions: 2, applied: false })
    const prepared = git.calls.find((call) => call.kind === "prepare")!.input as { workspaces: unknown[]; message: string; directory: string }
    expect(prepared).toMatchObject({ message: "combine", directory: "/fake/project" })
    expect(prepared.workspaces).toHaveLength(2)
    expect(git.calls.some((call) => call.kind === "apply")).toBe(false)
    expect(state.tasks.some((task) => task.kind === "human")).toBe(false)
  })

  test("strategy apply asks first: declining keeps the branch, approving merges it into the checkout", async () => {
    const git = fakeGit()
    const h = scriptHarness({ responder: () => "done", worktrees: true, merge: git.port })
    const run = h.start(wf(`${TWO_WORKTREES}\nreturn await merge(results, { strategy: "apply" })`))
    await settle(60)
    const waiting = h.get(run)
    expect(waiting.state).toBe("needs_input")
    const question = waiting.tasks.find((task) => task.kind === "human")!
    expect(question.title).toContain("Merge mend/merge-run into your checkout?")
    expect(question.title).toContain("4 file(s), +10 -2")
    expect(git.calls.some((call) => call.kind === "apply")).toBe(false)
    expect("run" in h.service.control(run.workflowId, "approve", { taskId: question.id, reason: "merge" })).toBe(true)
    await settle(60)
    expect(git.calls.filter((call) => call.kind === "apply")).toEqual([{ kind: "apply", input: { directory: "/fake/project", branch: "mend/merge-run" } }])
    expect(JSON.parse(h.get(run).script!.result!)).toMatchObject({ applied: true, head: "fff0000", into: "main" })

    const declined = fakeGit()
    const h2 = scriptHarness({ responder: () => "done", worktrees: true, merge: declined.port })
    const run2 = h2.start(wf(`${TWO_WORKTREES}\nreturn await merge(results, { strategy: "apply" })`))
    await settle(60)
    const ask = h2.get(run2).tasks.find((task) => task.kind === "human")!
    expect("run" in h2.service.control(run2.workflowId, "approve", { taskId: ask.id, reason: "keep the branch" })).toBe(true)
    await settle(60)
    expect(declined.calls.some((call) => call.kind === "apply")).toBe(false)
    expect(JSON.parse(h2.get(run2).script!.result!)).toMatchObject({ branch: "mend/merge-run", applied: false })
  })

  test("a conflict pauses the run with the files and where to resolve them; resuming prepares again and continues", async () => {
    const git = fakeGit({ prepare: [{ ok: false, conflict: true, message: "merge conflict in 1 file(s): shared.txt (integration worktree /data/merge/run, branch mend/merge-run)" }] })
    const h = scriptHarness({ responder: () => "done", worktrees: true, merge: git.port })
    const run = h.start(wf(`${TWO_WORKTREES}\nreturn await merge(results)`))
    await settle(60)
    const paused = h.get(run)
    expect(paused.state).toBe("paused")
    expect(paused.reason).toContain("shared.txt")
    expect(paused.reason).toContain("resolve them in the integration worktree, then resume")
    expect(h.get(run).script?.host).not.toBe("running")
    expect("run" in h.service.control(run.workflowId, "resume")).toBe(true)
    await settle(80)
    expect(h.get(run).state).toBe("completed")
    expect(git.calls.filter((call) => call.kind === "prepare")).toHaveLength(2)
    // The agents were not run again: the journal answered them.
    expect(git.calls.filter((call) => call.kind === "summarize")).toHaveLength(2)
    expect(JSON.parse(h.get(run).script!.result!)).toMatchObject({ applied: false, files: 4 })
  })

  test("merge refuses results that are not worktree results of this run, and a daemon without git support", async () => {
    const git = fakeGit()
    const h = scriptHarness({ responder: () => "done", worktrees: true, merge: git.port })
    const run = h.start(wf(`
      const plain = await agent("read only", { detail: true })
      let message = ""
      try { await merge([plain]) } catch (error) { message = error.message }
      let empty = ""
      try { await merge([]) } catch (error) { empty = error.message }
      let strategy = ""
      try { await merge([plain], { strategy: "force" }) } catch (error) { strategy = error.message }
      return { message, empty, strategy }
    `))
    await settle(60)
    const result = JSON.parse(h.get(run).script!.result!)
    expect(result.message).toContain("every result must come from agent(..., { worktree: true, detail: true }) of this run")
    expect(result.empty).toContain("non-empty array")
    expect(result.strategy).toContain('strategy must be "branch" or "apply"')
    expect(git.calls.some((call) => call.kind === "prepare")).toBe(false)

    const bare = scriptHarness({ responder: () => "done", worktrees: true })
    const run2 = bare.start(wf(`${TWO_WORKTREES}\nlet message = ""\ntry { await merge(results) } catch (error) { message = error.message }\nreturn message`))
    await settle(60)
    expect(JSON.parse(bare.get(run2).script!.result!)).toContain("needs a git checkout")
  })
})
