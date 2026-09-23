import { isAstraModel } from "./model-family"

export type RuntimeCapability = { mode: "native" | "emulated" | "unavailable"; reason: string }

export function resolveRuntimeCapabilities(input: {
  providerID: string
  modelID: string
  endpoint: string
  auth: "api" | "oauth" | "unknown"
  transport: "responses-http" | "responses-websocket" | "other"
  tools: string[]
}) {
  let officialAPI = false
  try {
    const endpoint = new URL(input.endpoint)
    officialAPI = endpoint.protocol === "https:" && endpoint.hostname === "api.openai.com"
  } catch {}
  const nativeReason = input.auth === "oauth"
    ? "Subscription transport support has not been verified independently."
    : !isAstraModel(input.modelID) || input.providerID !== "openai" || !officialAPI || input.auth !== "api"
      ? "This provider, model, endpoint and authentication combination has no verified native adapter."
      : input.transport !== "responses-websocket"
        ? "The current HTTP adapter does not implement native async calls, steering or configuration_update."
        : "A native WebSocket adapter has not passed the required integration checks."
  const tools = new Set(input.tools)
  const capability = (enabled: boolean, reason: string): RuntimeCapability => enabled
    ? { mode: "emulated", reason }
    : { mode: "unavailable", reason: "The corresponding runtime tools are disabled or unavailable." }
  return {
    asyncTools: capability(["tool_start", "tool_status", "tool_wait", "tool_cancel"].every((name) => tools.has(name)), "MendCode owns durable jobs and returns results at a safe loop boundary."),
    asyncQuestions: capability(tools.has("question_async"), "MendCode posts a question and continues independent work."),
    recall: capability(tools.has("session_search") && tools.has("session_read"), "MendCode retrieves linked session history on demand."),
    nativeTransport: { mode: "unavailable", reason: nativeReason } satisfies RuntimeCapability,
  }
}

export function runtimeCapabilityPrompt(input: Parameters<typeof resolveRuntimeCapabilities>[0]) {
  const capabilities = resolveRuntimeCapabilities(input)
  return ["<runtime_capabilities>", ...Object.entries(capabilities).map(([name, value]) => `${name}: ${value.mode}. ${value.reason}`), "</runtime_capabilities>"].join("\n")
}
