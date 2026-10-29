import type { AgentsReport } from "@mendcode/protocol"
import { createAgentPickerState } from "../lazy-pages"
import type { AppContext } from "./context"

export function createAgentPicker(ctx: AppContext) {
  const { input, state, requestFrame, say, fail } = ctx
  let visit = 0

  async function chooseAgent(name: string) {
    const sessionId = state.sessionId
    const reply = await input.send({ type: "session.agent.set", sessionId, agent: name })
    if (state.sessionId !== sessionId) return
    if (!reply.ok) return fail(reply.error.code === "target_mismatch" && /^\[DAEMON\]: unknown agent\b/.test(reply.error.message) ? `unknown agent: ${name}` : reply.error.message)
    state.agentReport = reply.result as AgentsReport
    state.page = "chat"
    say(`agent: ${state.agentReport?.current ?? name}`, "success")
  }

  async function agentCommand(args: string) {
    const serial = ++visit
    const name = args.trim()
    const sessionId = state.sessionId
    if (!sessionId) return fail("agent: no session yet")
    if (!name) {
      state.page = "agent"
      state.agentReport = undefined
      state.agentError = ""
      state.agentPicker = createAgentPickerState()
      requestFrame()
    }
    const reply = await input.send({ type: "agents.list", sessionId })
    if (serial !== visit || state.sessionId !== sessionId || (!name && state.page !== "agent")) return
    if (!reply.ok) {
      state.agentError = reply.error.message
      fail(reply.error.message)
      return
    }
    const report = reply.result as AgentsReport
    state.agentReport = report
    if (name) {
      if (!report.agents.some((agent) => agent.name === name)) return fail(`unknown agent: ${name}`)
      await chooseAgent(name)
    } else state.agentPicker = createAgentPickerState(report)
    requestFrame()
  }

  return { agentCommand, chooseAgent }
}
