import { existsSync } from "fs"
import { mkdir, readFile, writeFile } from "fs/promises"
import path from "path"
import { mendPaths } from "../config/paths"
import { packageMetadata } from "../config/project"
import { modelPresets, resolveModelRoles } from "../config/models"
import { memoryStatus } from "../memory/store"
import { providerAuthStateFile, readProviderAuthState } from "./auth-state"

const authInventory = {
  openai: {
    label: "OpenAI",
    authModes: ["ChatGPT Pro/Plus browser OAuth", "ChatGPT Pro/Plus headless/device OAuth", "API key"],
    subscriptionLike: true,
    apiKeyFallback: true,
    evidence: ".agents/vendor/opencode/packages/opencode/src/plugin/codex.ts",
  },
  "github-copilot": {
    label: "GitHub Copilot",
    authModes: ["GitHub Copilot OAuth/device flow"],
    subscriptionLike: true,
    apiKeyFallback: false,
    evidence: ".agents/vendor/opencode/packages/opencode/src/plugin/github-copilot/copilot.ts",
  },
  anthropic: { label: "Anthropic/Claude", authModes: ["API key via provider env/auth"], subscriptionLike: false, apiKeyFallback: true, evidence: "models.dev provider env metadata" },
  google: { label: "Google/Gemini", authModes: ["API key or provider-specific Google auth/env"], subscriptionLike: false, apiKeyFallback: true, evidence: "models.dev provider env metadata" },
  openrouter: { label: "OpenRouter", authModes: ["API key"], subscriptionLike: false, apiKeyFallback: true, evidence: "models.dev provider env metadata" },
} as const

async function readJsonIfExists(file: string, fallback: any) {
  if (!existsSync(file)) return fallback
  return JSON.parse(await readFile(file, "utf8"))
}

export function providerAuthPreset(providerID?: string | null, modelID?: string | null, authMode?: string | null) {
  const presets = Object.values(modelPresets).filter((preset) => preset.providerID === providerID && preset.modelID === modelID)
  if (authMode) return presets.find((preset) => preset.authMode === authMode) || null
  return presets[0] || null
}

export function providerEnvRequirements(providerID?: string | null, modelID?: string | null, authMode?: string | null) {
  if (!providerID) return []
  const presetEnv = providerAuthPreset(providerID, modelID, authMode)?.env
  if (presetEnv) return [...presetEnv]
  const common: Record<string, string[]> = {
    anthropic: ["ANTHROPIC_API_KEY"],
    openai: ["OPENAI_API_KEY"],
    "openai-compatible": ["OPENAI_API_KEY"],
    google: ["GOOGLE_GENERATIVE_AI_API_KEY"],
    "google-vertex": ["GOOGLE_VERTEX_PROJECT", "GOOGLE_VERTEX_LOCATION"],
    mistral: ["MISTRAL_API_KEY"],
    openrouter: ["OPENROUTER_API_KEY"],
    xai: ["XAI_API_KEY"],
    groq: ["GROQ_API_KEY"],
    cohere: ["COHERE_API_KEY"],
    perplexity: ["PERPLEXITY_API_KEY"],
    "amazon-bedrock": ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_REGION"],
  }
  return common[providerID] || []
}

function redactedAuthSummary(state: any, root: string, providerID: string) {
  if (!state) return { providerID, type: null, present: false, path: path.relative(root, providerAuthStateFile(root, providerID)) }
  return {
    providerID,
    type: state.type || null,
    accountIdPresent: Boolean(state.accountId),
    accessTokenPresent: Boolean(state.access),
    refreshTokenPresent: Boolean(state.refresh),
    expires: state.expires || null,
    expired: typeof state.expires === "number" ? state.expires <= Date.now() : null,
    source: state.source || null,
    path: path.relative(root, providerAuthStateFile(root, providerID)),
  }
}

function openAIOAuthClientIDPresent() {
  return Boolean(process.env.MENDCODE_OPENAI_OAUTH_CLIENT_ID || process.env.OPENAI_OAUTH_CLIENT_ID)
}

export function oauthStateUsableForRun(providerID: string | null | undefined, state: any) {
  if (!state || state.type !== "oauth" || !state.refresh || !state.access) {
    return { ready: false, expired: null as boolean | null, refreshReady: false }
  }
  const expired = typeof state.expires === "number" ? state.expires <= Date.now() : false
  const refreshReady = providerID === "openai" ? openAIOAuthClientIDPresent() : true
  return { ready: !expired || refreshReady, expired, refreshReady }
}

export function providerAuthInventory() {
  return {
    sourceFiles: [
      ".agents/vendor/opencode/packages/opencode/src/plugin/index.ts",
      ".agents/vendor/opencode/packages/opencode/src/plugin/codex.ts",
      ".agents/vendor/opencode/packages/opencode/src/plugin/github-copilot/copilot.ts",
      ".agents/vendor/opencode/packages/opencode/src/cli/cmd/providers.ts",
    ],
    builtInAuthPlugins: ["CodexAuthPlugin", "CopilotAuthPlugin", "GitlabAuthPlugin", "PoeAuthPlugin", "CloudflareWorkersAuthPlugin", "AzureAuthPlugin"],
    providers: authInventory,
    caveat: "This is donor-source evidence for built-in auth. External plugins can add more provider auth methods at runtime.",
  }
}

export async function providerAuthStatus(providerID?: string | null, modelID?: string | null, input: { authMode?: string | null; skipNext?: boolean } = {}, root?: string) {
  const paths = mendPaths(root)
  const resolved = await resolveModelRoles(paths.root)
  const selectedProviderID = providerID || (resolved.roles.default as any)?.providerID || null
  const selectedModelID = modelID || (selectedProviderID === (resolved.roles.default as any)?.providerID ? (resolved.roles.default as any)?.modelID || null : null)
  const selectedAuthMode = input.authMode || (selectedProviderID === (resolved.roles.default as any)?.providerID ? (resolved.roles.default as any)?.authMode || null : null)
  const authPreset = providerAuthPreset(selectedProviderID, selectedModelID, selectedAuthMode)
  const record = selectedProviderID ? (authInventory as any)[selectedProviderID] : null
  const requiredEnv = selectedModelID ? providerEnvRequirements(selectedProviderID, selectedModelID, selectedAuthMode) : record?.subscriptionLike ? [] : providerEnvRequirements(selectedProviderID, selectedModelID, selectedAuthMode)
  const isOAuthPreset = authPreset?.authMode === "chatgpt-subscription-oauth"
  const acceptsEitherOAuthOrToken = Boolean(record?.subscriptionLike === true && !isOAuthPreset && requiredEnv.length > 0)
  const requiresOAuthBridge = isOAuthPreset || (record?.subscriptionLike === true && requiredEnv.length === 0)
  const authState = selectedProviderID ? await readProviderAuthState(paths.root, selectedProviderID) : null
  const oauth = oauthStateUsableForRun(selectedProviderID, authState)
  const oauthReady = oauth.ready
  const envReady = requiredEnv.length > 0 && requiredEnv.every((key) => Boolean(process.env[key]))
  const status: any = {
    providerID: selectedProviderID,
    modelID: selectedModelID,
    knownProvider: Boolean(record),
    selectedFromDefaultModel: !providerID,
    authMode: authPreset?.authMode || (record?.subscriptionLike ? "provider-oauth-or-token" : selectedProviderID ? "unknown-or-api-key" : null),
    authModes: record?.authModes || [],
    subscriptionLike: record?.subscriptionLike === true,
    apiKeyFallback: record?.apiKeyFallback === true,
    requiredEnv,
    presentEnv: requiredEnv.filter((key) => Boolean(process.env[key])),
    missingEnv: requiredEnv.filter((key) => !process.env[key]),
    donorEvidence: record?.evidence || null,
    donorAuthContentEnvPresent: Boolean(process.env.OPENCODE_AUTH_CONTENT),
    mendAuth: selectedProviderID ? redactedAuthSummary(authState, paths.root, selectedProviderID) : null,
    oauthExpired: oauth.expired,
    oauthRefreshReady: oauth.refreshReady,
    readsMendAuthFile: Boolean(authState),
    readsSecrets: Boolean(authState),
    printsSecrets: false,
    runsOAuth: false,
    opensBrowser: false,
    readsDonorAuthFile: false,
    mendRunReady: requiresOAuthBridge ? oauthReady : acceptsEitherOAuthOrToken ? oauthReady || envReady : envReady,
    blockers: [] as string[],
    next: null as string | null,
  }
  if (!selectedProviderID) status.blockers.push("no provider selected")
  if (selectedProviderID && !record) status.blockers.push("provider auth mode is not in MendCode's pinned donor-source inventory")
  if (selectedProviderID === "openai" && authState?.type === "oauth" && oauth.expired && !oauth.refreshReady)
    status.blockers.push("OpenAI OAuth token expired and MENDCODE_OPENAI_OAUTH_CLIENT_ID/OPENAI_OAUTH_CLIENT_ID is missing")
  if (requiresOAuthBridge && !status.mendRunReady) {
    status.blockers.push(authState ? "MendCode OAuth state is not usable for provider calls" : "MendCode OAuth state is missing; run `mend auth login openai --method browser|headless --execute` after approval")
  }
  if (acceptsEitherOAuthOrToken && !status.mendRunReady) {
    if (status.missingEnv.length) status.blockers.push(...status.missingEnv.map((key: string) => `missing env:${key}`))
    status.blockers.push("missing usable OpenAI auth state: provide OAuth or API key")
  } else if (!acceptsEitherOAuthOrToken && requiredEnv.length && status.missingEnv.length) {
    status.blockers.push(...status.missingEnv.map((key: string) => `missing env:${key}`))
  }
  if (!requiresOAuthBridge && requiredEnv.length === 0 && selectedProviderID) status.blockers.push("no credential contract is known for this provider/model")
  status.next = input.skipNext
    ? null
    : status.mendRunReady
      ? "Run `mend run --dry-run <prompt>` or `mend run <prompt>` with the enabled model."
      : selectedProviderID
        ? "Run `mend providers auth` to inspect auth mode, then configure required credentials outside committed files."
        : "Configure a default model first with `mend models use-preset ... --enable`."
  return status
}

export function providerLoginPlan(providerID: string, method?: string | null) {
  const record = (authInventory as any)[providerID]
  if (!record) throw new Error(`Unknown provider auth inventory: ${providerID}\nRun \`mend providers auth\`.`)
  const resolvedMethod = method || (providerID === "openai" ? "browser" : record.subscriptionLike ? "device" : "api-key")
  const allowed = providerID === "openai" ? ["browser", "headless", "api-key"] : record.subscriptionLike ? ["device", "api-key"] : ["api-key"]
  if (!allowed.includes(resolvedMethod)) throw new Error(`Unsupported method for ${providerID}: ${resolvedMethod}\nAllowed: ${allowed.join(", ")}`)
  const oauth = providerID === "openai" && ["browser", "headless"].includes(resolvedMethod)
  return {
    providerID,
    method: resolvedMethod,
    status: "plan-only",
    subscriptionLike: record.subscriptionLike === true,
    donorEvidence: record.evidence,
    wouldRunOAuth: oauth,
    wouldOpenBrowser: false,
    urlDelivery: resolvedMethod === "browser" ? "print-url" : resolvedMethod === "headless" ? "device-code" : null,
    writesSecrets: false,
    readsSecrets: false,
    executesNow: false,
    approvalRequiredForExecution: true,
    donorCommandPolicy: "blocked-by-default",
    next: oauth
      ? "No login was run. If approved, `mend auth login openai --method browser --execute` prints the URL; add `--open` only if you want auto-launch."
      : "No credential was written. Set the provider env var outside git, then re-run readiness gates.",
  }
}

export async function aiEnvStatus(root?: string) {
  const resolved = await resolveModelRoles(root)
  const entries = await Promise.all(
    Object.entries(resolved.roles).map(async ([name, role]: [string, any]) => {
      const authPreset = providerAuthPreset(role.providerID, role.modelID, role.authMode)
      const authStatus = role.providerID ? await providerAuthStatus(role.providerID, role.modelID, { authMode: role.authMode }, root) : null
      const requiredEnv = providerEnvRequirements(role.providerID, role.modelID, role.authMode)
      return [name, {
        providerID: role.providerID,
        modelID: role.modelID,
        authMode: authPreset?.authMode || (role.providerID ? "unknown-or-api-key" : null),
        configured: resolved.enabled && role.configured,
        requiredEnv,
        presentEnv: requiredEnv.filter((key) => Boolean(process.env[key])),
        missingEnv: requiredEnv.filter((key) => !process.env[key]),
        authReady: role.providerID ? authStatus?.mendRunReady === true : false,
        authBlockers: authStatus?.blockers || [],
      }]
    }),
  )
  const roles = Object.fromEntries(entries)
  return {
    enabled: resolved.enabled,
    defaultReady: Boolean((roles as any).default?.configured && (roles as any).default.authReady),
    roles,
    secretsPrinted: false,
    credentialsRead: false,
    note: "Environment variable presence is checked only for API-key presets; ChatGPT subscription presets require OAuth state, not OPENAI_API_KEY.",
  }
}

export async function setupReadiness(root?: string) {
  const paths = mendPaths(root)
  const models = await resolveModelRoles(paths.root)
  const memory = await memoryStatus(paths.root)
  const pkg = await readJsonIfExists(path.join(paths.root, "package.json"), {})
  const packageInfo = packageMetadata(paths.root)
  const localBin = existsSync(path.join(paths.root, "bin", "mend"))
  const linked = process.env.PATH?.split(":").map((dir) => path.join(dir, "mend")).find((file) => existsSync(file)) || null
  const pathPointsHere = linked ? path.resolve(linked) === path.join(paths.root, "bin", "mend") : false
  const blockers: string[] = []
  if (!localBin) blockers.push("missing bin/mend")
  if (!pathPointsHere) blockers.push("mend is not installed/linked on PATH for this checkout")
  if (!models.enabled) blockers.push("global models policy enabled=false")
  if (models.enabled && !models.defaultModel) blockers.push("global models policy enabled=true but default provider/model is missing")
  return {
    version: 0,
    packageName: pkg.name || null,
    packageVersion: pkg.version || null,
    packageAuthoring: {
      id: packageInfo.id,
      title: packageInfo.title,
      kind: packageInfo.kind,
      channel: packageInfo.channel,
    },
    localBin: localBin ? "bin/mend" : null,
    pathCommand: linked,
    pathPointsHere,
    generatedConfig: existsSync(path.join(paths.root, ".mendcode", "generated", "opencode.json")),
    donorGuardActive: true,
    modelsEnabled: models.enabled,
    defaultModel: models.defaultModel,
    aiReady: models.enabled && Boolean(models.defaultModel),
    memory: {
      enabled: memory.enabled,
      use: memory.use,
      generate: memory.generate,
      scopes: memory.scopes,
      entries: memory.entries,
      callsProviders: false,
      retrievalCallsProviders: false,
      outputCallsProviders: memory.outputCallsProviders,
    },
    blockers,
  }
}

export async function setupPlan(root?: string) {
  const paths = mendPaths(root)
  const readiness = await setupReadiness(paths.root)
  const plan = {
    ...readiness,
    generatedAt: new Date().toISOString(),
    status: readiness.blockers.length ? "blocked-before-ai-use" : "ready-for-ai-command-implementation",
    installActions: [{ command: "npm link", required: false, effect: "register local mend/mendcode bin on PATH for this checkout" }],
    configActions: [
      { file: "~/.mendcode/models.yaml", requiredForAI: true, effect: "enable explicit global default provider/model mapping" },
      { file: "~/.local/share/mendcode/memory/config.json", requiredForAI: false, effect: "enable global persistent memory use/generation policy" },
    ],
    packageActions: [{ file: ".mendcode/mendcode.json", fields: ["package.id", "package.title", "package.channel"], requiredForPublishing: false, effect: "improve generated mend-package.json metadata before registry publication" }],
    secretActions: [{ location: "environment or external secret manager", committed: false, requiredForAI: true, effect: "provider API credentials" }],
    writesShellProfile: false,
    installsPackages: false,
    readsSecrets: false,
    runsDonorAuth: false,
  }
  const file = path.join(paths.root, ".mendcode", "setup", "plan.json")
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(plan, null, 2)}\n`)
  return { ...plan, path: path.relative(paths.root, file) }
}

export async function setupDoctor(root?: string) {
  const readiness = await setupReadiness(root)
  const failures = readiness.blockers.filter((blocker) => blocker === "missing bin/mend")
  const warnings = readiness.blockers.filter((blocker) => blocker !== "missing bin/mend")
  return { ok: failures.length === 0, aiReady: readiness.aiReady, failures, warnings, readiness }
}

export async function aiStatus(root?: string) {
  const readiness = await setupReadiness(root)
  const env = await aiEnvStatus(root)
  return {
    ready: readiness.aiReady && env.defaultReady,
    canRunPromptNow: readiness.aiReady && env.defaultReady,
    reason: readiness.aiReady && env.defaultReady
      ? "Provider/model/auth are configured for MendCode-owned prompt execution."
      : "Provider/model setup is incomplete; MendCode will not call donor runtime or provider APIs by default.",
    missing: [...readiness.blockers, ...(((env.roles as any).default?.missingEnv || []).map((key: string) => `missing env:${key}`))],
    auth: await providerAuthStatus(null, null, {}, root),
    plannedCommandSurface: ["mend run <prompt>", "future mend chat", "future mend apply"],
    donorRuntimeBlockedByDefault: true,
    env,
    next: readiness.aiReady && env.defaultReady ? "run `mend run --dry-run <prompt>` first, then `mend run <prompt>`" : "complete mend setup plan and env/auth contract before AI execution",
  }
}
