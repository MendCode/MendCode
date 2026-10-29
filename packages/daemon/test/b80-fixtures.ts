import { rmSync } from "node:fs"
import { createIdFactory, type ComputerTarget, type ComputerNode, type ComputerSessionReport, type ComputerObservation } from "@mendcode/protocol"
import type { ComputerActivation, ToolResult } from "@mendcode/tools"
import type { ComputerAccessibility, SemanticAction } from "../src/computer-accessibility"
import { computerFixture, signal } from "./b29-fixtures"

export function fakeAccessibility() {
  const target = { pid: 42, bundleID: "local.editor", appName: "Local Editor" }
  const nodes: ComputerNode[] = [
    { id: "0", role: "AXWindow", name: "Project", states: ["enabled"], actions: [] },
    { id: "0.1", role: "AXButton", name: "Save", states: ["enabled"], actions: ["press"] },
    { id: "0.2", role: "AXTextField", name: "Search", value: "draft", states: ["enabled"], actions: ["setValue"] },
    { id: "0.3", role: "AXSecureTextField", name: "secret name", value: "SECRET", states: ["secure"], actions: ["setValue"] },
  ]
  const actions: SemanticAction[] = [], calls: string[] = []
  const state = { target, nodes, truncated: false, indicator: true, front: undefined as ComputerTarget | undefined, onObserve: undefined as (() => Promise<void>) | undefined, onAction: undefined as (() => Promise<void>) | undefined }
  let visible = false
  const os: ComputerAccessibility = {
    // `front` is another app the user works in; the target itself keeps running.
    async foreground(abort) { abort.throwIfAborted(); calls.push("foreground"); return { ...(state.front ?? state.target) } },
    async identify(approved, abort) { abort.throwIfAborted(); calls.push("identify"); return approved.pid === state.target.pid && approved.bundleID === state.target.bundleID ? { ...state.target } : undefined },
    async observe(_, abort) { calls.push("observe"); await state.onObserve?.(); abort.throwIfAborted(); return { nodes: structuredClone(state.nodes), truncated: state.truncated } },
    async action(_, input, abort) { if (!visible) throw new Error("No visible indicator"); await state.onAction?.(); abort.throwIfAborted(); calls.push(input.action); actions.push(input); const node = state.nodes.find((node) => node.id === input.nodeID); if (input.action === "setValue" && node) node.value = input.value! },
    async indicator(abort, action) { abort.throwIfAborted(); calls.push("indicator"); if (!state.indicator) throw new Error("Computer indicator did not become ready"); visible = true; try { await action() } finally { visible = false } },
  }
  return { state, os, actions, calls }
}

export const activation: ComputerActivation = { sourceId: createIdFactory()("item"), text: "Observe the current editor", approve: async () => true }
export const data = <T>(result: ToolResult): T => { if (result.isError) throw new Error(result.output); return JSON.parse(result.output) }

export function b80Fixture(options: Parameters<typeof computerFixture>[0] = {}) {
  const ax = fakeAccessibility()
  const f = computerFixture({ accessibility: ax.os, ...options })
  async function start(mode: "observe" | "control" = "observe", authority = activation) {
    const capture = data<{ captureID: string }>(await f.port.capture({}, signal()))
    return data<ComputerSessionReport>(await f.port.session!({ action: "start", mode, bootstrapCaptureID: capture.captureID }, signal(), authority))
  }
  async function observe(id: string) { return data<ComputerObservation>(await f.port.observe!({ computerSessionID: id }, signal())) }
  return { ...f, ax, start, observe, close() { f.control.stop(); f.store.close(); rmSync(f.dir, { recursive: true, force: true }) } }
}
