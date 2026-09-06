import { createHash } from "node:crypto"
import { Token } from "@/util/token"

export type ContextProfile = {
  version: 1
  estimatedTokens: {
    instructions: number
    memory: number
    history: number
    toolResults: number
    toolSchemas: number
    media: number
    total: number
  }
  toolCount: number
  imageCount: number
  fileCount: number
  instructionsFingerprint: string
  toolsFingerprint: string
  durationMs?: number
  firstTokenMs?: number | null
  usageReported?: { input: boolean; cacheRead: boolean; cacheWrite: boolean }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value) ?? "").digest("hex")

/** Composition estimates, never a replacement for provider usage or billing. No prompt content is retained. */
export function profileContext(input: { prompt: unknown; tools?: unknown; instructions?: unknown }): ContextProfile {
  const estimatedTokens = { instructions: 0, memory: 0, history: 0, toolResults: 0, toolSchemas: 0, media: 0, total: 0 }
  let imageCount = 0
  let fileCount = 0
  const instructions: unknown[] = []
  const text = (value: string, category: "instructions" | "history" | "toolResults") => {
    const remainder = value.replace(/<(mendcode_memory(?:_context)?)>[\s\S]*?<\/\1>/g, (memory) => {
      estimatedTokens.memory += Token.estimate(memory)
      return ""
    })
    estimatedTokens[category] += Token.estimate(remainder)
  }
  const content = (value: unknown, category: "instructions" | "history" | "toolResults", depth = 0): void => {
    if (depth > 24) return
    if (typeof value === "string") {
      text(value, category)
      return
    }
    if (Array.isArray(value)) {
      for (const part of value) content(part, category, depth + 1)
      return
    }
    if (!record(value)) return
    const mime = String(value.mediaType ?? value.mimeType ?? value.mime ?? "")
    if (value.type === "image" || value.type === "image-data" || value.type === "image-url" || (value.type === "file" && mime.startsWith("image/"))) {
      imageCount++
      // Provider image accounting varies by model, resolution and detail. Keep this visibly estimated.
      estimatedTokens.media += 1500
      return
    }
    if (value.type === "file" || value.type === "file-data" || value.type === "file-url") {
      fileCount++
      estimatedTokens.media += 2000
      return
    }
    if (typeof value.text === "string") text(value.text, category)
    else if (value.type === "tool-call") estimatedTokens.history += Token.estimatePayload({ name: value.toolName, input: value.input })
    else if (value.type === "tool-result") content(value.output, "toolResults", depth + 1)
    else if ("value" in value) {
      if (value.type === "json" || value.type === "error-json") estimatedTokens[category] += Token.estimatePayload(value.value)
      else content(value.value, category, depth + 1)
    }
  }
  if (typeof input.instructions === "string" && input.instructions) {
    instructions.push(input.instructions)
    content(input.instructions, "instructions")
  }
  for (const message of Array.isArray(input.prompt) ? input.prompt : []) {
    if (!record(message)) continue
    const category = message.role === "system" ? "instructions" : message.role === "tool" ? "toolResults" : "history"
    if (category === "instructions") instructions.push(message.content)
    content(message.content, category)
  }
  const tools = Array.isArray(input.tools) ? input.tools : []
  estimatedTokens.toolSchemas = tools.length ? Token.estimatePayload(tools) : 0
  estimatedTokens.total = Object.entries(estimatedTokens).reduce((sum, [key, value]) => sum + (key === "total" ? 0 : value), 0)
  return {
    version: 1,
    estimatedTokens,
    imageCount,
    fileCount,
    toolCount: tools.length,
    instructionsFingerprint: digest(instructions),
    toolsFingerprint: digest(tools),
  }
}

export function contextProfile(value: unknown): ContextProfile | undefined {
  if (!record(value) || value.version !== 1 || !record(value.estimatedTokens)) return
  const tokens = value.estimatedTokens
  const fields = ["instructions", "memory", "history", "toolResults", "toolSchemas", "media", "total"]
  if (!fields.every((key) => typeof tokens[key] === "number" && Number.isFinite(tokens[key]) && tokens[key] >= 0)) return
  return value as ContextProfile
}

export function contextReport(messages: Array<{ info: { id: string; role: string; providerID?: string; modelID?: string }; parts: unknown[] }>) {
  const requests = messages.flatMap((message) => message.parts.flatMap((part) => {
    if (!record(part) || part.type !== "step-finish" || !record(part.metadata)) return []
    const profile = contextProfile(part.metadata.contextProfile)
    if (!profile) return []
    const tokens = record(part.tokens) ? part.tokens : {}
    const cache = record(tokens.cache) ? tokens.cache : {}
    const input = Number(tokens.input ?? 0) + Number(cache.read ?? 0) + Number(cache.write ?? 0)
    return [{
      messageID: message.info.id,
      providerID: message.info.providerID,
      modelID: message.info.modelID,
      profile,
      inputTokens: profile.usageReported?.input === true ? input : null,
      cachedTokens: profile.usageReported?.cacheRead === true ? Number(cache.read ?? 0) : null,
      cacheWriteTokens: profile.usageReported?.cacheWrite === true ? Number(cache.write ?? 0) : null,
      cacheHitRate: profile.usageReported?.input === true && profile.usageReported?.cacheRead === true && input > 0
        ? Number(cache.read ?? 0) / input : null,
      cost: typeof part.cost === "number" ? part.cost : null,
    }]
  }))
  return { version: 1, scope: "recent messages", requests }
}
