import { expect, test } from "bun:test"
import type { ModelMessage } from "ai"
import { normalizeAstraRequest, normalizeAstraOptions, isAstraModel } from "../../src/mend/prompt/model-family"
import { resolveRuntimeCapabilities } from "../../src/mend/prompt/runtime-capabilities"
import { autoReasoningSignal, selectAutoReasoning } from "../../src/mend/prompt/reasoning-auto"
import { promptBehaviorForModel } from "../../src/mend/prompt/sources"
import { normalizeCodexChatGPTRequestBody } from "../../src/plugin/codex"
import { getReasoningState, recordReasoningState } from "../../src/mend/prompt/reasoning-state"

test("Astra profile aliases preserve official ID and identify the versioned guidance", () => {
  for (const id of ["gpt-6-astra", "openai/gpt-6-astra-fast", "GPT-6-ASTRA"]) {
    expect(isAstraModel(id)).toBe(true)
    expect(promptBehaviorForModel({ focusID: "codex", modelID: id })?.provenance?.revision).toBe("mendcode-astra-2026-09-04.1")
  }
  expect(isAstraModel("gpt-6-something-else")).toBe(false)
  expect(promptBehaviorForModel({ focusID: "claude", modelID: "gpt-6-astra" })).toBeNull()
})

test("Astra API and subscription normalization remove unsupported sampling without enabling async", () => {
  const request = { model: "gpt-6-astra", temperature: 1, top_p: 1, top_logprobs: 2, logprobs: true,
    include: ["message.output_text.logprobs", "reasoning.encrypted_content"], reasoning: { effort: "minimal" },
    tools: [{ type: "function", name: "read", parameters: { type: "object" } }],
  }
  const expected = { model: "gpt-6-astra", include: ["reasoning.encrypted_content"], reasoning: { effort: "low" }, tools: request.tools }
  expect(normalizeAstraRequest(request)).toEqual(expected)
  expect(JSON.parse(normalizeCodexChatGPTRequestBody(JSON.stringify(request)) as string)).toEqual(expected)
  expect(request.temperature).toBe(1)
  expect(normalizeAstraOptions("gpt-6-astra", { reasoningEffort: "minimal", logprobs: true, serviceTier: "default", include: ["message.output_text.logprobs"] })).toEqual({ reasoningEffort: "low", serviceTier: "default", include: [] })
  expect(normalizeAstraRequest({ model: "gpt-5.5", temperature: 1 })).toEqual({ model: "gpt-5.5", temperature: 1 })
})

test("native support stays unavailable separately for API, OAuth and gateways", () => {
  const base = { providerID: "openai", modelID: "gpt-6-astra", endpoint: "https://api.openai.com/v1", auth: "api" as const,
    transport: "responses-http" as const, tools: ["tool_start", "tool_status", "tool_wait", "tool_cancel", "question_async", "session_search", "session_read"] }
  expect(resolveRuntimeCapabilities(base).asyncTools.mode).toBe("emulated")
  expect(resolveRuntimeCapabilities(base).nativeTransport.mode).toBe("unavailable")
  expect(resolveRuntimeCapabilities({ ...base, auth: "oauth" }).nativeTransport.reason).toContain("Subscription")
  expect(resolveRuntimeCapabilities({ ...base, endpoint: "https://api.openai.com.invalid/v1" }).nativeTransport.reason).toContain("combination")
  expect(resolveRuntimeCapabilities({ ...base, tools: [] }).asyncTools.mode).toBe("unavailable")
})

const variants = { low: { reasoningEffort: "low" }, medium: { reasoningEffort: "medium" }, high: { reasoningEffort: "high" }, max: { reasoningEffort: "max" } }
test("balanced Auto is optional, supported-only, capped and subordinate to manual", () => {
  expect(selectAutoReasoning({ enabled: false, variants })).toBeUndefined()
  expect(selectAutoReasoning({ enabled: true, manual: "low", signal: "verification_failed", variants })).toBeUndefined()
  expect(selectAutoReasoning({ enabled: true, variants })?.effort).toBe("medium")
  expect(selectAutoReasoning({ enabled: true, signal: "technical_block", variants })?.effort).toBe("high")
  expect(selectAutoReasoning({ enabled: true, signal: "technical_block", variants: { max: {} } })).toBeUndefined()
  expect(selectAutoReasoning({ enabled: true, variants: { low: {} } })?.effort).toBe("low")
})

test("Auto consumes only its explicit result from the current turn", () => {
  const result = (toolName: string, value: string): ModelMessage => ({ role: "tool", content: [{ type: "tool-result", toolCallId: "c1", toolName, output: { type: "text", value } }] })
  const signal = result("reasoning_auto", JSON.stringify({ signal: "verification_failed" }))
  expect(autoReasoningSignal([{ role: "user", content: "fix" }, signal])).toBe("verification_failed")
  expect(autoReasoningSignal([signal, { role: "user", content: "new turn" }])).toBeUndefined()
  expect(autoReasoningSignal([result("bash", JSON.stringify({ signal: "technical_block" }))])).toBeUndefined()
  expect(autoReasoningSignal([result("reasoning_auto", JSON.stringify({ signal: "network_failed" }))])).toBeUndefined()
  expect(autoReasoningSignal([result("reasoning_auto", "invalid")])).toBeUndefined()
})

test("last-request reasoning state is copied, bounded and unknown before a request", () => {
  expect(getReasoningState("unseen-session")).toBeUndefined()
  const state = { sessionID: "state-0", messageID: "user1", mode: "auto" as const, effort: "medium", reason: "balanced_initial", modelID: "gpt-6-astra", providerID: "openai", requestedAt: 1 }
  recordReasoningState(state)
  state.effort = "high"
  expect(getReasoningState("state-0")?.effort).toBe("medium")
  for (let i = 1; i <= 128; i++) recordReasoningState({ ...state, sessionID: `state-${i}` })
  expect(getReasoningState("state-0")).toBeUndefined()
  expect(getReasoningState("state-128")?.effort).toBe("high")
})
