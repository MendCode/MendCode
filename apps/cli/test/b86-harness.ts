import { mkdirSync, realpathSync } from "node:fs"
import path from "node:path"
import { HttpServerConfig, PROTOCOL_VERSION, createIdFactory, type Frame, type WorkflowRun, type WorkflowSummary } from "@mendcode/protocol"
import { openStore } from "@mendcode/store"
import { createHttpAdapter } from "../../../packages/daemon/src/http"
import { createWorkflowsHost, type WorkflowCommand } from "../../../packages/daemon/src/workflows"
import { createAutomationLedgerHost, type LedgerCommand } from "../../../packages/daemon/src/automation-ledger"
import { remoteTokens } from "../../../packages/daemon/src/remote"
import { appHarness, NOW, tempDir } from "./session-ui-harness"

export const b86Plan = () => ({
  formatVersion: 1, name: "REST workflow", description: "Inspect the typed HTTP adapter", objective: "Verify workflow compatibility",
  phases: [{ id: "Review", ordinal: 1, name: "Review", barrier: { kind: "all" }, taskIDs: ["Final"] }],
  tasks: [{ id: "Final", phaseID: "Review", name: "Inspect HTTP", kind: "synthesize", prompt: "Inspect workflow routes", dependsOn: [], output: { kind: "text" } }],
  finalTaskID: "Final", completionCriteria: ["Workflow routes are verified"], requiredGates: [],
})

/** Actual HTTP adapter, workflow host, SQLite ledger and app renderer; ports keep tasks local and pending. */
export async function b86Harness(width: number, height: number) {
  const ids = createIdFactory(), dir = realpathSync(tempDir("mend-b86-ui-")), project = path.join(dir, "project")
  mkdirSync(project)
  const store = openStore({ dir, now: () => NOW })
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const host = createWorkflowsHost({
    store: store.workflows, definitions: store.workflowDefinitions,
    clock: { now: () => NOW, setTimer(ms, fn) { const timer = setTimeout(fn, ms); timers.add(timer); return { cancel: () => { clearTimeout(timer); timers.delete(timer) } } } },
    ids, layersFor: () => [], defaultPermission: () => "ask",
    createSession(input) { const id = ids("session"); store.createSession({ ...input, id }); return id },
    submit: async () => ({ queueId: ids("queue") }), cancelTurn: () => {}, deleteSession: () => true,
    runCheck: async () => ({ exitCode: 0, output: "" }), fingerprint: async () => "local-fake", emit: () => {},
  })
  const ledger = createAutomationLedgerHost(store)
  const dispatch = async (command: Record<string, unknown>) => {
    if (command.type === "models.list") return { ok: true as const, result: { models: [], defaults: {}, roles: {}, selectable: false } }
    if (/^workflow\.(events|artifacts|receipt|export)$/.test(String(command.type))) return ledger.handle(command as LedgerCommand)
    if (String(command.type).startsWith("workflow.")) return host.handle(command as WorkflowCommand)
    return { ok: true as const }
  }
  const token = remoteTokens(dir).create({ name: "ui" }).token
  const adapter = createHttpAdapter({ dir, directory: project, config: HttpServerConfig.parse({ enabled: true }), bridge: {
    async request(command) {
      const result = await dispatch(command)
      return result.ok ? { v: PROTOCOL_VERSION, kind: "ack", id: command.id, ok: true, result: result.result } as Frame : { v: PROTOCOL_VERSION, kind: "error", id: command.id, error: { code: result.code, message: result.message } } as Frame
    },
    stream: () => ({ receive() {}, close() {} }),
  } })
  const h = appHarness({ width, height, dataDir: dir, directory: project, reply: async (command) => {
    const result = await dispatch(command as unknown as Record<string, unknown>)
    return result.ok ? result : { ok: false, error: { code: result.code, message: result.message } }
  } })
  h.app.applySettings({ onboarded: true })
  let gseq = 0
  const request = async (route: string, value?: unknown, method?: string) => {
    const response = await adapter.fetch(new Request(`http://127.0.0.1:4096${route}`, { method: method ?? (value === undefined ? "GET" : "POST"), headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) }))
    if (!response?.ok) throw new Error(`B86 harness HTTP ${response?.status}: ${await response?.text()}`)
    const result = await host.handle({ type: "workflow.list", directory: project })
    if (result.ok) for (const workflow of result.result?.workflows as WorkflowSummary[]) h.app.onGlobal({ type: "workflow.changed", gseq: ++gseq, at: NOW, workflow })
    return response.json()
  }
  const started = await request("/workflow/start", { plan: b86Plan() })
  const workflowId = started.run.id as WorkflowRun["workflowId"]
  return { ...h, request, workflowId, store, async close() { await h.app.onKey("\x03"); host.dispose(); adapter.close(); for (const timer of timers) clearTimeout(timer); store.close() } }
}
