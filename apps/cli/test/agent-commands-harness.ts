import type { AgentCommandRecord, AgentCommandRequest, AgentCommandsReport, AgentCommandPolicyReport } from "@mendcode/protocol"
import { appHarness, ids, NOW, tempDir } from "./session-ui-harness"

export function peerCommandsHarness(width = 100, height = 30) {
  const source = ids("session")
  const target = ids("session")
  const make = (request: AgentCommandRequest, state: AgentCommandRecord["state"] = "pending", incoming = true): AgentCommandRecord => ({
    commandId: ids("command"), sourceSessionId: incoming ? source : target, targetSessionId: incoming ? target : source, request, state,
    policy: { decision: request.kind === "request_summary" ? "safe_auto" : request.kind === "rename" || request.kind === "tag" ? "same_workspace" : "approval_required", permissions: request.kind === "request_summary" ? ["session.summary.read"] : ["agent_view.metadata.patch"], reason: "Target review before execution." },
    expiresAt: NOW + 1_800_000, createdAt: NOW - 1000, updatedAt: NOW,
  })
  const commands: AgentCommandRecord[] = [
    make({ kind: "rename", title: "Client recovery" }),
    make({ kind: "tag", tags: ["client", "review"] }),
    make({ kind: "request_summary", instructions: "Report reconnect progress and remaining tests." }, "running", false),
    { ...make({ kind: "request_summary" }, "completed", false), result: "Reconnect preserves queued commands. The fake transport passed replay and duplicate-delivery checks. Remaining work: retry behavior during suspend." },
    { ...make({ kind: "send_message", text: "Check suspend recovery" }, "failed"), error: "Target turn interrupted" },
    make({ kind: "stop", reason: "Wait for review" }),
  ]
  let report: AgentCommandsReport = { commands, metadata: [{ sessionId: source, tags: ["coordinator"] }] }
  let error = ""
  const policy: AgentCommandPolicyReport = { matrix: ["request_summary", "rename", "tag", "pause_after_turn", "stop", "send_message", "peer_message"].map((kind) => ({ kind, decision: kind === "request_summary" || kind === "peer_message" ? "safe_auto" : kind === "rename" || kind === "tag" ? "same_workspace" : "approval_required", permissions: kind === "request_summary" ? ["session.summary.read"] : kind === "peer_message" ? [] : kind === "rename" || kind === "tag" ? ["agent_view.metadata.patch"] : [kind === "send_message" ? "session.message.send" : `session.control.${kind}`], reason: "Local policy" })) as AgentCommandPolicyReport["matrix"] }
  const h = appHarness({ width, height, sessionId: target, dataDir: tempDir(), directory: "/work/mendcode", reply(command) {
    if (command.type === "session.agent-command.list") return error ? { ok: false, error: { code: "internal", message: error } } : { ok: true, result: report }
    if (command.type === "session.agent-command.policy") return { ok: true, result: policy }
    if (command.type === "session.list") return { ok: true, result: { sessions: [{ sessionId: source, title: "Coordinator", directory: "/work/mendcode", state: "idle" }, { sessionId: target, title: "Client worker", directory: "/work/mendcode", state: "generating" }] } }
    if (command.type === "session.agent-command.create") {
      const entry = { ...make(command.request), sourceSessionId: command.sessionId, targetSessionId: command.targetSessionId }
      report.commands.unshift(entry)
      return { ok: true, result: { command: entry } }
    }
    if (command.type === "session.agent-command.update") {
      const entry = report.commands.find((entry) => entry.commandId === command.commandId)!
      entry.state = command.state === "accepted" ? "completed" : "rejected"
      if (entry.request.kind === "rename" && command.state === "accepted") report.metadata.push({ sessionId: target, title: entry.request.title, tags: [] })
      return { ok: true, result: { command: entry } }
    }
    return undefined
  } })
  h.app.applySettings({ onboarded: true, reducedMotion: true })
  return { ...h, source, target, commands, report: () => report, setReport: (next: AgentCommandsReport) => { report = next }, setError: (next: string) => { error = next } }
}
