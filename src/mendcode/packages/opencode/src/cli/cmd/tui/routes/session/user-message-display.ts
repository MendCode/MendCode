export type UserMessageDisplayOptions = {
  maxLines?: number
  maxChars?: number
}

export type UserMessageDisplay = {
  text: string
  compacted: boolean
  hiddenLines: number
  hiddenChars: number
}

export type PastedContentDisplayPart = {
  text: string
  metadata?: {
    kind?: unknown
  }
  source?: {
    text?: {
      value?: string
    }
  }
}

export function isPastedContentPart(part: unknown): part is PastedContentDisplayPart {
  if (!part || typeof part !== "object") return false
  const value = part as PastedContentDisplayPart & { type?: unknown; synthetic?: unknown }
  return (
    value.type === "text" &&
    value.synthetic === true &&
    value.metadata?.kind === "pasted_content" &&
    typeof value.text === "string" &&
    value.text.length > 0
  )
}

function defaultPastedContentLabel(text: string) {
  return `[Pasted Content ${text.length} chars]`
}

export function expandPastedContentPlaceholders(text: string, parts: readonly PastedContentDisplayPart[]) {
  let expanded = text
  let searchStart = 0
  const unmatched: string[] = []

  for (const part of parts) {
    const label = part.source?.text?.value || defaultPastedContentLabel(part.text)
    const replacement = `${label}\n${part.text}`
    const index = expanded.indexOf(label, searchStart)

    if (index === -1) {
      unmatched.push(replacement)
      continue
    }

    expanded = expanded.slice(0, index) + replacement + expanded.slice(index + label.length)
    searchStart = index + replacement.length
  }

  if (unmatched.length === 0) return expanded
  const separator = expanded.trim().length > 0 ? "\n\n" : ""
  return `${expanded}${separator}${unmatched.join("\n\n")}`
}

export function userMessageDisplayText(text: string, options: UserMessageDisplayOptions = {}): UserMessageDisplay {
  const maxLines = Math.max(1, options.maxLines ?? 18)
  const maxChars = Math.max(20, options.maxChars ?? 2400)
  const lines = text.split("\n")
  const visibleLines = lines.slice(0, maxLines)
  let visible = visibleLines.join("\n")

  if (visible.length > maxChars) {
    visible = visible.slice(0, maxChars - 1).trimEnd()
  }

  const compacted = lines.length > maxLines || text.length > visible.length
  const hiddenLines = Math.max(0, lines.length - visibleLines.length)
  const hiddenChars = Math.max(0, text.length - visible.length)

  return {
    text: compacted ? visible.trimEnd() : text,
    compacted,
    hiddenLines,
    hiddenChars,
  }
}
