export type BackgroundTaskNotificationState = "needs_input" | "completed" | "failed" | "cancelled" | "interrupted"

export type BackgroundTaskToast = {
  title: string
  message: string
  variant: "info" | "error"
  duration: number
}

const MAX_TITLE_CHARS = 96
const MAX_DETAIL_CHARS = 240

function bound(value: string | undefined, max: number) {
  const normalized = value?.trim().replace(/\s+/g, " ")
  if (!normalized) return
  if (normalized.length <= max) return normalized
  return `${normalized.slice(0, max - 1)}…`
}

export function backgroundTaskToast(input: {
  state: BackgroundTaskNotificationState
  title?: string
  summary?: string
  error?: string
}): BackgroundTaskToast | undefined {
  if (input.state !== "needs_input" && input.state !== "failed") return

  const taskTitle = bound(input.title, MAX_TITLE_CHARS)
  const detail = bound(input.error ?? input.summary, MAX_DETAIL_CHARS) ??
    (input.state === "needs_input" ? "Action required" : "Background task failed")
  const needsInput = input.state === "needs_input"
  return {
    title: needsInput ? "Subagent needs input" : "Subagent failed",
    message: [taskTitle, detail].filter(Boolean).join(": "),
    variant: needsInput ? "info" : "error",
    duration: 8_000,
  }
}
