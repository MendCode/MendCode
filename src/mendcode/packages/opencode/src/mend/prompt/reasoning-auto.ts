import type { ModelMessage } from "ai"

export type ReasoningAutoSignal = "verification_failed" | "technical_block"

export function autoReasoningSignal(messages: ModelMessage[]): ReasoningAutoSignal | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.role === "user") return
    if (message.role !== "tool") continue
    for (const part of message.content) {
      if (part.type !== "tool-result" || part.toolName !== "reasoning_auto") continue
      const output = part.output
      let value: unknown
      if (output.type === "json") value = output.value
      if (output.type === "text") {
        try { value = JSON.parse(output.value) } catch { continue }
      }
      if (!value || typeof value !== "object") continue
      const signal = (value as { signal?: unknown }).signal
      if (signal === "verification_failed" || signal === "technical_block") return signal
    }
  }
}

export function selectAutoReasoning(input: {
  enabled: boolean
  manual?: string
  variants?: Record<string, unknown>
  signal?: ReasoningAutoSignal
}) {
  if (!input.enabled || input.manual) return undefined
  const supported = ["low", "medium", "high"].filter((effort) => input.variants?.[effort] !== undefined)
  const initial = supported.includes("medium") ? "medium" : supported[0]
  if (!initial) return undefined
  const index = supported.indexOf(initial)
  const effort = input.signal ? supported[Math.min(index + 1, supported.length - 1)] : initial
  return { effort, reason: input.signal ?? "balanced_initial", options: input.variants![effort] as Record<string, unknown> }
}
