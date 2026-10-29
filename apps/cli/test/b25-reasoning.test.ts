import { afterEach, describe, expect, test } from "bun:test"
import { modelPageKey } from "../src/view/model-page"
import { renderReasoningPage } from "../src/view/reasoning-page"
import { textWidth } from "../src/view/wrap"
import { b25Harness, B25_POLICY } from "./b25-reasoning-harness"
import { cleanTemps } from "./session-ui-harness"

afterEach(cleanTemps)
describe("B25 reasoning controls", () => {
  test("reasoning loads on use without zod or protocol schemas in the client graph", () => {
    const probe = Bun.spawnSync(["bun", "-e", `await import("./src/ui/app"); await import("@mendcode/client"); await import("./src/ui/screen");
const has = () => Object.keys(require.cache).some((key) => key.endsWith("/view/reasoning-page.ts"));
const before = has();
await (await import("./src/ui/lazy-pages")).preload("reasoning");
const keys = Object.keys(require.cache);
console.log(JSON.stringify({ before, after: has(), zod: keys.filter((key) => key.includes("/zod/")).length, schemas: keys.filter((key) => /protocol\\/src\\/(commands|events|queries|frames|reasoning)\\.ts$/.test(key)).length }))`], { cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe" })
    expect(probe.exitCode).toBe(0)
    expect(probe.stderr.toString()).toBe("")
    expect(JSON.parse(probe.stdout.toString())).toEqual({ before: false, after: true, zod: 0, schemas: 0 })
  })

  test("model opens reasoning; keys stage choices and only Enter confirms", async () => {
    const harness = b25Harness()
    await harness.type("/model roles\r")
    await harness.app.onKey("a")
    for (const key of ["s", "c", "p", "f", "l", "+", "t"]) await harness.app.onKey(key)
    harness.app.render()
    expect(harness.sentOf("reasoning.configure")).toHaveLength(0)
    expect(harness.text().join("\n")).toContain("Unsaved")
    expect(harness.text().join("\n")).toContain("evaluator cost")
    await harness.app.onKey("\r")
    expect(harness.sentOf("reasoning.configure")).toHaveLength(1)
    expect(harness.sentOf("reasoning.configure")[0]).toMatchObject({ confirm: true, expectedRevision: "policy-1", config: { mode: "shadow", remoteProcessing: true, provider: "vercel-ai-gateway", maxLeaseSteps: 5, maxDecisionsPerTurn: 9, failureMode: "baseline" } })
    expect(harness.settings().experimental).toEqual({ continue_loop_on_deny: true, reasoning_auto: true })
    expect(harness.sentOf("session.model.set")).toHaveLength(0)
  })

  test("direct command, cancel and failed confirmation never silently save", async () => {
    const harness = b25Harness({ rejectSave: true })
    await harness.type("/model reasoning\r")
    expect(harness.text().join("\n")).toContain("Reasoning")
    await harness.app.onKey("a")
    await harness.app.onKey("\x1b")
    expect(harness.sentOf("reasoning.configure")).toHaveLength(0)
    await harness.app.onKey("a")
    await harness.app.onKey("s")
    await harness.app.onKey("\r")
    harness.app.render()
    expect(harness.text().join("\n")).toContain("Policy changed")
    expect(harness.text().join("\n")).toContain("Unsaved")
    expect(harness.sentOf("settings.set")).toHaveLength(0)
  })

  test("a settings failure retains its error and draft after consent is saved", async () => {
    const harness = b25Harness({ rejectAuto: true })
    await harness.type("/model reasoning\r")
    await harness.app.onKey("s")
    await harness.app.onKey("t")
    await harness.app.onKey("\r")
    harness.app.render()
    expect(harness.reasoning().config.mode).toBe("shadow")
    expect(harness.settings().experimental?.reasoning_auto).toBe(false)
    expect(harness.text().join("\n")).toContain("Settings update rejected")
    expect(harness.text().join("\n")).toContain("Unsaved")
  })

  test("all fields fit in shared panels; compact runtime is a single scrollable column", async () => {
    for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) {
      const harness = b25Harness({ width, height, reasoning: { evaluatorReady: true, receipt: { status: "paused", effort: "medium", leaseRemaining: 0, decisions: 8, reason: "Evaluator failed or decision limit reached" } } })
      await harness.type("/model reasoning\r")
      await harness.app.onKey("a")
      await harness.app.onKey("c")
      if (width! < 70) await harness.app.onKey("2")
      harness.app.render()
      const rows = harness.text()
      expect(rows).toHaveLength(height!)
      expect(rows.every((row) => textWidth(row) <= width! && !row.includes("\x1b"))).toBe(true)
      expect(rows[0]).toContain("esc back")
      expect(rows.join("\n")).toContain("Manual effort")
      expect(rows.join("\n")).toContain("paused")
      expect(rows.join("\n")).toContain("┌")
      if (width! < 70) {
        expect(rows.join("\n")).not.toContain("Proposed policy")
        await harness.app.onKey("\x1b[B")
        await harness.app.onKey("\x1b[B")
        harness.app.render()
        expect(harness.text().join("\n")).toContain("charge for evaluation")
      }
    }
  })

  test("invalid policies cannot be edited and counts stay bounded", () => {
    const report = { engine: "native", selectable: true, models: [], defaults: { model: "local:main" }, roles: {}, reasoning: { config: B25_POLICY, consent: B25_POLICY, revision: "invalid", valid: false, evaluatorReady: false, reasoningAuto: false } }
    expect(modelPageKey({ row: 0, reasoning: true }, "a", report).action).toEqual({ type: "none" })
    report.reasoning.valid = true
    let state = { row: 0, reasoning: true, pendingReasoning: { ...B25_POLICY, maxDecisionsPerTurn: 20 } }
    expect(modelPageKey(state, "+", report).state.pendingReasoning?.maxDecisionsPerTurn).toBe(20)
    state.pendingReasoning.maxDecisionsPerTurn = 1
    expect(modelPageKey(state, "-", report).state.pendingReasoning?.maxDecisionsPerTurn).toBe(1)
    expect(renderReasoningPage({ state, report, width: 60, height: 20 })).toHaveLength(20)
  })
})
