import type { ModelMessage } from "ai"

import { convertToOpenAIResponsesInput } from "@/provider/sdk/copilot/responses/convert-to-openai-responses-input"

export const NATIVE_CONTEXT_MARKER_PREFIX = "mendcode-native-context-v1:"

export type NativeContextResult = {
  inputItems: unknown[]
  warnings: string[]
}

/**
 * Convert the already normalized MendCode model prompt to the Responses item
 * shape used by standalone compaction. The converter is shared with the
 * Responses provider so tool-call pairing and image/file rejection have one
 * source of truth. No provider-specific ID or opaque item is rewritten here.
 */
export async function toNativeContext(messages: ModelMessage[]): Promise<NativeContextResult> {
  const converted = await convertToOpenAIResponsesInput({
    prompt: messages as never,
    systemMessageMode: "developer",
    store: false,
  })
  return {
    inputItems: converted.input,
    warnings: converted.warnings.map((warning) => {
      if (warning.type === "other") return warning.message
      return warning.details ? `${warning.feature}: ${warning.details}` : warning.feature
    }),
  }
}

export function appendNativeDeltas(canonicalOutput: readonly unknown[], deltas: readonly unknown[]) {
  return [...canonicalOutput, ...deltas]
}

/**
 * The AI SDK has no public ModelMessage variant for an opaque Responses item
 * such as `compaction`. Carry the private window through one request-local
 * text marker; the OpenAI transport expands and removes it immediately before
 * dispatch. Other providers never receive this marker because it is created
 * only after native capability selection.
 */
export function nativeContextMarker(items: readonly unknown[]) {
  return `${NATIVE_CONTEXT_MARKER_PREFIX}${Buffer.from(JSON.stringify(items)).toString("base64url")}`
}

function decodeMarker(text: string) {
  if (!text.startsWith(NATIVE_CONTEXT_MARKER_PREFIX)) return undefined
  try {
    const parsed = JSON.parse(Buffer.from(text.slice(NATIVE_CONTEXT_MARKER_PREFIX.length), "base64url").toString("utf8"))
    if (!Array.isArray(parsed) || parsed.some((item) => !item || typeof item !== "object" || Array.isArray(item))) {
      throw new Error("Native context marker must contain Responses items")
    }
    return parsed
  } catch (error) {
    throw new Error(`Invalid native context marker: ${String(error)}`)
  }
}

function markerText(item: unknown) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return undefined
  const value = item as Record<string, unknown>
  if (value.type !== "message" && value.role !== "user") return undefined
  if (!Array.isArray(value.content)) return undefined
  const text = value.content.find(
    (part) =>
      part &&
      typeof part === "object" &&
      !Array.isArray(part) &&
      (part as Record<string, unknown>).type === "input_text" &&
      typeof (part as Record<string, unknown>).text === "string",
  ) as Record<string, unknown> | undefined
  return typeof text?.text === "string" ? text.text : undefined
}

/**
 * Expand the marker in a serialized Responses request and report whether the
 * request must retain provider item IDs. The caller owns the returned string;
 * no process-global checkpoint is consulted.
 */
export function expandNativeContextMarker(body: string) {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return { body, expanded: false }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { body, expanded: false }
  const request = parsed as Record<string, unknown>
  if (!Array.isArray(request.input)) return { body, expanded: false }
  const index = request.input.findIndex((item) => markerText(item)?.startsWith(NATIVE_CONTEXT_MARKER_PREFIX))
  if (index === -1) return { body, expanded: false }
  const marker = markerText(request.input[index])
  if (!marker) return { body, expanded: false }
  const items = decodeMarker(marker)
  if (!items) return { body, expanded: false }
  request.input.splice(index, 1, ...items)
  return { body: JSON.stringify(request), expanded: true }
}
