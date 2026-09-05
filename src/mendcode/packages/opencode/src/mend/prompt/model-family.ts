/** Behavioral aliases never rewrite the provider's actual request model. */
export function normalizedPromptModel(modelID: string) {
  return modelID.trim().toLowerCase().replace(/^openai\//, "").replace(/-(fast|pro)$/, "")
}

export function isAstraModel(modelID: string) {
  return /^gpt[-_.:]?6[-_.:]?astra$/.test(normalizedPromptModel(modelID))
}

export const ASTRA_PROMPT_SOURCE = {
  revision: "mendcode-astra-2026-09-04.1",
  url: "https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra",
  verifiedAt: "2026-09-04",
} as const

/** Responses request contract shared by API and OAuth; no private headers. */
export function normalizeAstraRequest(request: Record<string, unknown>) {
  if (typeof request.model !== "string" || !isAstraModel(request.model)) return request
  const result = { ...request }
  for (const key of ["temperature", "top_p", "top_logprobs", "logprobs"]) delete result[key]
  if (Array.isArray(result.include)) result.include = result.include.filter((item) => item !== "message.output_text.logprobs")
  if (result.reasoning && typeof result.reasoning === "object" && !Array.isArray(result.reasoning)) {
    const reasoning = result.reasoning as Record<string, unknown>
    if (reasoning.effort === "none" || reasoning.effort === "minimal") result.reasoning = { ...reasoning, effort: "low" }
  }
  return result
}

export function normalizeAstraOptions(modelID: string, options: Record<string, any>) {
  if (!isAstraModel(modelID)) return options
  const result = { ...options }
  for (const key of ["temperature", "topP", "top_p", "topLogprobs", "top_logprobs", "logprobs"]) delete result[key]
  if (result.reasoningEffort === "none" || result.reasoningEffort === "minimal") result.reasoningEffort = "low"
  if (Array.isArray(result.include)) result.include = result.include.filter((item: unknown) => item !== "message.output_text.logprobs")
  if (result.reasoning?.effort === "none" || result.reasoning?.effort === "minimal") result.reasoning = { ...result.reasoning, effort: "low" }
  return result
}
