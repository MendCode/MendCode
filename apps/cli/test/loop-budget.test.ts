import { afterEach, expect, test } from "bun:test"
import { buildLoopFields, editLoopForm, newLoopForm } from "../src/view/loop-form"
import { parseLoopCommand } from "../src/view/loop-command"
import { loopsPageKey, createLoopsPageState } from "../src/view/loops-page"
import { loopBudgetExample, loopBudgetHarness } from "./loop-budget-harness"
import { cleanTemps } from "./session-ui-harness"

afterEach(cleanTemps)

test("B44 slash caps are opt-in, validated and sent through the app factory", async () => {
  expect(parseLoopCommand("now --max-tokens 10 --max-cost 0.1 --require-approval push,deploy fix CI")).toMatchObject({ ok: true, spec: { costBudget: { maxTokens: 10, maxCost: 0.1 }, approvalPolicy: { requireApprovalFor: ["push", "deploy"] } } })
  for (const flags of ["--max-tokens -1", "--max-tokens 1.5", "--max-cost Infinity", "--unknown-cost guess", "--require-approval everything"]) expect(parseLoopCommand(`now ${flags} fix CI`).ok).toBe(false)
  const h = loopBudgetHarness()
  await h.type("/loop now --goal --max-tokens 1000 --max-cost 1 --unknown-cost allow fix CI\r")
  expect(h.sentOf("loop.create")[0]).toMatchObject({ costBudget: { maxTokens: 1000, maxCost: 1, unknownCost: "allow" } })
})

test("B44 form retains and clears caps, rubric and approval policy without losing existing fields", () => {
  expect(buildLoopFields({ ...newLoopForm(), objective: "watch CI" })).toMatchObject({ ok: true, fields: { budget: { mode: "monitor" } } })
  const blank = buildLoopFields({ ...newLoopForm(), objective: "watch CI" })
  expect(blank.ok && blank.fields.costBudget).toBeUndefined()
  const form = editLoopForm(loopBudgetExample())
  expect(buildLoopFields(form)).toMatchObject({ ok: true, fields: { costBudget: { maxTokens: 50_000, maxCost: 2, unknownCost: "block" }, rubric: { name: "Release evidence" }, approvalPolicy: { requireApprovalFor: ["push", "deploy"] } } })
  expect(buildLoopFields({ ...form, maxTokens: "", maxCost: "", rubric: "", approvalActions: "" })).toMatchObject({ ok: true, fields: { costBudget: {}, rubric: { criteria: [] }, approvalPolicy: { requireApprovalFor: [] } } })
  expect(buildLoopFields({ ...form, rubric: "not JSON" })).toMatchObject({ ok: false })
})

test("B44 page scrolls evidence and only offers the failed quality gate for waiver", () => {
  const loop = loopBudgetExample()
  expect(loopsPageKey(createLoopsPageState(), "w", [loop]).action).toEqual({ type: "review", action: "waive", loopId: loop.loopId, target: "rubric" })
  expect(loopsPageKey(createLoopsPageState(), "\x1b[6~", [loop]).state.scroll).toBe(5)
  expect(loopsPageKey({ ...createLoopsPageState(), scroll: 20 }, "j", [loop, { ...loop, loopId: "another" as typeof loop.loopId }]).state).toMatchObject({ selected: 1, scroll: 0 })
  const protectedLoop = { ...loop, history: [{ ...loop.history[0]!, gates: [{ id: "cost-budget", status: "fail" as const, failureClass: "budget" as const }] }] }
  expect(loopsPageKey(createLoopsPageState(), "w", [protectedLoop]).action).toEqual({ type: "none" })
  const policyLoop = { ...loop, history: [{ ...loop.history[0]!, gates: [{ id: "approval-policy", status: "fail" as const, failureClass: "policy" as const, detail: "Approval required: deploy." }] }] }
  expect(loopsPageKey(createLoopsPageState(), "o", [policyLoop]).action).toEqual({ type: "review", action: "approve", loopId: loop.loopId, target: "deploy" })
  for (const key of ["w", "o", "a"]) expect(loopsPageKey(createLoopsPageState(), key, [{ ...policyLoop, reviewInvalidatedAt: loop.updatedAt }]).action).toEqual({ type: "none" })
})

test("B44 waiver, approval and accept send the selected run/hash and a reason, never a provider call", async () => {
  for (const action of ["waive", "accept", "approve"] as const) {
    const h = loopBudgetHarness()
    await h.type("/loops\r")
    await h.type("\x1b")
    const target = action === "waive" ? '"bun test" ' : action === "approve" ? '"deploy" ' : ""
    await h.type(`/loop ${action} ${h.loop.loopId} ${target}verified manually\r`)
    expect(h.sentOf("loop.review")[0]).toMatchObject({ action, loopId: h.loop.loopId, run: 1, checkpointHash: "a".repeat(64), reviewer: "user", reason: "verified manually", ...(action === "waive" ? { gateId: "bun test" } : action === "approve" ? { approvalAction: "deploy" } : {}) })
    expect(h.sentOf("user.submit")).toHaveLength(0)
  }
}, 15_000)
