import { existsSync } from "fs"
import { chmod, readFile, writeFile } from "fs/promises"
import { spawnSync } from "child_process"
import path from "path"
import { mendPaths } from "../config/paths"
import { providerAuthPreset, providerEnvRequirements } from "./readiness"
import { budgetEnforcementStatus } from "./budget"
import { providerAuthStateFile, readProviderAuthState } from "./auth-state"

const MEND_VERSION = "0.2.0-phase2"

const genericAiSdkPackages: Record<string, { factory: string }> = {
  "@ai-sdk/anthropic": { factory: "createAnthropic" },
  "@ai-sdk/google": { factory: "createGoogleGenerativeAI" },
  "@ai-sdk/mistral": { factory: "createMistral" },
  "@ai-sdk/groq": { factory: "createGroq" },
  "@ai-sdk/xai": { factory: "createXai" },
  "@ai-sdk/cohere": { factory: "createCohere" },
  "@ai-sdk/perplexity": { factory: "createPerplexity" },
  "@openrouter/ai-sdk-provider": { factory: "createOpenRouter" },
}

async function readJsonIfExists(file: string, fallback: any) {
  if (!existsSync(file)) return fallback
  return JSON.parse(await readFile(file, "utf8"))
}

async function writePrivateJson(file: string, data: any) {
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 })
  await chmod(file, 0o600)
}

function enginePackage(root: string) {
  return path.join(root, ".agents", "vendor", "opencode", "packages", "opencode")
}

async function providerCatalog(root: string) {
  return readJsonIfExists(path.join(enginePackage(root), "test", "tool", "fixtures", "models-api.json"), {})
}

function openaiOAuthClientID() {
  const value = process.env.MENDCODE_OPENAI_OAUTH_CLIENT_ID || process.env.OPENAI_OAUTH_CLIENT_ID
  if (!value) throw new Error("MENDCODE_OPENAI_OAUTH_CLIENT_ID is required for ChatGPT subscription OAuth. Do not hardcode OAuth app ids.")
  return value
}

function openaiOAuthIssuer() {
  return process.env.MENDCODE_OPENAI_OAUTH_ISSUER || process.env.OPENAI_OAUTH_ISSUER || "https://auth.openai.com"
}

function openaiCodexResponsesEndpoint() {
  return process.env.MENDCODE_OPENAI_CODEX_RESPONSES_ENDPOINT || process.env.OPENAI_CODEX_RESPONSES_ENDPOINT || "https://chatgpt.com/backend-api/codex/responses"
}

function openaiApiResponsesEndpoint() {
  return process.env.MENDCODE_OPENAI_API_RESPONSES_ENDPOINT || process.env.OPENAI_API_RESPONSES_ENDPOINT || "https://api.openai.com/v1/responses"
}

async function refreshOpenAIToken(refreshToken: string) {
  const response = await fetch(`${openaiOAuthIssuer()}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: openaiOAuthClientID(),
    }).toString(),
  })
  if (!response.ok) throw new Error(`OpenAI OAuth token refresh failed: ${response.status}`)
  return response.json()
}

function parseJwtClaims(token: string) {
  const parts = String(token || "").split(".")
  if (parts.length !== 3) return null
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString())
  } catch {
    return null
  }
}

function extractOpenAIAccountId(tokens: any) {
  const claims = parseJwtClaims(tokens.id_token) || parseJwtClaims(tokens.access_token) || {}
  return claims.chatgpt_account_id || claims["https://api.openai.com/auth"]?.chatgpt_account_id || claims.organizations?.[0]?.id || null
}

async function ensureFreshOpenAIAuthState(root: string) {
  const file = providerAuthStateFile(root, "openai")
  const state = await readProviderAuthState(root, "openai")
  if (!state?.refresh || !state?.access) return null
  if (typeof state.expires === "number" && state.expires > Date.now() + 30_000) return state
  const tokens = await refreshOpenAIToken(state.refresh)
  const refreshed = {
    ...state,
    access: tokens.access_token,
    refresh: tokens.refresh_token || state.refresh,
    expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
    accountId: extractOpenAIAccountId(tokens) || state.accountId,
    refreshedAt: new Date().toISOString(),
  }
  await writePrivateJson(file, refreshed)
  return refreshed
}

function normalizeUsage(rawUsage: any) {
  if (!rawUsage) {
    return { available: false, raw: null, inputTokens: null, cachedInputTokens: null, outputTokens: null, reasoningTokens: null, totalTokens: null }
  }
  const inputTokens = rawUsage.input_tokens ?? rawUsage.promptTokens ?? rawUsage.inputTokens ?? rawUsage.prompt_tokens ?? null
  const cachedInputTokens = rawUsage.input_tokens_details?.cached_tokens ?? rawUsage.cachedInputTokens ?? rawUsage.cached_input_tokens ?? null
  const outputTokens = rawUsage.output_tokens ?? rawUsage.completionTokens ?? rawUsage.outputTokens ?? rawUsage.completion_tokens ?? null
  const reasoningTokens = rawUsage.output_tokens_details?.reasoning_tokens ?? rawUsage.reasoningTokens ?? rawUsage.reasoning_tokens ?? null
  const totalTokens = rawUsage.total_tokens ?? rawUsage.totalTokens ?? (typeof inputTokens === "number" && typeof outputTokens === "number" ? inputTokens + outputTokens : null)
  return { available: true, raw: rawUsage, inputTokens, cachedInputTokens, outputTokens, reasoningTokens, totalTokens }
}

function estimateRunCost(input: { providerID?: string | null; modelID?: string | null; usage: any; authMode?: string | null }) {
  const preset = providerAuthPreset(input.providerID, input.modelID, input.authMode)
  const pricing = preset?.pricingPer1MTokens || null
  const resolvedAuthMode = preset?.authMode || input.authMode || "unknown"
  const normalized = normalizeUsage(input.usage)
  if (!normalized.available) {
    return { available: false, billingMode: resolvedAuthMode, estimatedUsd: null, reason: "usage unavailable from provider response", pricingSource: preset?.source || null }
  }
  if (!pricing) {
    return {
      available: false,
      billingMode: resolvedAuthMode,
      estimatedUsd: null,
      reason: resolvedAuthMode === "chatgpt-subscription-oauth" ? "subscription OAuth run; API per-token billing does not apply" : "pricing unavailable for selected preset",
      pricingSource: preset?.source || null,
    }
  }
  const inputTokens = normalized.inputTokens || 0
  const cachedInputTokens = normalized.cachedInputTokens || 0
  const billableInputTokens = Math.max(inputTokens - cachedInputTokens, 0)
  const outputTokens = normalized.outputTokens || 0
  return {
    available: true,
    billingMode: resolvedAuthMode,
    estimatedUsd: (billableInputTokens / 1_000_000) * pricing.inputUsd + (cachedInputTokens / 1_000_000) * (pricing.cachedInputUsd || pricing.inputUsd) + (outputTokens / 1_000_000) * pricing.outputUsd,
    pricingPer1MTokens: pricing,
    pricingSource: preset?.source || null,
    usageNormalized: {
      inputTokens: normalized.inputTokens,
      cachedInputTokens: normalized.cachedInputTokens,
      outputTokens: normalized.outputTokens,
      reasoningTokens: normalized.reasoningTokens,
      totalTokens: normalized.totalTokens,
    },
  }
}

function extractResponseText(payload: any) {
  if (typeof payload?.output_text === "string") return payload.output_text
  const parts: string[] = []
  for (const item of payload?.output || []) {
    for (const content of item?.content || []) {
      if (typeof content?.text === "string") parts.push(content.text)
      if (typeof content?.value === "string") parts.push(content.value)
    }
  }
  if (parts.length) return parts.join("\n")
  if (typeof payload?.message?.content === "string") return payload.message.content
  return null
}

function parseSsePayloads(text: string) {
  const payloads: any[] = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue
    const data = line.slice(5).trim()
    if (!data || data === "[DONE]") continue
    try {
      payloads.push(JSON.parse(data))
    } catch {}
  }
  return payloads
}

function extractSseText(payloads: any[]) {
  return payloads.filter((payload) => payload?.type === "response.output_text.delta" && typeof payload?.delta === "string").map((payload) => payload.delta).join("")
}

function extractSseUsage(payloads: any[]) {
  for (const payload of [...payloads].reverse()) {
    const usage = payload?.usage || payload?.response?.usage
    if (usage) return usage
  }
  return null
}

function responseRequestBody(input: { modelID: string; prompt?: string; messages?: any[]; instructions?: string }) {
  return {
    model: input.modelID,
    instructions: input.instructions,
    input: [{ role: "user", content: [{ type: "input_text", text: input.prompt || (input.messages || []).map((message) => `${message.role.toUpperCase()}: ${message.content}`).join("\n\n") }] }],
    stream: true,
    store: false,
  }
}

function parseResponsesResult(input: { providerID: string; modelID: string; authMode?: string | null; response: Response; text: string; elapsedMs: number }) {
  let payload: any = null
  try {
    payload = input.text ? JSON.parse(input.text) : null
  } catch {}
  if (!input.response.ok) {
    return {
      ok: false,
      status: input.response.status,
      statusText: input.response.statusText,
      errorPreview: input.text.slice(0, 500),
      telemetry: { elapsedMs: input.elapsedMs, usage: null, cost: estimateRunCost({ providerID: input.providerID, modelID: input.modelID, authMode: input.authMode, usage: null }) },
    }
  }
  const ssePayloads = parseSsePayloads(input.text)
  const usage = ssePayloads.length ? extractSseUsage(ssePayloads) : payload?.usage || null
  const usageNormalized = normalizeUsage(usage)
  return {
    ok: true,
    status: input.response.status,
    id: payload?.id || null,
    model: payload?.model || input.modelID,
    outputText: (ssePayloads.length ? extractSseText(ssePayloads) : null) || extractResponseText(payload),
    rawShape: payload ? { keys: Object.keys(payload).sort(), outputItems: Array.isArray(payload.output) ? payload.output.length : null } : ssePayloads.length ? { sseEvents: ssePayloads.length, firstEventKeys: Object.keys(ssePayloads[0] || {}).sort() } : null,
    telemetry: {
      elapsedMs: input.elapsedMs,
      usage,
      usageNormalized,
      cost: estimateRunCost({ providerID: input.providerID, modelID: input.modelID, authMode: input.authMode, usage }),
      stream: { enabled: true, events: ssePayloads.length },
    },
  }
}

async function runOpenAISubscriptionPrompt(root: string, input: any) {
  const auth = await ensureFreshOpenAIAuthState(root)
  if (!auth) throw new Error("OpenAI OAuth state missing. Run `mendcode auth login openai --method browser --execute` first.")
  const startedAt = Date.now()
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${auth.access}`,
    originator: "mendcode",
    "User-Agent": `mendcode/${MEND_VERSION} (${process.platform}; ${process.arch})`,
    session_id: `mend-${Date.now()}`,
  }
  if (auth.accountId) headers["ChatGPT-Account-Id"] = auth.accountId
  const response = await fetch(openaiCodexResponsesEndpoint(), { method: "POST", headers, body: JSON.stringify(responseRequestBody(input)) })
  return parseResponsesResult({ ...input, authMode: "chatgpt-subscription-oauth", response, text: await response.text(), elapsedMs: Date.now() - startedAt })
}

async function runOpenAIAPIKeyPrompt(input: any) {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error("OPENAI_API_KEY is required for OpenAI API-key runs.")
  const startedAt = Date.now()
  const response = await fetch(openaiApiResponsesEndpoint(), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, "User-Agent": `mendcode/${MEND_VERSION} (${process.platform}; ${process.arch})` },
    body: JSON.stringify(responseRequestBody(input)),
  })
  return parseResponsesResult({ ...input, authMode: "api-key", response, text: await response.text(), elapsedMs: Date.now() - startedAt })
}

function genericAiSdkRunnerCode() {
  return `
import { generateText } from "ai"
import { createAnthropic } from "@ai-sdk/anthropic"
import { createGoogleGenerativeAI } from "@ai-sdk/google"
import { createMistral } from "@ai-sdk/mistral"
import { createGroq } from "@ai-sdk/groq"
import { createXai } from "@ai-sdk/xai"
import { createCohere } from "@ai-sdk/cohere"
import { createPerplexity } from "@ai-sdk/perplexity"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
const factories = { "@ai-sdk/anthropic": createAnthropic, "@ai-sdk/google": createGoogleGenerativeAI, "@ai-sdk/mistral": createMistral, "@ai-sdk/groq": createGroq, "@ai-sdk/xai": createXai, "@ai-sdk/cohere": createCohere, "@ai-sdk/perplexity": createPerplexity, "@openrouter/ai-sdk-provider": createOpenRouter }
const input = JSON.parse(await new Response(Bun.stdin.stream()).text())
const factory = factories[input.npm]
if (!factory) throw new Error("Unsupported AI SDK package: " + input.npm)
const apiKey = process.env[input.envKey]
if (!apiKey) throw new Error(input.envKey + " is required")
const provider = factory({ apiKey })
const startedAt = Date.now()
const result = await generateText({ model: provider(input.modelID), system: input.instructions, messages: input.messages || [{ role: "user", content: input.prompt }] })
console.log(JSON.stringify({ ok: true, status: 200, model: input.modelID, outputText: result.text || "", usage: result.usage || null, elapsedMs: Date.now() - startedAt }))
`
}

async function runGenericAiSdkPrompt(root: string, input: any) {
  const catalog = await providerCatalog(root)
  const provider = catalog[input.providerID]
  const envKeys = Array.isArray(provider?.env) ? provider.env : []
  const envKey = envKeys.find((key: string) => Boolean(process.env[key])) || envKeys[0]
  if (!provider?.npm || !genericAiSdkPackages[provider.npm]) throw new Error(`No generic AI SDK adapter for provider: ${input.providerID}`)
  if (!envKey || !process.env[envKey]) throw new Error(`${envKey || "provider API key"} is required for ${input.providerID}`)
  const result = spawnSync("bun", ["-e", genericAiSdkRunnerCode()], { cwd: enginePackage(root), input: JSON.stringify({ ...input, npm: provider.npm, envKey }), encoding: "utf8", env: process.env })
  if (result.status !== 0) {
    return { ok: false, status: result.status || 1, statusText: "AI SDK runner failed", errorPreview: (result.stderr || result.stdout || "").slice(0, 500), telemetry: { elapsedMs: null, usage: null, cost: estimateRunCost({ providerID: input.providerID, modelID: input.modelID, authMode: "api-key", usage: null }) } }
  }
  const payload = JSON.parse(result.stdout)
  const usageNormalized = normalizeUsage(payload.usage)
  return { ok: true, status: payload.status, id: null, model: payload.model || input.modelID, outputText: payload.outputText, rawShape: { runner: "ai-sdk-generate-text", npm: provider.npm }, telemetry: { elapsedMs: payload.elapsedMs, usage: payload.usage, usageNormalized, cost: estimateRunCost({ providerID: input.providerID, modelID: input.modelID, authMode: "api-key", usage: payload.usage }), stream: { enabled: false, events: null } } }
}

export async function runSupportStatus(input: { providerID?: string | null; modelID?: string | null; authMode?: string | null; root?: string }) {
  const root = mendPaths(input.root).root
  const catalog = await providerCatalog(root)
  const provider = input.providerID ? catalog[input.providerID] : null
  const resolvedAuthMode = providerAuthPreset(input.providerID, input.modelID, input.authMode)?.authMode || input.authMode || (providerEnvRequirements(input.providerID, input.modelID, input.authMode).length ? "api-key" : "unknown")
  const implementedProviders = Object.keys(catalog).filter((id) => id === "openai" || Boolean(genericAiSdkPackages[catalog[id]?.npm])).sort()
  if (!input.providerID || !implementedProviders.includes(input.providerID)) return { supported: false, authMode: resolvedAuthMode, reason: `no MendCode run adapter registered for provider: ${input.providerID || "none"}`, catalogProviderCount: Object.keys(catalog).length, implementedProviders }
  const implementedAuthModes = input.providerID === "openai" ? ["chatgpt-subscription-oauth", "api-key"] : ["api-key"]
  if (!implementedAuthModes.includes(resolvedAuthMode)) return { supported: false, authMode: resolvedAuthMode, reason: `provider adapter registered but auth mode is not implemented: ${resolvedAuthMode}`, catalogProviderCount: Object.keys(catalog).length, implementedProviders, implementedAuthModes }
  return { supported: true, authMode: resolvedAuthMode, catalogProviderCount: Object.keys(catalog).length, implementedProviders, implementedAuthModes }
}

export async function runProviderAdapter(root: string, input: { providerID: string; modelID: string; authMode: string; prompt?: string; messages?: any[]; instructions?: string }) {
  if (input.providerID === "openai") {
    if (input.authMode === "api-key") return runOpenAIAPIKeyPrompt(input)
    return runOpenAISubscriptionPrompt(root, input)
  }
  return runGenericAiSdkPrompt(root, input)
}

export async function providerRunAdapterInventory(root?: string) {
  const paths = mendPaths(root)
  const catalog = await providerCatalog(paths.root)
  const providers = Object.fromEntries(
    Object.entries(catalog)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([providerID, provider]: [string, any]) => {
        const adapterRegistered = providerID === "openai" || Boolean(genericAiSdkPackages[provider?.npm])
        const implementedAuthModes = providerID === "openai" ? ["chatgpt-subscription-oauth", "api-key"] : adapterRegistered ? ["api-key"] : []
        const env = Array.isArray(provider.env) ? provider.env : []
        return [
          providerID,
          {
            label: provider.name || providerID,
            npm: provider.npm || null,
            api: provider.api || null,
            requiredEnv: env,
            modelCount: provider.models ? Object.keys(provider.models).length : 0,
            adapterRegistered,
            adapterKind: providerID === "openai" ? "openai-responses" : adapterRegistered ? "generic-ai-sdk-generate-text" : "not-implemented",
            implementedAuthModes,
            canRunWithCurrentCore: adapterRegistered,
          },
        ]
      }),
  )
  return {
    source: ".agents/vendor/opencode/packages/opencode/test/tool/fixtures/models-api.json",
    providerCount: Object.keys(providers).length,
    implementedProviderCount: Object.values(providers).filter((provider: any) => provider.adapterRegistered).length,
    providers,
    note: "MendCode maps the full pinned donor provider catalog now, but run execution is enabled only where a provider adapter is registered and auth mode matches. Unsupported providers fail through this registry, not scattered hardcoded checks.",
  }
}

function parseOption(args: string[], name: string) {
  const index = args.indexOf(name)
  if (index === -1) return null
  const value = args[index + 1]
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`)
  return value
}

async function defaultSmokeModelID(root: string, providerID: string, explicitModelID?: string | null) {
  if (explicitModelID) return explicitModelID
  if (providerID === "openai") return "gpt-5.2"
  const models = (await providerCatalog(root))[providerID]?.models || {}
  return Object.keys(models)[0] || null
}

export async function providerSmoke(args: string[], root?: string) {
  const paths = mendPaths(root)
  const execute = args.includes("--execute")
  const onlyProviderID = parseOption(args, "--provider")
  const explicitModelID = parseOption(args, "--model")
  const inventory = await providerRunAdapterInventory(paths.root)
  const providerIDs = Object.keys(inventory.providers).filter((providerID) => {
    const provider = (inventory.providers as any)[providerID]
    return provider.adapterRegistered && (!onlyProviderID || providerID === onlyProviderID)
  })
  if (onlyProviderID && !providerIDs.length) throw new Error(`No registered MendCode adapter for provider: ${onlyProviderID}`)
  const results = []
  for (const providerID of providerIDs) {
    const provider = (inventory.providers as any)[providerID]
    const envKeys = provider.requiredEnv || []
    const presentEnv = envKeys.filter((key: string) => Boolean(process.env[key]))
    const modelID = await defaultSmokeModelID(paths.root, providerID, explicitModelID)
    const authMode = providerID === "openai" && presentEnv.includes("OPENAI_API_KEY") ? "api-key" : provider.implementedAuthModes.includes("api-key") ? "api-key" : provider.implementedAuthModes[0] || "unknown"
    const support = await runSupportStatus({ providerID, modelID, authMode, root: paths.root })
    const budgetGate = await budgetEnforcementStatus({ providerID, modelID, authMode }, paths.root)
    const ready = Boolean(modelID && support.supported && budgetGate.blockers.length === 0 && (authMode === "api-key" ? presentEnv.length > 0 : false))
    const base = {
      providerID,
      modelID,
      adapterKind: provider.adapterKind,
      authMode,
      requiredEnv: envKeys,
      presentEnv,
      missingEnv: envKeys.filter((key: string) => !process.env[key]),
      ready,
      budgetGate,
      wouldCallProvider: execute && ready,
      secretsPrinted: false,
    }
    if (!execute || !ready) {
      results.push({
        ...base,
        status: ready ? "ready-not-executed" : "skipped",
        reason: ready ? "pass --execute to run the smoke test" : base.missingEnv.length ? "missing required env" : support.supported ? "not executable without API-key env" : support.reason,
      })
      continue
    }
    const result = await runProviderAdapter(paths.root, {
      providerID,
      authMode,
      modelID,
      prompt: "responde solo: ok",
      instructions: "You are MendCode provider smoke test. Respond with exactly: ok",
    })
    results.push({
      ...base,
      status: result.ok ? "ok" : "failed",
      ok: result.ok,
      httpStatus: result.status,
      outputPreview: (result.outputText || "").slice(0, 80),
      telemetry: result.telemetry ? { elapsedMs: result.telemetry.elapsedMs, usageNormalized: result.telemetry.usageNormalized, cost: result.telemetry.cost } : null,
    })
  }
  const summary = {
    mode: execute ? "execute" : "dry-run",
    providerFilter: onlyProviderID,
    modelOverride: explicitModelID,
    adapterCount: providerIDs.length,
    readyCount: results.filter((result: any) => result.ready).length,
    executedCount: results.filter((result: any) => result.wouldCallProvider).length,
    okCount: results.filter((result: any) => result.ok).length,
    secretsPrinted: false,
    note: execute ? "Executed only adapters with required env present and no budget stop blocker." : "Dry-run only; no provider APIs were called.",
    results,
  }
  return summary
}
