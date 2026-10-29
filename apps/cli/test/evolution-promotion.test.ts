import { afterEach, describe, expect, test } from "bun:test"
import { evolutionHarness, WORKFLOW_CANDIDATE } from "./evolution-promotion-harness"
import { cleanTemps } from "./session-ui-harness"
import { evolutionKey, renderEvolutionTab } from "../src/view/memory-evolution"
import { textWidth } from "../src/view/wrap"

afterEach(cleanTemps)
const open = async (h: ReturnType<typeof evolutionHarness>) => { await h.type("/memory\r"); await h.type("7") }
const key = async (h: ReturnType<typeof evolutionHarness>, value: string) => { await h.app.onKey(value); await h.type("") }

describe("Evolution promotion UI", () => {
  test("review → promote → reopen → off → rollback → reject; uses reviewed hashes and revision", async () => {
    const h = evolutionHarness(100, 30)
    await open(h)
    expect(h.text().join("\n")).toContain("survey-checks")
    expect(h.text()[0]).toContain("a promote")
    await key(h, "a")
    expect(h.sentOf("evolution.promote")).toEqual([{ type: "evolution.promote", suggestionId: 46, expectedHash: "a".repeat(64), policyRevision: "review-1" }])
    expect(h.text().join("\n")).toContain("Receipt · revision 1")
    await key(h, "\x1b")
    await open(h)
    expect(h.text().join("\n")).toContain("Receipt · revision 1")
    await key(h, "\x1b[D")
    await key(h, "\x1b[D")
    expect(h.text().join("\n")).toContain("‹ off ›")
    await key(h, "r")
    expect(h.sentOf("evolution.rollback")).toEqual([{ type: "evolution.rollback", suggestionId: 46, expectedHash: "a".repeat(64), expectedRevision: 1 }])
    expect(h.text().join("\n")).toContain("revision 2")
    await key(h, "\x1b[B")
    await key(h, "x")
    expect(h.sentOf("evolution.resolve")).toEqual([{ type: "evolution.resolve", suggestionId: 45, decision: "reject", expectedHash: "b".repeat(64) }])
    await key(h, "\x1b")
  })

  test("opt-in settings, complete review scrolling and a refused rollback keep the receipt", async () => {
    const h = evolutionHarness(100, 30)
    await open(h)
    await key(h, "o")
    expect(h.sentOf("settings.set").at(-1)).toMatchObject({ patch: { evolutionWorkflows: false } })
    await key(h, "a")
    expect(h.sentOf("evolution.promote")).toHaveLength(0)
    await key(h, "o")
    for (let i = 0; i < 12; i++) await key(h, "\x1b[6~")
    expect(h.text().join("\n")).toContain("independent")
    await key(h, "a")
    h.failNext()
    await key(h, "r")
    expect(h.text().join("\n")).toContain("manual review")
    for (let i = 0; i < 12; i++) await key(h, "\x1b[5~")
    expect(h.text().join("\n")).toContain("revision 1")
    await key(h, "\x1b")
  })

  test("pending and receipt screens fit every supported cell grid", async () => {
    for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) {
      const h = evolutionHarness(width!, height!)
      await open(h)
      for (const value of ["", "a", "r"]) {
        if (value) await key(h, value)
        const rows = h.text()
        expect(rows).toHaveLength(height!)
        expect(rows.every((row) => textWidth(row) <= width! && !row.includes("\x1b"))).toBe(true)
        expect(rows.join("\n")).toContain("Review / receipt")
        if (width! >= 70) expect(rows.join("\n")).toContain("┌")
      }
      await key(h, "\x1b")
    }
  })

  test("rollback works while off; selection is bounded and scroll resets on the next candidate", () => {
    const accepted = { ...WORKFLOW_CANDIDATE, status: "accepted" as const, receipt: { kind: "workflow" as const, target: "/project/workflow.json", hash: "c".repeat(64), revision: 1, promotedAt: 0 } }
    expect(evolutionKey({ selected: 0 }, "r", { mode: "off", suggestions: [accepted] }).action.type).toBe("evolutionRollback")
    expect(evolutionKey({ selected: 0 }, "a", { mode: "off", workflows: true, policyRevision: "r", suggestions: [WORKFLOW_CANDIDATE] }).action.type).toBe("none")
    expect(evolutionKey({ selected: 0, scroll: 20 }, "\x1b[B", { mode: "suggest", suggestions: [WORKFLOW_CANDIDATE, accepted] }).state).toEqual({ selected: 1 })
    const rows = renderEvolutionTab({ mode: "off", data: { mode: "off", suggestions: [], observed: { corrections: 0, preferences: 0, recurring: 0 } }, state: { selected: 100 }, width: 60, height: 16, now: 0 })
    expect(rows.map((line) => line.map((span) => span.text).join("")).join("\n")).toContain("No candidates")
  })

  test("compact selection stays visible and long multiline content can be reviewed to the end", async () => {
    const h = evolutionHarness(60, 20)
    await open(h)
    await key(h, "\x1b[B")
    await key(h, "x")
    expect(h.text().join("\n")).toContain("read-checks · rejected")
    const active = { ...WORKFLOW_CANDIDATE, content: Array.from({ length: 500 }, (_, i) => "row " + i).join("\n") }
    let state = { selected: 0, scroll: 0 }
    const data = { mode: "suggest" as const, suggestions: [active], observed: { corrections: 1, preferences: 0, recurring: 1 }, workflows: true }
    for (let i = 0; i < 200; i++) state = evolutionKey(state, "\x1b[6~", { mode: "suggest", suggestions: [active], size: { width: 60, height: 16 } }).state as typeof state
    const last = state.scroll
    expect(last).toBeGreaterThan(200)
    expect(evolutionKey(state, "\x1b[6~", { mode: "suggest", suggestions: [active], size: { width: 60, height: 16 } }).state.scroll).toBe(last)
    const text = renderEvolutionTab({ mode: "suggest", data, state, width: 60, height: 16, now: 0 }).map((line) => line.map((span) => span.text).join("")).join("\n")
    expect(text).toContain("row 499")
    await key(h, "\x1b")
  })

  test("Dream safety report accounts for workflow candidates", async () => {
    for (const [width, height] of [[60, 20], [180, 50]]) {
      const h = evolutionHarness(width!, height!)
      await h.type("/memory\r")
      await key(h, "4")
      await key(h, "v")
      await key(h, "\x1b[6~")
      expect(h.text().join("\n")).toContain("suggested 1 workflow")
      await key(h, "\x1b")
    }
  })

  test("production startup and lazy Memory graph stay free of zod", () => {
    const probe = Bun.spawnSync(["bun", "-e", 'await import("./apps/cli/src/ui/app"); await import("@mendcode/client"); const pages = await import("./apps/cli/src/ui/lazy-pages"); await pages.preload("memory"); console.log(Object.keys(require.cache).filter((key) => key.includes("/zod/") || /protocol\\/src\\/(dream|workflows|commands|queries)\\.ts$/.test(key)).length)'], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" })
    expect(probe.exitCode).toBe(0)
    expect(probe.stdout.toString().trim()).toBe("0")
    expect(probe.stderr.toString()).toBe("")
  })
})
