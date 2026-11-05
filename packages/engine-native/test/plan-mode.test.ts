import { describe, expect, test } from "bun:test"
import type { PermissionMode, Settings } from "@mendcode/protocol"
import { createNativeEngine, memoryHistory } from "../src"
import { PLAN_MODE_NOTE, looksLikePlan } from "../src/plan-tools"
import { callTool, echoTool, scriptedProvider, stop, turn } from "./harness"

const PLAN = "# Plan\n\n1. Read the entry point and the modules it imports\n2. Add the new module next to the existing ones, with its types\n3. Run the focused tests and then the whole suite\n\nRisk: none that needs a decision."

function run(steps: Parameters<typeof scriptedProvider>[0], options: { mode: PermissionMode; settings?: Settings; answers?: Parameters<typeof turn>[0]["answers"] }) {
  const { provider, requests } = scriptedProvider(steps)
  let mode = options.mode
  const t = turn({ text: "make a plan", mode: () => mode, onModeChange: (next) => (mode = next), ...(options.answers ? { answers: options.answers } : {}) })
  const engine = createNativeEngine({ provider, tools: [echoTool], history: memoryHistory(), cwdFor: () => "/repo", system: () => "sys", compactionPrompt: "s", modelFor: (_: unknown, role: string) => ({ model: role === "plan" ? "gpt-6-astra" : "gpt-6-luna" }), ...(options.settings ? { permissionPolicy: () => options.settings! } : {}) })
  return { engine, requests, ...t, mode: () => mode }
}
const names = (request: { tools: ReadonlyArray<{ name: string }> }) => request.tools.map((tool) => tool.name)

describe("plan mode reaches the model and ends in the review", () => {
  for (const tier of ["minimalist", "balanced", "full"] as const) {
    test(`${tier}: plan_review and plan_exit are in the request while in plan mode, and only then`, async () => {
      const inPlan = run([stop("ok")], { mode: "plan", settings: { tier } })
      await inPlan.engine.runTurn(inPlan.input)
      expect(names(inPlan.requests[0]!)).toEqual(expect.arrayContaining(["plan_review", "plan_exit"]))
      const outside = run([stop("ok")], { mode: "ask", settings: { tier } })
      await outside.engine.runTurn(outside.input)
      if (tier !== "full") expect(names(outside.requests[0]!)).not.toContain("plan_review")
    })
  }

  test("the system prompt says it is plan mode, read-only, and to finish with plan_review; outside plan mode it carries nothing of it", async () => {
    const inPlan = run([stop("ok")], { mode: "plan", settings: { tier: "minimalist" } })
    await inPlan.engine.runTurn(inPlan.input)
    expect(inPlan.requests[0]!.system).toContain(PLAN_MODE_NOTE)
    expect(PLAN_MODE_NOTE).toMatch(/plan mode/i)
    expect(PLAN_MODE_NOTE).toMatch(/read-only/i)
    expect(PLAN_MODE_NOTE).toContain("plan_review")
    const outside = run([stop("ok")], { mode: "ask", settings: { tier: "minimalist" } })
    await outside.engine.runTurn(outside.input)
    expect(outside.requests[0]!.system).not.toContain("plan_review")
    expect(outside.requests[0]!.system).not.toContain("Plan mode")
  })

  test("a plan written as plain text at the end of a plan-mode turn is offered for review, and applying it leaves plan mode and continues", async () => {
    const t = run([stop(PLAN), stop("implemented")], { mode: "plan", settings: { tier: "balanced" }, answers: [{ kind: "plan_review", action: "apply" }] })
    expect(await t.engine.runTurn(t.input)).toEqual({ status: "ok" })
    expect(t.asked).toHaveLength(1)
    expect(t.asked[0]).toMatchObject({ kind: "approval", tool: "plan_review", planReview: { markdown: PLAN.trim(), destination: "build" } })
    expect(t.mode()).toBe("full")
    expect(t.requests.map((request) => request.model)).toEqual(["gpt-6-astra", "gpt-6-luna"])
    expect((t.requests[1]!.messages.at(-1) as { output: string }).output).toContain("Plan approved")
    expect((t.requests[1]!.messages.at(-1) as { output: string }).output).toContain("full access")
  })

  test("applying with another access keeps it: auto edits and ask before edits stay choices", async () => {
    for (const [permission, label] of [["edits", "auto edits"], ["ask", "ask before edits"]] as const) {
      const t = run([stop(PLAN), stop("implemented")], { mode: "plan", settings: { tier: "balanced" }, answers: [{ kind: "plan_review", action: "apply", permission }] })
      await t.engine.runTurn(t.input)
      expect(t.mode()).toBe(permission)
      expect((t.requests[1]!.messages.at(-1) as { output: string }).output).toContain(label)
    }
  })

  test("accepting without implementation and the other answers do not change the access", async () => {
    for (const action of ["accept", "edit", "close"] as const) {
      const t = run([stop(PLAN), stop(PLAN)], { mode: "plan", answers: [{ kind: "plan_review", action, ...(action === "edit" ? { markdown: PLAN } : {}) }] })
      await t.engine.runTurn(t.input)
      expect([action, t.mode()]).toEqual([action, "plan"])
    }
  })

  test("a rejected plain-text plan comes back as feedback; an accepted one is not reviewed again", async () => {
    const rejected = run([stop(PLAN), stop("revised")], { mode: "plan", answers: [{ kind: "plan_review", action: "reject", reason: "add tests" }] })
    await rejected.engine.runTurn(rejected.input)
    expect((rejected.requests[1]!.messages.at(-1) as { output: string }).output).toContain("add tests")
    const accepted = run([stop(PLAN), stop(PLAN)], { mode: "plan", answers: [{ kind: "plan_review", action: "accept" }] })
    await accepted.engine.runTurn(accepted.input)
    expect(accepted.asked).toHaveLength(1)
    expect(accepted.mode()).toBe("plan")
  })

  test("a short answer, a question and a plan already sent through plan_review are never reviewed a second time", async () => {
    const short = run([stop("Yes, it does.")], { mode: "plan" })
    await short.engine.runTurn(short.input)
    expect(short.asked).toHaveLength(0)
    const explicit = run([callTool("plan_review", { markdown: PLAN }), stop(PLAN)], { mode: "plan", answers: [{ kind: "plan_review", action: "close" }] })
    await explicit.engine.runTurn(explicit.input)
    expect(explicit.asked).toHaveLength(1)
    const build = run([stop(PLAN)], { mode: "ask" })
    await build.engine.runTurn(build.input)
    expect(build.asked).toHaveLength(0)
  })

  test("looksLikePlan wants a structured text, not a sentence", () => {
    expect(looksLikePlan(PLAN)).toBe(true)
    expect(looksLikePlan("- first step of the work, in a few words\n- second step of the work, in a few words\n- third step of the work, in a few words")).toBe(true)
    expect(looksLikePlan("Yes, it does.")).toBe(false)
    expect(looksLikePlan("A long paragraph without any structure. ".repeat(20))).toBe(false)
  })
})
