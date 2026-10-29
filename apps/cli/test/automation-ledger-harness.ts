import { openStore } from "@mendcode/store"
import { summarizeWorkflow, type Loop, type WorkflowRun } from "@mendcode/protocol"
import { createAutomationLedgerHost, type LedgerCommand } from "../../../packages/daemon/src/automation-ledger"
import { appHarness, ids, NOW, tempDir } from "./session-ui-harness"

export function automationLedgerHarness(width = 100, height = 30) {
  const dataDir = tempDir("mendcode-b69-")
  const store = openStore({ dir: dataDir, now: () => NOW })
  const rootSessionId = ids("session")
  const run: WorkflowRun = {
    workflowId: ids("workflow"), name: "Client migration", directory: "/work/mendcode", objective: "Migrate the typed client and verify wire compatibility",
    plan: { name: "Client migration", objective: "Migrate the typed client and verify wire compatibility", tasks: [{ kind: "agent", id: "client", title: "Typed client", prompt: "Implement the typed client", needs: [], mode: "work" }], contract: { criteria: [{ id: "wire", text: "Additive protocol remains compatible", required: true }], checks: [{ id: "wire", command: "bun test protocol.test.ts", covers: ["wire"] }], audit: "none", maxRepairs: 0, maxAudits: 1 } },
    planHash: "a".repeat(64), permission: "edits", state: "running", rootSessionId, tasks: [{ id: "client", title: "Typed client", kind: "agent", mode: "work", needs: [], state: "running", attempt: 1 }], verifications: [], repairs: 0, startedAt: NOW - 60_000, updatedAt: NOW - 60_000,
  }
  store.workflows.save(run)
  run.state = "blocked"
  run.reason = "Wire check failed; inspect the receipt before accepting"
  run.tasks[0] = { ...run.tasks[0]!, state: "done", result: "Client helpers implemented in packages/client/src/index.ts", endedAt: NOW }
  run.updatedAt = NOW
  run.verifications = [{ round: 1, at: NOW, accepted: false, gates: [{ id: "wire", status: "fail", detail: "protocol.test.ts:42: old response field missing" }], criteria: [{ id: "wire", status: "fail", by: "check" }] }]
  store.workflows.save(run)
  const loop: Loop = {
    loopId: ids("loop"), name: "Compatibility watch", directory: "/work/mendcode", objective: "Watch protocol compatibility", sessionId: ids("session"), state: "running", trigger: { kind: "manual" }, budget: { mode: "goal", maxRuns: 10 }, runs: 1,
    history: [{ run: 1, startedAt: NOW - 20_000, trigger: "manual" }], createdAt: NOW - 30_000, updatedAt: NOW - 20_000,
  }
  store.loops.save(loop)
  loop.state = "blocked"
  loop.reason = "Independent audit rejected the completion claim"
  loop.updatedAt = NOW
  loop.usage = { tokens: 12_400, costMicros: 15_300, unknownCostCalls: 1 }
  loop.history[0] = { ...loop.history[0]!, endedAt: NOW, outcome: "completed", checkpoint: { status: "complete", summary: "Client migration implemented", next: "Restore old wire response field and re-run compatibility check", evidence: ["packages/client/src/index.ts:480", "protocol.test.ts:42"] }, checkpointHash: "b".repeat(64), usage: { tokens: 12_400, costMicros: 15_300, unknownCostCalls: 1 }, gates: [{ id: "wire", status: "fail", detail: "old response field missing", failureClass: "quality" }], audit: { verdict: "fail", findings: "protocol.test.ts:42 does not preserve the old response field" } }
  store.loops.save(loop)
  const host = createAutomationLedgerHost(store)
  const h = appHarness({ width, height, dataDir, directory: "/work/mendcode", reply: (command) => {
    if (/^(workflow|loop)\.(events|artifacts|receipt|export)$/.test(command.type)) {
      const reply = host.handle(command as LedgerCommand)
      return reply.ok ? reply : { ok: false, error: { code: reply.code, message: reply.message } }
    }
    if (command.type === "workflow.list") return { ok: true, result: { workflows: [summarizeWorkflow(run)] } }
    if (command.type === "loop.list") return { ok: true, result: { loops: [loop] } }
    return undefined
  } })
  h.app.applySettings({ onboarded: true })
  return { ...h, store, run, loop, close: async () => { await h.app.onKey("\x03"); store.close() } }
}
