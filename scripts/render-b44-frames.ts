import { writeFileSync } from "node:fs"
import path from "node:path"
import { loopBudgetExample, loopBudgetHarness } from "../apps/cli/test/loop-budget-harness"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth } from "../apps/cli/src/view/wrap"

export async function renderB44Frames(directory: string, sizes: string[]) {
  for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
    const match = /^(\d+)x(\d+)$/.exec(size)
    if (!match) throw new Error(`invalid size: ${size}`)
    const width = Number(match[1]), height = Number(match[2])
    const h = loopBudgetHarness(width, height)
    const save = (name: string) => {
      h.app.render()
      const frame = h.frames.at(-1)!
      if (frame.length !== height || frame.some((row) => textWidth(row.map((span) => span.text).join("")) > width)) throw new Error(`overflow ${name} ${size}`)
      const text = frame.map((row) => fit(row, width).map((span) => span.text).join("")).join("\n")
      if (text.includes("\x1b")) throw new Error(`ANSI ${name} ${size}`)
      writeFileSync(path.join(directory, `${name}-${size}.txt`), `${text}\n`)
    }
    await h.type("/loops\r"); save("loops-rubric-failed")
    await h.type("\x1b[6~"); save("loops-evidence-scrolled")
    await h.type("e"); save("loops-edit-caps")
    for (let i = 0; i < 30; i++) await h.app.onKey("\x1b[B")
    save("loops-edit-rubric-policy")
    await h.type("\x1b"); await h.type("c"); save("loops-new")
    await h.type("\x1b")
    const base = loopBudgetExample({ loopId: h.loop.loopId })
    const emit = (over: Partial<typeof base>) => h.app.onGlobal({ type: "loop.changed", gseq: 0, at: base.updatedAt, loop: { ...base, ...over } })
    await h.type("\x1b[5~")
    emit({ reviewInvalidatedAt: base.updatedAt }); save("loops-review-invalidated")
    emit({ usage: { tokens: 12_345, costMicros: 0, unknownCostCalls: 1 }, reason: "USD cost unknown; budget cannot be verified", history: [{ ...base.history[0]!, gates: [{ id: "cost-budget", status: "fail", failureClass: "budget", detail: "USD cost unknown for 1 call; budget cannot be verified." }], rubricResult: undefined }] })
    save("loops-budget-blocked")
    emit({ reason: "Approval required: deploy", history: [{ ...base.history[0]!, gates: [{ id: "approval-policy", status: "fail", failureClass: "policy", detail: "Approval required: deploy." }], rubricResult: undefined }] })
    save("loops-approval-required")
    const waiver = { action: "waive" as const, actor: "user", reason: "README.md:14 verified manually", at: base.updatedAt, checkpointHash: base.history[0]!.checkpointHash! }
    emit({ reason: "Gate rubric waived by user", history: [{ ...base.history[0]!, gates: [{ id: "rubric", status: "pass", waiver, detail: "75% / 85%" }] }] })
    save("loops-gate-waived")
    await h.type("a"); save("loops-review-reason")
    await h.app.onKey("\x03")
  }
}
