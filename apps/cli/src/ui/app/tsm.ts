import type { TsmChange, TsmRead, TsmReport } from "@mendcode/protocol"
import type { AppContext } from "./context"
import type { TsmPageState } from "../../view/tsm-page"
import { preload } from "../lazy-pages"
import { parseTsm, TSM_USAGE } from "../../tsm-args"
import { TSM_ACTIONS } from "../../tsm-actions"

export function createTsm(ctx: AppContext) {
  const { input, state, requestFrame } = ctx
  async function request(view: TsmPageState, operation: TsmRead | TsmChange, write = false) {
    if (view.busy) return
    if (input.remote?.readOnly) { view.error = "TSM probes and changes unavailable in read-only mode"; requestFrame(); return }
    view.busy = true
    view.error = ""
    view.scroll = 0
    requestFrame()
    try {
      const directory = input.directory ?? "."
      const reply = write ? await input.send({ type: "tsm.change", directory, change: operation as TsmChange }) : await input.send({ type: "tsm.query", directory, query: operation as TsmRead })
      if (!reply.ok) view.error = reply.error.message
      else {
        view.report = reply.result as TsmReport
        view.mux = view.report.defaultMuxBackend
        view.section = view.report.preview ? "preview" : ["plan", "setup", "install"].includes(operation.operation) ? "plan" : operation.operation === "doctor" ? "doctor" : "status"
      }
    } catch (error) { view.error = error instanceof Error ? error.message : String(error) }
    finally { view.busy = false; requestFrame() }
  }
  async function select(view: TsmPageState) {
    const action = TSM_ACTIONS[view.selected]!
    if (action.id === "activate" && !view.report?.worktreeCapable) { view.error = "Activation requires a worktree-capable TSM binary"; return }
    if (action.id === "deactivate" && !view.report?.enabled) return
    if (action.id === "workspace" || action.id === "details" || action.id === "status") {
      view.section = action.id
      view.detailsFocused = true
      view.scroll = 0
    } else if (action.id === "remove") {
      if (view.readOnly) view.error = "TSM changes unavailable in read-only mode"
      else { view.confirmRemove = true; view.scroll = 0; view.detailsFocused = true }
    } else if (action.id === "open") {
      if (view.report) await request(view, { operation: "open", target: view.report.workspace.currentPath })
      view.detailsFocused = true
    } else if (action.id === "activate") {
      await request(view, { operation: "activate", muxBackend: view.mux }, true)
      view.detailsFocused = true
    } else {
      await request(view, { operation: action.id }, action.id !== "doctor")
      view.detailsFocused = true
    }
  }
  async function tsmCommand(text: string) {
    const match = /^\/tsm(?:\s+([\s\S]*))?$/.exec(text.trim())
    if (!match) return false
    await preload("tsm")
    const view: TsmPageState = { selected: 0, scroll: 0, detailsFocused: false, section: "status", mux: "auto", readOnly: input.remote?.readOnly ?? false }
    state.tsm = view
    state.page = "tsm"
    const args = match[1]?.trim()
    const parsed = parseTsm(["tsm", ...(args ? args.startsWith("open ") ? ["open", args.slice(5).trim()] : args.split(/\s+/) : [])])
    if (parsed?.ok !== true || parsed.command.kind !== "tsm") view.error = parsed?.ok === false ? parsed.message : TSM_USAGE
    else {
      const command = parsed.command.request
      const operation = command.type === "tsm.change" ? command.change : command.query
      view.selected = Math.max(0, TSM_ACTIONS.findIndex((action) => action.id === (operation.operation === "install" ? "plan" : operation.operation === "create" ? "open" : operation.operation)))
      if (operation.operation === "remove") {
        await request(view, { operation: "status" })
        view.confirmRemove = !view.readOnly
        view.detailsFocused = true
      } else await request(view, operation, command.type === "tsm.change")
      if (args) view.detailsFocused = true
    }
    requestFrame()
    return true
  }
  async function tsmKey(key: string) {
    const view = state.tsm
    if (!view) return
    if (view.busy) { if (key === "\x1b") state.page = "chat"; requestFrame(); return }
    if (view.confirmRemove) {
      if (key === "y" || key === "Y") { view.confirmRemove = false; await request(view, { operation: "remove" }, true) }
      else if (key === "n" || key === "N" || key === "\x1b") { view.confirmRemove = false; view.detailsFocused = false; view.scroll = 0 }
      requestFrame()
      return
    }
    if (key === "\x1b") { if (view.detailsFocused) { view.detailsFocused = false; view.scroll = 0 } else state.page = "chat" }
    else if (key === "q") state.page = "chat"
    else if (key === "\t") { view.detailsFocused = !view.detailsFocused; view.scroll = 0 }
    else if (["\x1b[A", "k", "\x1b[5~"].includes(key)) {
      if (view.detailsFocused) view.scroll = Math.max(0, view.scroll - (key === "\x1b[5~" ? 10 : 1))
      else view.selected = Math.max(0, view.selected - 1)
    } else if (["\x1b[B", "j", "\x1b[6~"].includes(key)) {
      if (view.detailsFocused) view.scroll += key === "\x1b[6~" ? 10 : 1
      else view.selected = Math.min(TSM_ACTIONS.length - 1, view.selected + 1)
    } else if (key === "\r") await select(view)
    else if (key === "r" || key === "d") await request(view, { operation: key === "d" ? "doctor" : "status" })
    else if (key === "m") {
      const muxes = ["auto", "cmux", "kitty", "ghostty", "wezterm"] as const
      view.mux = muxes[(muxes.indexOf(view.mux) + 1) % muxes.length]!
    }
    requestFrame()
  }
  return { tsmCommand, tsmKey }
}
