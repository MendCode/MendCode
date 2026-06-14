import type { PromptInfo } from "./history"

type PromptPart = PromptInfo["parts"][number]
type PromptTextPart = Extract<PromptPart, { type: "text" }>

export function pastedContentLabel(text: string) {
  return `[Pasted Content ${text.length} chars]`
}

export const DEFAULT_PASTE_SUMMARY_MIN_CHARS = 3000

export function shouldSummarizePastedContent(text: string) {
  return shouldSummarizePastedContentWithThreshold(text, DEFAULT_PASTE_SUMMARY_MIN_CHARS)
}

export function shouldSummarizePastedContentWithThreshold(text: string, minChars: number) {
  return text.length > Math.max(1, minChars)
}

export function promptSubmitParts(prompt: PromptInfo) {
  const pastedTextParts = prompt.parts.filter(
    (part): part is PromptTextPart => part.type === "text" && Boolean(part.text),
  )
  const nonTextParts = prompt.parts.filter((part) => part.type !== "text")
  const parts: PromptInfo["parts"] = []

  if (prompt.input.trim()) {
    parts.push({
      type: "text",
      text: prompt.input,
    })
  }

  for (const part of pastedTextParts) {
    parts.push({
      type: "text",
      text: part.text,
      synthetic: true,
      source: part.source as PromptTextPart["source"],
      metadata: {
        kind: "pasted_content",
        chars: part.text.length,
      },
    } as PromptPart)
  }

  return {
    inputText: prompt.input,
    parts: [...parts, ...nonTextParts],
    nonTextParts,
  }
}

type PromptPartWithRuntimeFields = {
  type: string
  text?: string
  source?: PromptTextPart["source"]
  id?: string
  messageID?: string
  sessionID?: string
  synthetic?: boolean
  metadata?: {
    kind?: string
    chars?: number
  }
  [key: string]: unknown
}

function asRuntimePart(part: unknown): PromptPartWithRuntimeFields {
  return part as PromptPartWithRuntimeFields
}

export function restorePromptFromSubmittedParts(parts: readonly unknown[]): PromptInfo {
  let input = ""
  const promptParts: PromptInfo["parts"] = []

  for (const raw of parts) {
    const part = asRuntimePart(raw)
    if (part.type === "text" && !part.synthetic) input += part.text
  }

  let searchStart = 0
  for (const raw of parts) {
    const part = asRuntimePart(raw)
    if (part.type === "text") {
      if (!part.synthetic || part.metadata?.kind !== "pasted_content" || !part.text) continue

      const label = part.source?.text?.value || pastedContentLabel(part.text)
      let start = input.indexOf(label, searchStart)
      if (start === -1) {
        const prefix = input && !input.endsWith(" ") ? " " : ""
        start = input.length + prefix.length
        input += `${prefix}${label}`
      }
      const end = start + label.length
      searchStart = end
      promptParts.push({
        type: "text",
        text: part.text,
        source: {
          text: {
            start,
            end,
            value: label,
          },
        },
      })
      continue
    }

    const { id: _id, messageID: _messageID, sessionID: _sessionID, ...rest } = part
    promptParts.push(rest as PromptPart)
  }

  return { input, parts: promptParts }
}
