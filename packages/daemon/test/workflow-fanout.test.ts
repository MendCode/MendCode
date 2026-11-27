import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ExtensionLayer } from "@mendcode/packages"
import { estimateLine, estimateRun, largeRunNotice, scriptShape } from "../src/workflow-estimate"
import { workflowCommandEntries } from "../src/workflow-files"
import { fanoutNote, fanoutTrigger } from "../src/workflow-trigger"
import { fanoutAsked, noteFanout } from "../src/workflow-tools"

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

describe("the fanout keyword", () => {
  test("the word and its alias trigger, in any case", () => {
    expect(fanoutTrigger("fanout: review every package", undefined)).toBe("keyword")
    expect(fanoutTrigger("please ULTRACODE this migration", undefined)).toBe("keyword")
  })

  test("a mention in code, after a backslash, inside a longer word or in a machine notice does not", () => {
    expect(fanoutTrigger("what does `fanout` do?", undefined)).toBeUndefined()
    expect(fanoutTrigger("```\nfanout()\n```", undefined)).toBeUndefined()
    expect(fanoutTrigger("use \\fanout literally", undefined)).toBeUndefined()
    expect(fanoutTrigger("a fanouts and fan-out", undefined)).toBeUndefined()
    expect(fanoutTrigger("", { auto: true })).toBeUndefined()
  })

  test("--no-fanout skips one prompt, even with auto on", () => {
    expect(fanoutTrigger("fanout this --no-fanout", { auto: true })).toBeUndefined()
    expect(fanoutTrigger("just do it --no-fanout", { auto: true })).toBeUndefined()
  })

  test("auto mode triggers every prompt, and says so in the note with the size guideline", () => {
    expect(fanoutTrigger("rename the helper", { auto: true })).toBe("auto")
    expect(fanoutTrigger("rename the helper", { auto: false })).toBeUndefined()
    expect(fanoutNote({ trigger: "auto", size: "small" })).toContain("automatic workflows")
    expect(fanoutNote({ trigger: "keyword", size: undefined })).toContain("fanout")
  })

  test("a session that asked for orchestration skips the approval prompt, and the next plain prompt takes it back", () => {
    noteFanout("ses_a", true)
    expect(fanoutAsked("ses_a")).toBe(true)
    expect(fanoutAsked("ses_b")).toBe(false)
    noteFanout("ses_a", false)
    expect(fanoutAsked("ses_a")).toBe(false)
  })
})

describe("the size estimate", () => {
  const script = (body: string, agents?: number) => ({ source: `export const meta = { name: "x" }\n${body}`, ...(agents ? { budget: { agents } } : {}) })

  test("a script's calls are counted, and a loop plans to its declared cap", () => {
    expect(scriptShape("await agent('a'); await agent('b')")).toEqual({ sites: 2, dynamic: false })
    expect(scriptShape("for (const x of xs) await agent(x) // agent(")).toMatchObject({ dynamic: true })
    const fixed = estimateRun({ script: script("await agent('a'); await agent('b')"), history: [] })
    expect(fixed).toMatchObject({ agents: 2, atMost: false, basis: "default", large: false })
    const loop = estimateRun({ script: script("await parallel(xs.map((x) => () => agent(x)))", 30), history: [] })
    expect(loop).toMatchObject({ agents: 30, atMost: true, large: true })
  })

  test("history sets the tokens, cost and time per agent", () => {
    const done = { kind: "agent", state: "done", usage: { input: 8_000, output: 2_000, costMicros: 100_000 }, startedAt: 0, endedAt: 120_000 }
    const estimate = estimateRun({ script: script("await agent('a')", 10), history: [done, done, done], maxConcurrent: 5 })
    expect(estimate).toMatchObject({ agents: 10, tokens: 100_000, usd: 1, minutes: 4, basis: "history" })
    expect(estimateLine(estimate)).toBe("up to 10 agents · ~100k tokens · ~$1.00 · ~4 min")
  })

  test("a large run gets an informative notice that says it starts now; a small one gets none", () => {
    const large = estimateRun({ script: script("await agent('a')", 40), history: [], size: "medium" })
    const notice = largeRunNotice(large)
    expect(notice).toContain("Large run")
    expect(notice).toContain("above the medium guideline (20 agents)")
    expect(notice).toContain("starts now")
    expect(largeRunNotice(estimateRun({ script: script("await agent('a')"), history: [] }))).toBe("")
    expect(largeRunNotice(estimateRun({ script: script("await agent('a')", 40), history: [], size: "unrestricted" }))).toContain("Large run")
  })
})

describe("saved workflows become commands", () => {
  function temp(prefix: string) {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    return dir
  }

  test("user, package and project files are listed with their description, a later layer replacing a name", () => {
    const pkg = temp("wf-pkg-"), user = temp("wf-user-"), project = temp("wf-proj-")
    const put = (dir: string, file: string, text: string) => {
      mkdirSync(path.join(dir, "workflows"), { recursive: true })
      writeFileSync(path.join(dir, "workflows", file), text)
    }
    put(pkg, "audit.js", `export const meta = { name: "audit", description: "Audit every package" }\nawait agent("x")`)
    put(user, "audit.js", `export const meta = { name: "audit", description: "My audit" }\nawait agent("x")`)
    put(project, "ship.json", JSON.stringify({ name: "ship", objective: "Ship it.", tasks: [{ kind: "agent", id: "a", title: "A", prompt: "go" }] }))
    const layers: ExtensionLayer[] = [{ dir: pkg, source: "user", pkg: "shipped" }, { dir: user, source: "user" }, { dir: project, source: "project" }]
    const entries = workflowCommandEntries(layers)
    expect(entries.map((entry) => [entry.name, entry.kind, entry.description]).sort()).toEqual([["audit", "script", "My audit"], ["ship", "plan", "Ship it."]])
    expect(workflowCommandEntries([{ dir: pkg, source: "user", pkg: "shipped", foreign: { kinds: ["agents"], origin: "claude" } }])).toEqual([])
  })
})
