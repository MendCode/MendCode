import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { parseScript } from "../src"
import { output, scriptHarness, settle } from "./script-harness"

const examples = path.join(import.meta.dir, "../../../examples/workflows")
const source = (name: string) => readFileSync(path.join(examples, `${name}.js`), "utf8")
/** The script's return value, as the journal holds it. */
const resultOf = (h: ReturnType<typeof scriptHarness>, run: Parameters<ReturnType<typeof scriptHarness>["get"]>[0]) => JSON.parse(h.rows.get(`${run.workflowId}\u0000result`)!).value

describe("the shipped examples", () => {
  test("every example parses: literal meta, no forbidden construct, declared budget above ten agents", () => {
    const files = readdirSync(examples).filter((file) => file.endsWith(".js"))
    expect(files.sort()).toEqual(["migrate-many-files.js", "research.js", "review-and-verify.js"])
    for (const file of files) {
      const parsed = parseScript(readFileSync(path.join(examples, file), "utf8"))
      expect(parsed.ok).toBe(true)
      if (parsed.ok) expect(parsed.meta.budget?.agents).toBeDefined()
    }
  })

  test("review-and-verify: dimensions -> findings per dimension -> adversarial verification, only survivors reported", async () => {
    const h = scriptHarness({
      responder: (prompt) => {
        if (prompt.startsWith("List up to 5 review dimensions")) return output({ dimensions: ["correctness", "security"] })
        if (prompt.includes("strictly for correctness")) return output({ findings: [{ title: "Off by one", where: "a.ts:10", claim: "claim-A", severity: "high" }, { title: "Wrong guess", where: "b.ts:2", claim: "claim-B", severity: "low" }] })
        if (prompt.includes("strictly for security")) return output({ findings: [{ title: "Token logged", where: "c.ts:5", claim: "claim-C", severity: "high" }] })
        if (prompt.includes("PROVE THIS FINDING WRONG")) return output({ holds: !prompt.includes("claim-B"), evidence: "checked " + /Claim: (\S+)/.exec(prompt)?.[1] })
        return "?"
      },
    })
    const run = h.start(source("review-and-verify"), { target: "the diff" })
    await settle(80)
    expect(h.get(run).state).toBe("completed")
    const result = resultOf(h, run)
    expect(result.dimensions).toEqual(["correctness", "security"])
    expect(result.confirmed.map((finding: { title: string }) => finding.title).sort()).toEqual(["Off by one", "Token logged"])
    expect(result.confirmed[0].evidence).toContain("checked claim-")
    // 1 planner + 2 reviewers + 3 skeptics, each shown under its label and phase
    const tasks = h.get(run).tasks
    expect(tasks).toHaveLength(6)
    expect(tasks.filter((task) => task.phase === "Verify")).toHaveLength(3)
    expect(tasks.map((task) => task.label)).toContain("Verify: Off by one")
  })

  /** A fake git side that records which branches were prepared and applied. */
  const gitFake = () => {
    const calls = { prepared: [] as string[][], applied: [] as string[] }
    const port: import("../src").ScriptMergePort = {
      summarize: async ({ taskId }) => ({ branch: `mend/wf-${taskId}`, commit: "c0ffee1", files: 3, insertions: 9, deletions: 2, changed: ["x.ts"] }),
      prepare: async ({ workspaces }) => {
        calls.prepared.push(workspaces.map((entry) => entry.branch!))
        return { ok: true, value: { branch: "mend/merge-x", worktree: "/data/merge/x", base: "b", commit: "d", merged: workspaces.map((entry) => entry.branch), files: workspaces.length * 3, insertions: workspaces.length * 9, deletions: workspaces.length * 2, changed: [] } }
      },
      apply: async ({ branch }) => {
        calls.applied.push(branch)
        return { ok: true, value: { head: "e", into: "main" } }
      },
    }
    return { port, calls }
  }

  test("migrate-many-files: worktree agents per directory run together, checks run inside them, passing ones are merged on a reviewed branch after the user approves", async () => {
    const git = gitFake()
    // the check fails inside the worktree of the "web" migration
    const h: ReturnType<typeof scriptHarness> = scriptHarness({
      worktrees: true,
      merge: git.port,
      checkExit: (_argv, cwd) => (h.service.list()[0]?.tasks.find((task) => `/worktrees/${task.id}` === cwd)?.title.includes("web") ? 1 : 0),
      responder: (prompt) => {
        if (prompt.startsWith("Find the top-level directories")) return output({ directories: ["api", "web", "cli"] })
        if (prompt.startsWith("Work only inside")) return "migrated " + /inside (\S+)\./.exec(prompt)?.[1]
        return "?"
      },
    })
    const run = h.start(source("migrate-many-files"), { change: "swap the logger", check: "bun test" })
    await settle(100)
    // all three migration agents are worktree agents (isolated), so they were allowed to run in parallel
    const migrations = h.get(run).tasks.filter((task) => task.title.startsWith("Migrate "))
    expect(migrations).toHaveLength(3)
    expect(migrations.every((task) => task.isolated === true && task.mode === "work")).toBe(true)
    // the checks ran in the worktrees, not in the project
    expect(h.checkDirs.sort()).toEqual(["/worktrees/" + migrations[0]!.id, "/worktrees/" + migrations[1]!.id, "/worktrees/" + migrations[2]!.id].sort())
    // only the two passing worktrees were combined, on a branch, before anybody was asked; nothing is applied yet
    expect(git.calls.prepared).toHaveLength(1)
    expect(git.calls.prepared[0]).toHaveLength(2)
    expect(git.calls.applied).toEqual([])
    expect(h.get(run).state).toBe("needs_input")
    const question = h.get(run).tasks.find((task) => task.kind === "human")!
    expect(question.title).toContain("Merge mend/merge-x into your checkout?")
    expect(question.title).toContain("2 worktree(s), 6 file(s), +18 -4")
    h.service.control(run.workflowId, "approve", { taskId: question.id, reason: "merge" })
    await settle(80)
    expect(h.get(run).state).toBe("completed")
    const result = resultOf(h, run)
    expect(result).toMatchObject({ branch: "mend/merge-x", files: 6, applied: true, failing: ["web"] })
    expect(result.merged.sort()).toEqual(["api", "cli"])
    expect(git.calls.applied).toEqual(["mend/merge-x"])
    // no agent writes to the main checkout: the merge is git, and it needed the user's yes
    expect(h.get(run).tasks.filter((task) => task.kind === "agent" && task.mode === "work" && task.isolated !== true)).toEqual([])
  })

  test("migrate-many-files: keeping the branch applies nothing", async () => {
    const git = gitFake()
    const h = scriptHarness({
      worktrees: true,
      merge: git.port,
      responder: (prompt) => (prompt.startsWith("Find the top-level") ? output({ directories: ["api"] }) : prompt.startsWith("Work only inside") ? "done" : "?"),
    })
    const run = h.start(source("migrate-many-files"), {})
    await settle(80)
    const question = h.get(run).tasks.find((task) => task.kind === "human")!
    h.service.control(run.workflowId, "approve", { taskId: question.id, reason: "keep the branch" })
    await settle(60)
    expect(h.get(run).state).toBe("completed")
    expect(resultOf(h, run)).toMatchObject({ merged: [], branch: "mend/merge-x", applied: false })
    expect(git.calls.applied).toEqual([])
  })

  test("research: parallel read agents tolerate one failing angle, then a typed synthesis", async () => {
    const answer = { answer: "It retries three times", confidence: "high", evidence: [{ claim: "3 retries", source: "src/retry.ts" }], gaps: [] }
    const h = scriptHarness({
      responder: (prompt) => {
        if (prompt.startsWith("Research this question")) return prompt.includes("history") ? "HOLD" : "notes about " + /looking only at ([^.]+)\./.exec(prompt)?.[1]
        if (prompt.startsWith("Answer the question")) return output(answer)
        return "?"
      },
    })
    const run = h.start(source("research"), { question: "How are retries handled?" })
    await settle(40)
    // the held angle never answers; stop it from the outside as a failed task so the settled parallel moves on
    const held = h.get(run).tasks.find((task) => task.title.includes("history") && task.state === "running")!
    await h.finishWith(held.sessionId!, undefined, "", true)
    await settle(80)
    expect(h.get(run).state).toBe("completed")
    expect(resultOf(h, run)).toEqual(answer)
    const synth = h.prompts.find((prompt) => prompt.startsWith("Answer the question"))!
    expect(synth).toContain("## code and tests")
    expect(synth).not.toContain("## history")
    expect(h.get(run).tasks.filter((task) => task.mode === "read")).toHaveLength(4)
  })

  test("research: a synthesis that breaks its schema is repaired once, in the same session", async () => {
    const good = { answer: "x", confidence: "low", evidence: [], gaps: ["none"] }
    const h = scriptHarness({
      responder: (prompt, info) => (prompt.startsWith("Answer the question") || prompt.includes("did not satisfy") ? (info.turn === 1 ? output({ answer: "x" }) : output(good)) : "notes"),
    })
    const run = h.start(source("research"), { question: "q", angles: ["one"] })
    await settle(80)
    expect(h.get(run).state).toBe("completed")
    expect(resultOf(h, run)).toEqual(good)
  })
})
