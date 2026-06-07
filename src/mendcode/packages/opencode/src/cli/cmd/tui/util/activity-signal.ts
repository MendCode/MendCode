import type { MendTuiProfile } from "@/mend/profile"
import { activityMessagesForPhase, type MendActivityPhase } from "@/mend/tui/presentation"

export type ActivitySignalInput = {
  status: "idle" | "busy" | "retry" | string
  retry?: boolean
  connection?: "connecting" | "connected" | "reconnecting" | "disconnected" | "failed"
  toolNames?: string[]
  activeToolNames?: string[]
  hasReasoning?: boolean
  hasAnswerText?: boolean
  livePhase?: "input" | "output"
  liveOutputTokens?: number
  liveReasoningTokens?: number
}

export function resolveActivityPhase(input: ActivitySignalInput): MendActivityPhase {
  if (input.connection && input.connection !== "connected") return "blocked"
  if (input.retry || input.status === "retry") return "retrying"
  if (input.status === "idle") return "done"

  const activeNames = (input.activeToolNames ?? []).map((item) => item.toLowerCase())
  const activeToolPhase = phaseForToolNames(activeNames)
  if (activeToolPhase) return activeToolPhase

  const liveOutput = input.liveOutputTokens ?? 0
  const liveReasoning = input.liveReasoningTokens ?? 0
  const liveAnswerOutput = input.hasAnswerText || (liveReasoning <= 0 ? liveOutput > 0 : liveOutput > liveReasoning)
  if (input.livePhase === "output" && liveAnswerOutput) return "sending"

  const names = (input.toolNames ?? []).map((item) => item.toLowerCase())
  const toolPhase = phaseForToolNames(names)
  if (toolPhase) return toolPhase

  const hasLiveTokenEvidence = liveOutput > 0 || liveReasoning > 0
  if (!input.hasReasoning && !input.hasAnswerText && !hasLiveTokenEvidence) return "sending"
  if (input.hasReasoning) return "thinking"
  if (input.livePhase === "output" && liveReasoning <= 0) return "sending"
  return input.status === "busy" ? "thinking" : "sending"
}

function phaseForToolNames(names: string[]): MendActivityPhase | undefined {
  if (names.some((name) => name.includes("upload"))) return "uploading"
  if (names.some((name) => name.includes("download"))) return "downloading"
  if (
    names.some(
      (name) => name.includes("web") || name.includes("fetch") || name.includes("browser") || name.includes("chrome"),
    )
  ) {
    return "browsing"
  }
  if (
    names.some(
      (name) => name.includes("install") || name.includes("pnpm") || name.includes("npm") || name.includes("bun"),
    )
  ) {
    return "installing"
  }
  if (
    names.some(
      (name) => name.includes("test") || name.includes("typecheck") || name.includes("lint") || name.includes("build"),
    )
  ) {
    return "testing"
  }
  if (names.some((name) => name.includes("patch") || name.includes("diff"))) return "patching"
  if (names.some((name) => name.includes("edit") || name.includes("write") || name.includes("update"))) return "editing"
  if (names.some((name) => name.includes("read") || name.includes("open") || name.includes("cat"))) return "reading"
  if (
    names.some(
      (name) => name.includes("search") || name.includes("grep") || name.includes("glob") || name.includes("list"),
    )
  ) {
    return "searching"
  }
  if (names.some((name) => name.includes("plan") || name.includes("spec") || name.includes("review"))) return "planning"
  if (
    names.some(
      (name) => name.includes("bash") || name.includes("shell") || name.includes("exec") || name.includes("command"),
    )
  )
    return "running"
  return undefined
}

export function activityMessage(input: { profile: MendTuiProfile; phase: MendActivityPhase; tick: number }) {
  const messages = activityMessagesForPhase(input.profile, input.phase)
  const interval = Math.max(250, input.profile.workingIndicator.messageIntervalMs || 2500)
  return messages[Math.floor(input.tick / interval) % messages.length] ?? "Thinking..."
}
