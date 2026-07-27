const CHARS_PER_TOKEN = 4
const BASE64_OMIT_THRESHOLD = 1024

function isRecord(input: unknown): input is Record<string, unknown> {
  return !!input && typeof input === "object" && !Array.isArray(input)
}

function looksLikeBase64(input: string) {
  if (input.length < BASE64_OMIT_THRESHOLD) return false
  return /^[A-Za-z0-9+/=_-]+$/.test(input)
}

function binaryByteLength(input: unknown) {
  if (ArrayBuffer.isView(input)) return input.byteLength
  if (input instanceof ArrayBuffer) return input.byteLength
  return undefined
}

function estimateSafePayload(input: unknown, key?: string, depth = 0): unknown {
  if (depth > 20) return "[nested payload omitted]"
  const byteLength = binaryByteLength(input)
  if (byteLength !== undefined) return `[binary ${key ?? "payload"} ${byteLength} bytes omitted for token estimate]`
  if (typeof input === "string") {
    const base64Index = input.indexOf(";base64,")
    if (input.startsWith("data:") && base64Index !== -1) {
      const mediaType = input.slice("data:".length, base64Index) || "media"
      return `[${mediaType} data url omitted for token estimate]`
    }
    if ((key === "data" || key === "file_data" || key === "image_url") && looksLikeBase64(input)) {
      return `[base64 ${key} omitted for token estimate]`
    }
    return input
  }
  if (Array.isArray(input)) return input.map((item) => estimateSafePayload(item, undefined, depth + 1))
  if (!isRecord(input)) return input
  return Object.fromEntries(Object.entries(input).map(([childKey, value]) => [childKey, estimateSafePayload(value, childKey, depth + 1)]))
}

export function estimate(input: string) {
  return Math.max(0, Math.round((input || "").length / CHARS_PER_TOKEN))
}

export function estimatePayload(input: unknown) {
  return estimate(JSON.stringify(estimateSafePayload(input)) ?? "")
}

export * as Token from "./token"
