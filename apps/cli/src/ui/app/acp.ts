import type { AcpRegistryReport, Settings } from "@mendcode/protocol"
import type { AppContext } from "./context"
import { acpPageKey, createAcpPageState, preload } from "../lazy-pages"

export function createAcp(ctx: AppContext) {
  const { state, input, requestFrame } = ctx

  async function loadAcp() {
    const reply = await input.send({ type: "settings.get" })
    state.acpState.loading = false
    if (reply.ok) {
      state.settingsNow = (reply.result?.settings as Settings | undefined) ?? state.settingsNow
      delete state.acpState.error
    } else state.acpState.error = reply.error.message
    requestFrame()
  }

  async function openAcp() {
    await preload("acp")
    state.acpState = { ...createAcpPageState(), loading: true }
    state.page = "acp"
    requestFrame()
    await loadAcp()
  }

  async function loadRegistry(agentId?: string) {
    state.acpState.loading = true
    requestFrame()
    const reply = await input.send({ type: "acp.registry", operation: agentId ? "add" : "list", ...(agentId ? { agentId } : {}) })
    state.acpState.loading = false
    if (reply.ok) {
      const report = reply.result as AcpRegistryReport & { settings?: Settings }
      state.acpState.registry = { agents: report.agents, selected: state.acpState.registry?.selected ?? 0 }
      if (report.settings) state.settingsNow = report.settings
      delete state.acpState.error
      if (agentId) ctx.say("agent added · pick it in /model", "success")
    } else state.acpState.error = reply.error.message
    requestFrame()
  }

  async function acpKey(key: string) {
    if (state.acpState.loading) {
      if (key === "\x1b" || key === "q") state.page = "chat"
      return
    }
    const result = acpPageKey(state.acpState, key, state.settingsNow.acpAgents ?? {})
    state.acpState = result.state
    const { action } = result
    if (action.type === "close") state.page = "chat"
    else if (action.type === "refresh") await loadAcp()
    else if (action.type === "registry") await loadRegistry()
    else if (action.type === "registry-add") await loadRegistry(action.agentId)
    else if (action.type === "save" || action.type === "remove") {
      const reply = await input.send({ type: "settings.set", patch: { acpAgents: { [action.name]: action.type === "remove" ? null : action.config } } })
      if (reply.ok) {
        state.settingsNow = (reply.result?.settings as Settings | undefined) ?? state.settingsNow
        state.acpState = { selected: state.acpState.selected }
        ctx.say(action.type === "remove" ? "agent removed" : "agent saved", "success")
        await loadAcp()
      } else state.acpState.error = reply.error.message
    }
    requestFrame()
  }

  return { openAcp, acpKey }
}
