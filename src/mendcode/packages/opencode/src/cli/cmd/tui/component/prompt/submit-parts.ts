import type { PromptInfo } from "./history"

type PromptPart = PromptInfo["parts"][number]
type PromptTextPart = Extract<PromptPart, { type: "text" }>

type RuntimeClipboardPart = {
  type: string
  text?: string
  synthetic?: boolean
  mime?: string
  filename?: string
  url?: string
  source?: {
    text?: {
      value?: string
    }
  }
}

export type PortableImageClipboardToken =
  | { type: "text"; text: string }
  | { type: "image"; mime: string; content: string; filename?: string }

function asClipboardPart(part: unknown): RuntimeClipboardPart {
  return part as RuntimeClipboardPart
}

function imageMarkdown(part: RuntimeClipboardPart) {
  if (!part.url?.startsWith("data:") || !part.mime?.startsWith("image/")) return
  const match = part.url.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/)
  if (!match || !match[1].startsWith("image/")) return
  const filename = (part.filename || "image").replace(/[\]\n\r]/g, " ").trim() || "image"
  return `![${filename}](data:${match[1]};base64,${match[2].replace(/\s+/g, "")})`
}

export function messagePartsToPortableClipboard(parts: readonly unknown[]) {
  let text = ""
  const attachments: RuntimeClipboardPart[] = []

  for (const raw of parts) {
    const part = asClipboardPart(raw)
    if (part.type === "text" && !part.synthetic && part.text) text += part.text
    if (part.type === "file" && part.mime?.startsWith("image/") && part.url?.startsWith("data:")) attachments.push(part)
  }

  for (const attachment of attachments) {
    const markdown = imageMarkdown(attachment)
    if (!markdown) continue
    const placeholder = attachment.source?.text?.value
    if (placeholder && text.includes(placeholder)) {
      text = text.replace(placeholder, markdown)
      continue
    }
    text += `${text && !text.endsWith("\n") ? "\n\n" : ""}${markdown}`
  }

  return {
    text,
    imageCount: attachments.length,
    firstImage: attachments[0]
      ? {
          mime: attachments[0].mime!,
          data: attachments[0].url!.replace(/^data:[^;,]+;base64,/, "").replace(/\s+/g, ""),
        }
      : undefined,
  }
}

export function parsePortableImageClipboard(text: string): PortableImageClipboardToken[] | undefined {
  const regex = /!\[([^\]\n\r]*)\]\(data:(image\/[A-Za-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)\)/g
  const tokens: PortableImageClipboardToken[] = []
  let index = 0
  let matched = false

  for (const match of text.matchAll(regex)) {
    matched = true
    const start = match.index ?? 0
    if (start > index) tokens.push({ type: "text", text: text.slice(index, start) })
    tokens.push({
      type: "image",
      filename: match[1]?.trim() || undefined,
      mime: match[2],
      content: match[3].replace(/\s+/g, ""),
    })
    index = start + match[0].length
  }

  if (!matched) return
  if (index < text.length) tokens.push({ type: "text", text: text.slice(index) })
  return tokens.filter((token) => token.type !== "text" || token.text.length > 0)
}

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

function shiftPromptPart(part: PromptPart, input: { start: number; delta: number }) {
  if (part.type === "text" && part.source?.text && part.source.text.start > input.start) {
    return {
      ...part,
      source: {
        ...part.source,
        text: {
          ...part.source.text,
          start: part.source.text.start + input.delta,
          end: part.source.text.end + input.delta,
        },
      },
    } satisfies PromptPart
  }
  if (part.type === "file" && part.source?.text && part.source.text.start > input.start) {
    return {
      ...part,
      source: {
        ...part.source,
        text: {
          ...part.source.text,
          start: part.source.text.start + input.delta,
          end: part.source.text.end + input.delta,
        },
      },
    } satisfies PromptPart
  }
  if (part.type === "agent" && part.source && part.source.start > input.start) {
    return {
      ...part,
      source: {
        ...part.source,
        start: part.source.start + input.delta,
        end: part.source.end + input.delta,
      },
    } satisfies PromptPart
  }
  return part
}

function expandPastedContentPartAt(prompt: PromptInfo, index: number, input?: { replaceStart?: number; replaceEnd?: number }) {
  const part = prompt.parts[index]
  if (!part || part.type !== "text" || !part.source?.text) return

  const label = part.source.text.value
  const labelStart = prompt.input.indexOf(label, part.source.text.start)
  const start = input?.replaceStart ?? labelStart
  if (start === -1) return

  const end = input?.replaceEnd ?? start + label.length
  const delta = part.text.length - (end - start)
  return {
    input: `${prompt.input.slice(0, start)}${part.text}${prompt.input.slice(end)}`,
    parts: prompt.parts
      .filter((_, partIndex) => partIndex !== index)
      .map((item) => shiftPromptPart(item, { start, delta })),
    cursorOffset: start + part.text.length,
  } satisfies PromptInfo & { cursorOffset: number }
}

export function expandPastedContentInPrompt(prompt: PromptInfo, pastedText: string) {
  const index = prompt.parts.findLastIndex(
    (part) => part.type === "text" && part.text === pastedText && Boolean(part.source?.text?.value),
  )
  return expandPastedContentPartAt(prompt, index)
}

export function expandPastedContentAtOffset(prompt: PromptInfo, offset: number) {
  const index = prompt.parts.findIndex((part) => {
    if (part.type !== "text" || !part.source?.text?.value) return false
    return offset >= part.source.text.start && offset <= part.source.text.end
  })
  return expandPastedContentPartAt(prompt, index)
}

export function expandEditedPastedContentInPrompt(prompt: PromptInfo) {
  const index = prompt.parts.findIndex((part) => {
    if (part.type !== "text" || !part.source?.text) return false
    const visible = prompt.input.slice(part.source.text.start, part.source.text.end)
    return visible !== part.source.text.value
  })
  const part = prompt.parts[index]
  if (!part || part.type !== "text" || !part.source?.text) return
  return expandPastedContentPartAt(prompt, index, {
    replaceStart: part.source.text.start,
    replaceEnd: part.source.text.end,
  })
}

export function promptSubmitParts(prompt: PromptInfo) {
  const pastedTextParts = prompt.parts.filter(
    (part): part is PromptTextPart => part.type === "text" && Boolean(part.text),
  )
  const nonTextParts = prompt.parts.filter((part) => part.type !== "text")
  const parts: PromptInfo["parts"] = []

  if (prompt.input.length > 0) {
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
