function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** Normalize catalog aliases for behavioral matching without changing the wire model ID. */
export function normalizedPromptModel(modelID: string) {
  return modelID
    .trim()
    .toLowerCase()
    .replace(/^openai\//, "")
    .replace(/-(fast|pro)$/, "")
}

export function isAstraModel(modelID: string) {
  return /^gpt[-_.:]?6[-_.:]?astra$/.test(normalizedPromptModel(modelID))
}

/** Remove request controls that Astra does not accept while preserving the selected model. */
export function normalizeAstraRequest(request: Record<string, unknown>) {
  if (typeof request.model !== "string" || !isAstraModel(request.model)) return request

  const result = { ...request }
  for (const key of ["temperature", "top_p", "top_logprobs", "logprobs"]) delete result[key]

  if (Array.isArray(result.include)) {
    result.include = result.include.filter((item) => item !== "message.output_text.logprobs")
  }

  if (isRecord(result.reasoning) && (result.reasoning.effort === "none" || result.reasoning.effort === "minimal")) {
    result.reasoning = { ...result.reasoning, effort: "low" }
  }

  return result
}

/** Apply the same compatibility cleanup to options before an SDK serializes them. */
export function normalizeAstraOptions(modelID: string, options: Record<string, unknown>) {
  if (!isAstraModel(modelID)) return options

  const result = { ...options }
  for (const key of ["temperature", "topP", "top_p", "topLogprobs", "top_logprobs", "logprobs"]) delete result[key]
  if (result.reasoningEffort === "none" || result.reasoningEffort === "minimal") result.reasoningEffort = "low"

  if (Array.isArray(result.include)) {
    result.include = result.include.filter((item) => item !== "message.output_text.logprobs")
  }

  if (isRecord(result.reasoning) && (result.reasoning.effort === "none" || result.reasoning.effort === "minimal")) {
    result.reasoning = { ...result.reasoning, effort: "low" }
  }

  return result
}
