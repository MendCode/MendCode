import { writeFileSync } from "node:fs"
import path from "node:path"
import { b25Harness, B25_POLICY } from "../apps/cli/test/b25-reasoning-harness"
import { textWidth } from "../apps/cli/src/view/wrap"
import { fit } from "../apps/cli/src/view/deck"
import type { ReasoningReport } from "@mendcode/protocol"

export async function renderB25Frames(directory: string, sizes: string[]) {
  for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
    const match = /^(\d+)x(\d+)$/.exec(size)
    if (!match) throw new Error(`invalid size: ${size}`)
    const width = Number(match[1]), height = Number(match[2])
    const save = (name: string, rows: string[]) => {
      if (rows.length !== height || rows.some((row) => textWidth(row) > width || row.includes("\x1b"))) throw new Error(`invalid B25 frame ${name} ${size}`)
      writeFileSync(path.join(directory, `${name}-${size}.txt`), rows.map((text) => fit([{ text }], width).map((span) => span.text).join("")).join("\n") + "\n")
    }
    const model = b25Harness({ width, height })
    await model.type("/model\r")
    save("model", model.text())
    for (const [name, changes] of [
      ["off", {}],
      ["shadow", { config: { ...B25_POLICY, mode: "shadow", remoteProcessing: true }, evaluatorReady: true, receipt: { status: "proposed", effort: "low", suggestedEffort: "high", leaseRemaining: 1, decisions: 1 } }],
      ["adaptive", { config: { ...B25_POLICY, mode: "adaptive", remoteProcessing: true }, evaluatorReady: true, receipt: { status: "reused", effort: "high", suggestedEffort: "high", leaseRemaining: 1, decisions: 2 } }],
      ["manual", { reasoningAuto: true, receipt: { status: "manual", effort: "low", leaseRemaining: 0, decisions: 0, reason: "Manual effort wins for this turn" } }],
      ["paused", { config: { ...B25_POLICY, mode: "adaptive", remoteProcessing: true }, evaluatorReady: true, receipt: { status: "paused", effort: "medium", leaseRemaining: 0, decisions: 8, reason: "Evaluator failed or decision limit reached" } }],
      ["fallback", { config: { ...B25_POLICY, mode: "adaptive", remoteProcessing: true, failureMode: "baseline" }, evaluatorReady: true, receipt: { status: "fallback", effort: "low", leaseRemaining: 0, decisions: 1, reason: "Baseline until the next turn" } }],
      ["invalid", { valid: false, revision: "invalid" }],
    ] as Array<[string, Partial<ReasoningReport>]>) {
      const harness = b25Harness({ width, height, reasoning: { ...changes, ...(changes.config ? { consent: changes.config } : {}) } })
      await harness.type("/model reasoning\r")
      if (width < 70) await harness.app.onKey("2")
      harness.app.render()
      save(`reasoning-${name}`, harness.text())
    }
    for (const error of ["none", "policy", "settings"] as const) {
      const rejectSave = error !== "none"
      const name = error === "settings" ? "reasoning-settings-error" : rejectSave ? "reasoning-save-error" : "reasoning-confirm"
      const harness = b25Harness({ width, height, rejectSave: error === "policy", rejectAuto: error === "settings" })
      await harness.type("/model reasoning\r")
      for (const key of ["a", "c", "t"]) await harness.app.onKey(key)
      harness.app.render()
      if (!rejectSave) save(name, harness.text())
      else {
        await harness.app.onKey("\r")
        harness.app.render()
        save(name, harness.text())
      }
      if (width < 70) {
        await harness.app.onKey("2")
        harness.app.render()
        save(`${name}-runtime`, harness.text())
      }
    }
  }
}
