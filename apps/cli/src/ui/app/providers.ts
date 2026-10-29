import { type preload, connectBusy, connectDone, connectFailed, createConnectState, connectWithMethods } from "../lazy-pages"
import type { ConnectAction, ConnectSubmit } from "../../view/connect-page"
import type { ProviderNote, ProvidersPageAction } from "../../view/providers-page"
import { GATEWAY_CHOICES, OPENCODE_AGENT, OPENCODE_FREE, providerName } from "../../view/provider-presets"
import type { ProviderInfo, ProviderTestResult, ProviderAuthMethod, ProviderAuthStatus, ProviderAuthorization } from "@mendcode/protocol"
import { redactSecrets } from "@mendcode/protocol/wire"
import type { ModelsReport } from "@mendcode/protocol"
import type { CommandReply } from "@mendcode/client"
import type { AppContext } from "./context"

export function createProviders(ctx: AppContext, actions: {
  takeModels(reply: CommandReply): boolean
  loadPage(name: Parameters<typeof preload>[0] | undefined): Promise<void>
  runSlash(text: string): Promise<boolean>
}) {
  const { input, state, requestFrame, say } = ctx
  const { takeModels, loadPage, runSlash } = actions
  let authTick: ReturnType<typeof setTimeout> | undefined
  let deepinfraSeeded = false
  const seedDeepInfra = () => {
    if (state.connectState.step === "pick") deepinfraSeeded = false
    if (deepinfraSeeded || state.connectState.target !== "deepinfra" || state.connectState.step !== "form") return
    const provider = state.connectProviders?.find((entry) => entry.id === "deepinfra")
    if (!provider) return
    deepinfraSeeded = true
    if (!state.connectState.values.baseUrl) state.connectState = { ...state.connectState, values: { ...state.connectState.values, baseUrl: provider.baseUrl } }
  }
  let cerebrasSeeded = false
  const seedCerebras = () => {
    if (state.connectState.step === "pick") cerebrasSeeded = false
    if (cerebrasSeeded || state.connectState.target !== "cerebras" || state.connectState.step !== "form") return
    const provider = state.connectProviders?.find((entry) => entry.id === "cerebras")
    if (!provider) return
    cerebrasSeeded = true
    if (!state.connectState.values.baseUrl) state.connectState = { ...state.connectState, values: { ...state.connectState.values, baseUrl: provider.baseUrl } }
  }
  let cohereSeeded = false
  const seedCohere = () => {
    if (state.connectState.step === "pick") cohereSeeded = false
    if (cohereSeeded || state.connectState.target !== "cohere" || state.connectState.step !== "form") return
    const provider = state.connectProviders?.find((entry) => entry.id === "cohere")
    if (!provider) return
    cohereSeeded = true
    if (!state.connectState.values.baseUrl) state.connectState = { ...state.connectState, values: { ...state.connectState.values, baseUrl: provider.baseUrl } }
  }
  let vertexSeeded = false
  const seedVertex = () => {
    if (state.connectState.step === "pick") vertexSeeded = false
    if (vertexSeeded || !["google-vertex", "google-vertex-anthropic"].includes(state.connectState.target ?? "") || state.connectState.step !== "form") return
    const provider = state.connectProviders?.find((entry) => entry.id === state.connectState.target)
    if (!provider) return
    vertexSeeded = true
    state.connectState = { ...state.connectState, values: { ...state.connectState.values, baseUrl: provider.vertex?.endpoint ?? "", models: provider.models.map((entry) => entry.id).join(", "), vertexProject: provider.vertex?.project ?? "", vertexLocation: provider.vertex?.location ?? "", keyEnv: provider.vertex?.tokenEnv ?? "", vertexQuotaProject: provider.vertex?.quotaProject ?? "", vertexMetadata: provider.vertex?.allowMetadata ? "on" : "off" } }
  }
  let cloudflareSeeded = false
  const seedCloudflare = () => {
    if (state.connectState.step === "pick") cloudflareSeeded = false
    if (cloudflareSeeded || !["cloudflare-workers-ai", "cloudflare-ai-gateway"].includes(state.connectState.target ?? "") || state.connectState.step !== "form") return
    const provider = state.connectProviders?.find((entry) => entry.id === state.connectState.target)
    if (!provider) return
    cloudflareSeeded = true
    state.connectState = { ...state.connectState, values: { ...state.connectState.values, baseUrl: provider.baseUrl, models: provider.models.map((entry) => entry.id).join(", "), cloudflareAccountId: provider.cloudflareWorkersAi?.accountId ?? provider.cloudflareAiGateway?.accountId ?? "", cloudflareGatewayId: provider.cloudflareAiGateway?.gatewayId ?? "" } }
  }
  let azureSeeded = false
  let bedrockSeeded = false
  const seedBedrock = () => {
    if (state.connectState.step === "pick") bedrockSeeded = false
    if (bedrockSeeded || state.connectState.target !== "amazon-bedrock" || !["methods", "form"].includes(state.connectState.step)) return
    const provider = state.connectProviders?.find((entry) => entry.id === "amazon-bedrock")
    if (!provider) return
    bedrockSeeded = true
    const region = provider.bedrock?.region ?? "us-east-1"
    const regionalEndpoint = `https://bedrock-runtime.${region}.${region.startsWith("cn-") ? "amazonaws.com.cn" : "amazonaws.com"}`
    state.connectState = { ...state.connectState, values: { ...state.connectState.values, baseUrl: provider.baseUrl === regionalEndpoint ? "" : provider.baseUrl, models: provider.models.map((entry) => entry.id).join(", "), awsAuth: provider.bedrock?.auth ?? "chain", awsRegion: provider.bedrock?.region ?? "", awsProfile: provider.bedrock?.profile ?? "", awsMetadata: provider.bedrock?.allowMetadata ? "on" : "off", awsProcess: provider.bedrock?.allowCredentialProcess ? "on" : "off" } }
  }
  const seedAzure = () => {
    if (state.connectState.step === "pick") azureSeeded = false
    if (azureSeeded || state.connectState.target !== "azure" || !["methods", "form"].includes(state.connectState.step)) return
    const azure = state.connectProviders?.find((entry) => entry.id === "azure")
    if (!azure) return
    azureSeeded = true
    state.connectState = { ...state.connectState, values: { ...state.connectState.values, baseUrl: azure.baseUrl, models: azure.models.map((entry) => entry.id).join(", "), azureAuth: azure.azure?.auth ?? "api-key", apiVersion: azure.azure?.apiVersion ?? "v1", azureTransport: azure.azure?.useCompletionUrls ? "chat" : "responses", azureUrls: azure.azure?.useDeploymentBasedUrls ? "deployment" : "v1", keyEnv: azure.azure?.tokenEnv ?? "" } }
  }
  const stopAuthTick = () => { clearTimeout(authTick); authTick = undefined }
  const authProvider = () => state.connectState.target === "github-copilot" ? "github-copilot" : "chatgpt"

  /** A daemon error for the screen: the literal key (when this call held one) and anything shaped like a secret are masked. */
  const plainError = (message: string, secret?: string) => redactSecrets((secret ? message.split(secret).join("•••") : message).replace(/^\[[A-Z]+\]: /, "")).text

  const providersOf = (reply: Awaited<ReturnType<typeof input.send>>) => (reply.ok && Array.isArray(reply.result?.providers) ? (reply.result.providers as ProviderInfo[]) : undefined)

  const providerOf = (reply: Awaited<ReturnType<typeof input.send>>) => (reply.ok ? (reply.result?.provider as ProviderInfo | undefined) : undefined)

  const upsert = (list: ProviderInfo[] | undefined, info: ProviderInfo) => (list ? (list.some((entry) => entry.id === info.id) ? list.map((entry) => (entry.id === info.id ? info : entry)) : [...list, info]) : [info])

  /** Tells the model catalog to load again: a provider's models appear in /model once its key is saved. */
  async function reloadModels() {
    takeModels(await input.send({ type: "models.list", ...(state.sessionId ? { sessionId: state.sessionId } : {}) }))
  }

  async function openConnect(target: string) {
    stopAuthTick()
    deepinfraSeeded = false
    cerebrasSeeded = false
    cohereSeeded = false
    azureSeeded = false
    bedrockSeeded = false
    vertexSeeded = false
    cloudflareSeeded = false
    // /providers reaches this without going through a slash command, so its module may not be loaded yet.
    await loadPage("connect")
    state.page = "connect"
    const serial = ++state.connectSerial
    state.connectState = createConnectState(target || undefined)
    state.connectProviders = undefined
    state.connectModels = undefined
    // Anything after `/connect ` that names no provider is not echoed: it may be a key pasted into the prompt.
    if (target && state.connectState.step === "pick") state.notice = "unknown provider · pick one from the list"
    requestFrame()
    const [listed, models, methods, auth] = await Promise.all([input.send({ type: "providers.list" }), input.send({ type: "models.list", ...(state.sessionId ? { sessionId: state.sessionId } : {}) }), input.send({ type: "providers.auth.methods" }), input.send({ type: "providers.auth.status" })])
    if (serial !== state.connectSerial) return
    state.connectProviders = providersOf(listed)
    seedDeepInfra()
    seedCerebras()
    seedCohere()
    seedAzure()
    seedBedrock()
    seedVertex()
    seedCloudflare()
    if (models.ok && models.result) state.connectModels = models.result as ModelsReport
    if (methods.ok && methods.result?.methods) state.connectState = connectWithMethods(state.connectState, methods.result.methods as Record<string, ProviderAuthMethod[]>)
    const statuses = auth.ok ? auth.result?.statuses as ProviderAuthStatus[] | undefined : undefined
    const status = statuses?.find((entry) => entry.provider === authProvider())
    if (statuses) state.connectState = { ...state.connectState, authStatuses: Object.fromEntries(statuses.map((entry) => [entry.provider, entry])) }
    if (status) state.connectState = { ...state.connectState, authStatus: status, ...(["chatgpt", "github-copilot"].includes(state.connectState.target ?? "") && (status.source === "v2" || status.state === "pending") ? { step: "oauth" as const } : {}) }
    requestFrame()
  }

  async function authStatus(serial: number) {
    const reply = await input.send({ type: "providers.auth.status", provider: authProvider() })
    if (serial !== state.connectSerial || state.page !== "connect") return
    const status = reply.ok ? (reply.result?.statuses as ProviderAuthStatus[] | undefined)?.[0] : undefined
    if (status) {
      state.connectState = { ...state.connectState, step: "oauth", authStatus: status, authStatuses: { ...state.connectState.authStatuses, [status.provider]: status } }
      if (status.state === "authorized") void reloadModels()
    } else if (!reply.ok) state.connectState = { ...state.connectState, error: plainError(reply.error.message) }
    requestFrame()
    if (status?.state === "pending") {
      authTick = setTimeout(() => { void authStatus(serial) }, 1000)
      authTick.unref?.()
    }
  }

  async function authorize(provider: string, method: string) {
    stopAuthTick()
    const serial = ++state.connectSerial
    const reply = await input.send({ type: "providers.auth.authorize", provider, method })
    if (serial !== state.connectSerial || state.page !== "connect") {
      if (reply.ok) await input.send({ type: "providers.auth.action", provider: provider === "github-copilot" ? provider : "chatgpt", action: "cancel" })
      return
    }
    const authorization = reply.ok ? reply.result?.authorization as ProviderAuthorization | undefined : undefined
    if (!authorization) {
      state.connectState = { ...state.connectState, step: "methods", error: plainError(reply.ok ? "No authorization returned" : reply.error.message) }
      return requestFrame()
    }
    state.connectState = { ...state.connectState, step: "oauth", authorization, error: undefined }
    await authStatus(serial)
  }

  /** The test after a save, or on `t`: one tiny request to the provider. */
  async function connectTest(provider: string, serial: number, secret?: string) {
    state.connectState = connectBusy(state.connectState, `Testing ${providerName(provider)}`)
    requestFrame()
    const tested = await input.send({ type: "providers.test", provider })
    if (serial !== state.connectSerial || state.page !== "connect") return
    const result = tested.ok ? (tested.result as ProviderTestResult | undefined) : undefined
    // With an environment reference the terminal cannot scrub the actual credential.
    const testError = (message: string) => state.connectState.viaEnv ? "Provider test failed; check credentials or edit connection details" : plainError(message, secret)
    state.connectState = connectDone(
      state.connectState,
      result
        ? { provider, ok: result.ok, latencyMs: result.latencyMs, ...(result.model ? { model: result.model } : {}), ...(result.error ? { error: testError(result.error) } : {}) }
        : { provider, ok: false, error: testError(tested.ok ? "no reply from the daemon" : tested.error.message) },
    )
    if (result?.ok && !["azure", "amazon-bedrock", "google-vertex", "google-vertex-anthropic", "zenmux", "gitlab", "togetherai", "kilo", ...GATEWAY_CHOICES, "cloudflare-workers-ai", "cloudflare-ai-gateway"].includes(provider)) say(`${providerName(provider)} connected`, "success")
    requestFrame()
  }

  /** Saves the form (`providers.set`, the only command that carries the key), then tests it. The key is held by this call alone. */
  async function connectSubmit(submit: ConnectSubmit) {
    const serial = ++state.connectSerial
    const secret = submit.apiKey
    requestFrame()
    const saved = await input.send({ type: "providers.set", ...submit })
    if (serial !== state.connectSerial || state.page !== "connect") return
    if (!saved.ok) {
      state.connectState = connectFailed(state.connectState, plainError(saved.error.message, secret))
      return requestFrame()
    }
    const info = providerOf(saved)
    if (info) state.connectProviders = upsert(state.connectProviders, info)
    if (["github-copilot", "opencode", "llmgateway", "nvidia", "sap-ai-core", "zenmux", "gitlab", "kilo", ...GATEWAY_CHOICES].includes(submit.provider)) {
      state.connectState = connectBusy(state.connectState, `Loading ${providerName(submit.provider)} models`)
      requestFrame()
      const refreshed = await input.send({ type: "providers.refresh", provider: submit.provider })
      if (serial !== state.connectSerial || state.page !== "connect") return
      const updated = providerOf(refreshed)
      if (updated) state.connectProviders = upsert(state.connectProviders, updated)
      if (!refreshed.ok) {
        state.connectState = connectDone(state.connectState, { provider: submit.provider, ok: false, error: plainError(refreshed.error.message, secret), note: "Model refresh failed" })
        return requestFrame()
      }
    }
    await connectTest(submit.provider, serial, secret)
    void reloadModels()
  }

  async function connectRefresh(provider: string) {
    const serial = ++state.connectSerial
    state.connectState = connectBusy(state.connectState, `Refreshing ${providerName(provider)} models`)
    requestFrame()
    const reply = await input.send({ type: "providers.refresh", provider })
    if (serial !== state.connectSerial || state.page !== "connect") return
    const info = providerOf(reply)
    const before = state.connectState.result ?? { provider, ok: true }
    if (info) state.connectProviders = upsert(state.connectProviders, info)
    if (info && ["zenmux", "gitlab", "kilo", ...GATEWAY_CHOICES, "cloudflare-workers-ai", "cloudflare-ai-gateway"].includes(provider) && before.note === "Model refresh failed") {
      await connectTest(provider, serial)
      if (serial !== state.connectSerial || state.page !== "connect") return
      state.connectState = connectDone(state.connectState, { ...state.connectState.result!, refreshed: info.models.length })
    } else state.connectState = connectDone(state.connectState, info ? { ...before, refreshed: info.models.length, ...(["google-vertex", "google-vertex-anthropic"].includes(info.type) ? { note: "Publisher model catalog retained" } : info.type === "azure" ? { note: "Configured deployments retained" } : {}) } : { ...before, ...(reply.ok ? {} : { note: `refresh failed: ${plainError(reply.error.message)}` }) })
    if (info) void reloadModels()
    requestFrame()
  }

  async function connectAction(action: ConnectAction) {
    if (action.type === "none") seedDeepInfra()
    if (action.type === "none") seedCerebras()
    if (action.type === "none") seedCohere()
    if (action.type === "none") seedVertex()
    if (action.type === "none") seedAzure()
    if (action.type === "none") seedBedrock()
    if (action.type === "none") seedCloudflare()
    if (action.type === "close") {
      stopAuthTick()
      if (state.connectState.authStatus?.state === "pending") await input.send({ type: "providers.auth.action", provider: authProvider(), action: "cancel" })
      state.connectSerial++
      state.page = "chat"
    } else if (action.type === "submit") await connectSubmit(action.submit)
    else if (action.type === "test") await connectTest(action.provider, ++state.connectSerial)
    else if (action.type === "refresh") await connectRefresh(action.provider)
    else if (action.type === "authorize") await authorize(action.provider, action.method)
    else if (action.type === "auth-status") { stopAuthTick(); await authStatus(state.connectSerial) }
    else if (action.type === "copy-auth") {
      const authorization = state.connectState.authorization
      if (authorization) ctx.copyText(["headless", "device"].includes(authorization.method) ? authorization.instructions.replace(/^Enter code: /, "") : authorization.url, "authorization")
    } else if (action.type === "auth") {
      stopAuthTick()
      const serial = ++state.connectSerial
      const reply = await input.send({ type: "providers.auth.action", provider: authProvider(), action: action.action })
      if (serial !== state.connectSerial || state.page !== "connect") return
      if (!reply.ok) state.connectState = { ...state.connectState, error: plainError(reply.error.message) }
      else {
        state.connectState = { ...state.connectState, authorization: undefined, error: undefined }
        await authStatus(serial)
      }
    }
    else if (action.type === "model") {
      state.connectSerial++
      await runSlash("/model")
    } else if (action.type === "add-opencode") await addOpencode(state.connectSerial)
    requestFrame()
  }

  /** `/connect` → OpenCode (free): the `opencode` ACP agent, through the same `acpAgents` setting `/acp` edits. */
  async function addOpencode(serial: number) {
    // Asked, not taken from the cached settings: an `opencode` agent the user set up by hand is never replaced.
    const current = await input.send({ type: "settings.get" })
    const already = Boolean(current.ok && (current.result?.settings as typeof state.settingsNow | undefined)?.acpAgents?.[OPENCODE_AGENT.name])
    const reply = already ? undefined : await input.send({ type: "settings.set", patch: { acpAgents: { [OPENCODE_AGENT.name]: OPENCODE_AGENT.config } } })
    if (serial !== state.connectSerial || state.page !== "connect") return
    if (reply && !reply.ok) {
      state.connectState = connectDone(state.connectState, { provider: OPENCODE_FREE, ok: false, error: plainError(reply.error.message) })
      return
    }
    if (reply?.ok && reply.result?.settings) state.settingsNow = reply.result.settings as typeof state.settingsNow
    const models = await input.send({ type: "models.list", ...(state.sessionId ? { sessionId: state.sessionId } : {}) })
    if (serial !== state.connectSerial) return
    if (models.ok && models.result) state.connectModels = models.result as ModelsReport
    state.connectState = connectDone(state.connectState, { provider: OPENCODE_FREE, ok: true, ...(already ? { note: "it was already" } : {}) })
  }

  async function loadProviders() {
    const reply = await input.send({ type: "providers.list" })
    const list = providersOf(reply)
    if (list) {
      state.providersList = list
      state.providersError = ""
    } else if (!reply.ok) state.providersError = plainError(reply.error.message)
    requestFrame()
  }

  function noteProvider(provider: string, note: ProviderNote | undefined) {
    if (note) state.providerNotes[provider] = note
    else delete state.providerNotes[provider]
    requestFrame()
  }

  async function providersAction(action: ProvidersPageAction) {
    if (action.type === "close") state.page = "chat"
    else if (action.type === "connect") await openConnect("")
    else if (action.type === "toggle") {
      const reply = await input.send({ type: "providers.set", provider: action.provider, enabled: action.enabled })
      const info = providerOf(reply)
      if (info) {
        state.providersList = upsert(state.providersList, info)
        noteProvider(action.provider, { text: action.enabled ? "turned on" : "turned off", tone: "muted" })
        void reloadModels()
      } else if (!reply.ok) noteProvider(action.provider, { text: plainError(reply.error.message), tone: "error" })
    } else if (action.type === "test") {
      noteProvider(action.provider, { text: "testing…", tone: "muted" })
      const reply = await input.send({ type: "providers.test", provider: action.provider })
      const result = reply.ok ? (reply.result as ProviderTestResult | undefined) : undefined
      if (result?.ok) noteProvider(action.provider, { text: `test ok · ${result.latencyMs} ms${result.model ? ` · ${result.model}` : ""}`, tone: "success" })
      else noteProvider(action.provider, { text: `test failed: ${plainError(result?.error ?? (reply.ok ? "no reply" : reply.error.message))}`, tone: "error" })
    } else if (action.type === "refresh") {
      noteProvider(action.provider, { text: "refreshing models…", tone: "muted" })
      const reply = await input.send({ type: "providers.refresh", provider: action.provider })
      const info = providerOf(reply)
      if (info) {
        state.providersList = upsert(state.providersList, info)
        noteProvider(action.provider, { text: `${info.models.length} ${info.models.length === 1 ? "model" : "models"} loaded`, tone: "success" })
        void reloadModels()
      } else noteProvider(action.provider, { text: `refresh failed: ${reply.ok ? "no reply" : plainError(reply.error.message)}`, tone: "error" })
    } else if (action.type === "remove") {
      const reply = await input.send({ type: "providers.remove", provider: action.provider })
      const list = providersOf(reply)
      if (list) {
        state.providersList = list
        noteProvider(action.provider, undefined)
        if (!["zenmux", "gitlab"].includes(action.provider)) say(`removed ${providerName(action.provider)}`, "success")
        void reloadModels()
      } else if (!reply.ok) noteProvider(action.provider, { text: plainError(reply.error.message), tone: "error" })
    }
    requestFrame()
  }

  return { openConnect, connectAction, loadProviders, providersAction }
}
