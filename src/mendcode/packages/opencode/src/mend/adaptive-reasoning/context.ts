import type { ModelMessage } from "ai"

export type EvaluatorContext = {
  goal: string
  progress: string
  tools: { name: string; result: string }[]
}

export function redactEvaluatorText(text: string, secrets: readonly string[] = []) {
  let result = text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]")
    .replace(/\b(?:sk-[a-zA-Z0-9_-]{8,}|gh[pousr]_[a-zA-Z0-9_]{8,}|github_pat_[a-zA-Z0-9_]{8,})\b/g, "[REDACTED TOKEN]")
    .replace(/\bBearer\s+[^\s"'<>]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[=:]\s*(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi, "[REDACTED CREDENTIAL]")
  for (const secret of secrets) {
    if (secret) result = result.split(secret).join("[REDACTED]")
  }
  return result
}

function preview(text: string, maxBytes: number) {
  const bytes = Buffer.from(text)
  if (bytes.length <= maxBytes) return text
  const marker = `\n[truncated; original ${bytes.length} bytes]`
  return bytes.subarray(0, maxBytes - Buffer.byteLength(marker)).toString("utf8").replace(/\uFFFD$/, "") + marker
}

function publicText(message: ModelMessage) {
  if (message.role !== "user" && message.role !== "assistant") return ""
  if (typeof message.content === "string") return message.content
  // Excludes reasoning, images, attachments, tool arguments and provider metadata.
  return message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")
}

/** Only pass the host's public conversation, before injected memory/system assembly. */
export function projectEvaluatorContext(messages: readonly ModelMessage[], secrets: readonly string[] = []): EvaluatorContext {
  const last = messages.findLastIndex((message) => message.role === "user")
  if (last < 0) throw new Error("Evaluator requires a public user goal")
  const goal = publicText(messages[last])
  if (!goal.trim() || Buffer.byteLength(goal) > 8_192) throw new Error("Evaluator goal is missing or exceeds 8192 bytes")
  const context: EvaluatorContext = { goal: redactEvaluatorText(goal, secrets), progress: "", tools: [] }
  // Bound retained results before projection; never serialize the whole history.
  for (let i = messages.length - 1; i > last; i--) {
    const message = messages[i]
    if (message.role === "assistant" && !context.progress) {
      context.progress = preview(redactEvaluatorText(publicText(message), secrets), 4_096)
    }
    if (message.role !== "tool" || context.tools.length >= 4) continue
    for (let j = message.content.length - 1; j >= 0 && context.tools.length < 4; j--) {
      const result = message.content[j]
      if (result.type !== "tool-result" || !["text", "error-text"].includes(result.output.type)) continue
      const paired = messages.slice(last + 1, i).some((candidate) =>
        candidate.role === "assistant" && Array.isArray(candidate.content) && candidate.content.some((part) =>
          part.type === "tool-call" && part.toolCallId === result.toolCallId && part.toolName === result.toolName))
      if (!paired || (result.output.type !== "text" && result.output.type !== "error-text")) continue
      context.tools.unshift({
        name: preview(redactEvaluatorText(result.toolName, secrets), 128),
        result: preview(redactEvaluatorText(result.output.value, secrets), 2_048),
      })
    }
  }
  if (Buffer.byteLength(JSON.stringify(context)) > 24_576) throw new Error("Evaluator context exceeds 24576 bytes")
  return context
}
