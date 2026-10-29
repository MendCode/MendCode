import type { MflowChange, MflowRead, MflowReport } from "@mendcode/protocol"
import type { AppContext } from "./context"
import type { MflowPageState } from "../../view/mflow-page"
import { preload } from "../lazy-pages"

export function createMflow(ctx: AppContext) {
  const { input, state, requestFrame } = ctx
  async function request(view: MflowPageState, request: { query: MflowRead } | { change: MflowChange }) {
    if (view.busy) return
    if (view.readOnly) { view.error = "Mflow requires a full-access peer"; requestFrame(); return }
    view.busy = true
    view.error = ""
    requestFrame()
    try {
      const directory = input.directory ?? "."
      const reply = "query" in request ? await input.send({ type: "mflow.query", directory, query: request.query }) : await input.send({ type: "mflow.change", directory, change: request.change })
      if (!reply.ok) view.error = reply.error.message
      else { view.report = reply.result as MflowReport; view.scroll = 0; if (view.report.ok && "change" in request) view.form = undefined }
    } catch { view.error = "Mflow unavailable; refresh to retry" }
    finally { view.busy = false; requestFrame() }
  }
  function configure(view: MflowPageState) {
    if (view.readOnly) { view.error = "Mflow requires a full-access peer"; return }
    const values = [view.report?.config.room ?? "", view.report?.config.signaling ?? "embedded", "", String(view.report?.config.hookPriority ?? 0)]
    view.form = { values, cursors: values.map((value) => value.length), selected: 0 }
  }
  async function mflowCommand(text: string) {
    const match = /^\/mflow(?:\s+(.*))?$/.exec(text.trim())
    if (!match) return false
    await preload("mflow")
    const view: MflowPageState = { selected: 0, scroll: 0, details: false, readOnly: input.remote?.readOnly ?? false }
    state.mflow = view
    state.page = "mflow"
    if (!match[1]) await request(view, { query: { operation: "status" } })
    else {
      const { parseMflow } = await import("../../mflow-args")
      const tokens = match[1].match(/"[^"]*"|'[^']*'|\S+/g)?.map((value) => value.replace(/^(["'])(.*)\1$/, "$2")) ?? []
      const parsed = parseMflow(["mflow", ...tokens])
      if (parsed?.ok !== true || parsed.command.kind !== "mflow") view.error = parsed?.ok === false ? parsed.message : "Use /mflow or /mflow status"
      else if (tokens[0] === "setup" && tokens.length === 1) { await request(view, { query: { operation: "status" } }); configure(view) }
      else if (parsed.command.request.type === "mflow.change" && parsed.command.request.change.operation === "remove") { await request(view, { query: { operation: "status" } }); view.confirm = true }
      else {
        await request(view, parsed.command.request.type === "mflow.query" ? { query: parsed.command.request.query } : { change: parsed.command.request.change })
        view.details = parsed.command.request.type === "mflow.query" && parsed.command.request.query.operation !== "status" || tokens[0] === "plan"
      }
    }
    requestFrame()
    return true
  }
  async function mflowKey(key: string) {
    const view = state.mflow
    if (!view || view.busy) return
    if (key === "\x1b") {
      if (view.form) view.form = undefined
      else if (view.confirm) view.confirm = false
      else if (view.details) view.details = false
      else state.page = "chat"
    } else if (view.confirm) {
      if (key === "y") { await request(view, { change: { operation: "remove" } }); view.confirm = false }
      if (key === "n") view.confirm = false
    } else if (view.form) {
      const form = view.form, index = form.selected, value = form.values[index] ?? "", cursor = form.cursors[index] ?? value.length
      if (key === "\r") {
        const [room, signaling, tokenFile, rawPriority] = form.values
        const hookPriority = Number(rawPriority)
        if (!room?.trim()) view.error = "Room required"
        else if (!Number.isInteger(hookPriority) || hookPriority < 0 || hookPriority > 9) view.error = "Priority must be 0–9"
        else await request(view, { change: { operation: "activate", input: { room: room.trim(), signaling: signaling || "embedded", hookPriority, ...(tokenFile ? { tokenFile } : {}) } } })
      } else if (["\t", "\x1b[B", "\x1b[Z", "\x1b[A"].includes(key)) form.selected = (index + (key === "\x1b[Z" || key === "\x1b[A" ? 3 : 1)) % 4
      else if (key === "\x1b[D") form.cursors[index] = Math.max(0, cursor - 1)
      else if (key === "\x1b[C") form.cursors[index] = Math.min(value.length, cursor + 1)
      else if (key === "\x01" || key === "\x1b[H") form.cursors[index] = 0
      else if (key === "\x05" || key === "\x1b[F") form.cursors[index] = value.length
      else if (key === "\x7f" && cursor > 0) { form.values[index] = value.slice(0, cursor - 1) + value.slice(cursor); form.cursors[index] = cursor - 1 }
      else if (key === "\x15") { form.values[index] = ""; form.cursors[index] = 0 }
      else if (key === "\x1b[3~") form.values[index] = value.slice(0, cursor) + value.slice(cursor + 1)
      else if (!/[\x00-\x1f\x7f]/.test(key) && value.length + key.length <= (index === 0 ? 200 : index === 3 ? 2 : 4096)) {
        form.values[index] = value.slice(0, cursor) + key + value.slice(cursor)
        form.cursors[index] = cursor + key.length
      }
    } else if (key === "\t") { view.details = !view.details; view.scroll = 0 }
    else if (key === "r") {
      const operation = view.report?.operation ?? "status"
      await request(view, { query: { operation: ["status", "scan", "relay-guide", "doctor", "legacy-status"].includes(operation) ? operation as MflowRead["operation"] : "status" } })
    }
    else if (["\x1b[A", "k", "\x1b[5~"].includes(key)) {
      if (view.details) view.scroll = Math.max(0, view.scroll - (key === "\x1b[5~" ? 10 : 1))
      else view.selected = Math.max(0, view.selected - 1)
    } else if (["\x1b[B", "j", "\x1b[6~"].includes(key)) {
      if (view.details) view.scroll += key === "\x1b[6~" ? 10 : 1
      else view.selected = Math.min(10, view.selected + 1)
    } else if (key === "\r" && !view.details) {
      if (view.selected === 0) configure(view)
      else if (view.selected === 4) view.confirm = true
      else if (view.selected === 5) view.details = true
      else if ([1, 2, 3, 8].includes(view.selected)) {
        const operation = ({ 1: "start", 2: "stop", 3: "deactivate", 8: "plan" } as const)[view.selected as 1 | 2 | 3 | 8]
        await request(view, { change: { operation } })
        if (operation === "plan") view.details = true
      } else {
        const operation = ({ 6: "scan", 7: "relay-guide", 9: "doctor", 10: "legacy-status" } as const)[view.selected as 6 | 7 | 9 | 10]
        await request(view, { query: { operation } })
        view.details = true
      }
    }
    requestFrame()
  }
  return { mflowCommand, mflowKey }
}
