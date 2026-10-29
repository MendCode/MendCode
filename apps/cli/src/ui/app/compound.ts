import type { CompoundConfig, CompoundReport, CompoundRunInput, SessionId } from "@mendcode/protocol"
import { preload } from "../lazy-pages"
import type { AppContext } from "./context"

export function createCompound(ctx: AppContext, actions: { switchSession(sessionId: SessionId): Promise<unknown> }) {
  const { state, input, requestFrame } = ctx
  async function load() {
    state.compoundPage ??= { profile: 0, run: 0, scroll: 0, error: "" }
    const reply = await input.send({ type: "compound.get", ...(input.directory ? { directory: input.directory } : {}) })
    if (reply.ok) { state.compoundReport = reply.result?.report as CompoundReport; state.compoundPage.error = "" }
    else state.compoundPage.error = reply.error.message
    requestFrame()
  }
  async function mutate(command: "toggle" | "cancel", config?: CompoundConfig) {
    if (input.remote?.readOnly) { state.compoundPage!.error = "Read-only terminal"; return }
    const report = state.compoundReport
    if (!report) return
    const run = report.runs[state.compoundPage!.run]
    const reply = command === "cancel" && run ? await input.send({ type: "compound.cancel", runId: run.runId }) : command === "toggle" ? await input.send({ type: "compound.configure", config: config ?? { ...report.config, orchestration: { ...report.config.orchestration, enabled: !report.config.orchestration.enabled } }, expectedHash: report.configHash }) : undefined
    if (reply && !reply.ok) state.compoundPage!.error = reply.error.message
    else await load()
    requestFrame()
  }
  async function compoundCommand(text: string) {
    const match = /^\/compound(?:\s+(.*))?$/s.exec(text.trim())
    if (!match) return false
    await preload("compound")
    state.page = "compound"
    await load()
    const argument = match[1]?.trim() ?? ""
    try {
      if (argument === "on" || argument === "off") {
        if (state.compoundReport) await mutate("toggle", { ...state.compoundReport.config, orchestration: { ...state.compoundReport.config.orchestration, enabled: argument === "on" } })
      } else if (argument.startsWith("configure ")) await mutate("toggle", JSON.parse(argument.slice(10)) as CompoundConfig)
      else if (argument.startsWith("run ")) {
        if (input.remote?.readOnly) throw new Error("Read-only terminal")
        const run = /^run\s+(\S+)\s+([\s\S]+)$/.exec(argument)
        if (!run) throw new Error('usage: /compound run <profile> {"prompt":"…","checks":[…]}')
        const data = JSON.parse(run[2]!) as Pick<CompoundRunInput, "prompt" | "checks" | "permission">
        const reply = await input.send({ type: "compound.start", input: { ...data, directory: input.directory ?? ".", profile: run[1]!, originSessionId: state.sessionId, permission: data.permission ?? "ask" } })
        if (!reply.ok) throw new Error(reply.error.message)
        state.compoundPage!.run = 0
        await load()
      } else if (argument) throw new Error("usage: /compound [on|off|configure <json>|run <profile> <json>]")
    } catch (error) { state.compoundPage!.error = error instanceof Error ? error.message : String(error) }
    requestFrame()
    return true
  }
  async function compoundKey(key: string) {
    const page = state.compoundPage!
    const report = state.compoundReport
    if (key === "\x1b" || key === "q") state.page = "chat"
    else if (key === "r") await load()
    else if (key === "e") await mutate("toggle")
    else if (key === "x" && report?.runs[page.run]?.state === "running") await mutate("cancel")
    else if (key === "o") { const leg = report?.runs[page.run]?.legs.at(-1); if (leg) { state.page = "chat"; await actions.switchSession(leg.sessionId) } }
    else if (key === "\x1b[A" || key === "\x1b[B") page.profile = Math.max(0, Math.min((report?.profiles.length ?? 1) - 1, page.profile + (key === "\x1b[A" ? -1 : 1)))
    else if (key === "[" || key === "]") { page.run = Math.max(0, Math.min((report?.runs.length ?? 1) - 1, page.run + (key === "[" ? -1 : 1))); page.scroll = 0 }
    else if (key === "\x1b[6~" || key === "\x1b[5~") page.scroll = Math.max(0, page.scroll + (key === "\x1b[6~" ? 5 : -5))
    requestFrame()
  }
  return { compoundCommand, compoundKey }
}
