#!/usr/bin/env bun
import { engineEnvironment } from "./engine-environment"
import { instructionControls, projectSources } from "./project-control"
import { remoteInstructions } from "./remote-instructions"
import { createWebfetchResources } from "./webfetch-resources"
import { installNetworkPolicy } from "./network-policy"
import { systemWithLimits } from "./run-limits"
import { memorySettings } from "./memory-config"
import packageJson from "../../../apps/cli/package.json"
import { otlpFromEnvironment } from "./tracing"
import { PROGRAM_NAME } from "@mendcode/program"
import { appendFileSync, existsSync } from "node:fs"
import { logLevel } from "./logging"
import { dropHostSessionEnv } from "./inherited-env"
import { createProviderMetadataAuth } from "./provider-metadata-auth"
import { homedir } from "node:os"
import path from "node:path"
import {
  CHATGPT_CODEX_BASE_URL,
  chatgptQuota,
  codexSubscriptionHeaders,
  createCodexModelCatalog,
  createInstructionLoader,
  createNativeEngine,
  createLoopbackJevEvaluator,
  createRememberTool,
  createMemoryTool,
  createMemoryGraphTool,
  createSkillLoader,
  createSkillTool,
  createMemorySelector,
  joinSystemParts,
  type SystemPart,
  questionTool,
  todoTool,
  createPermissionReviewer,
  createProviderRouter,
  cacheConfigFor,
  declaredRoots,
  classifySmart,
  createResponsesProvider,
  loadCompactionPrompt,
  loadContinuationPrompt,
  loadSystemPrompt,
  loadTerminalRendering,
  NATIVE_DEFAULTS,
  policyRules,
  toolDisabled,
  type ModelMessage,
  type SystemContext,
  catalogEfforts,
} from "@mendcode/engine-native"
import { createModelsDev } from "./models-dev"
import { acpAgentName } from "./acp-registry"
import { BUILTIN_TOOLS, sandboxPolicy, canonicalDir, shellSession, createToolDefine, createWebSearchTool, loopTool, worktreeTool, prWatchTool, createComputerTools, browserTool, type Tool, aiConfigTool } from "@mendcode/tools"
import { createDaemonImageGenTool } from "./image-generation"
import { ptyAvailable } from "./pty-native"
import { createAcpAgents, createAcpEngine, withAcpEngine } from "@mendcode/engine-acp"
import { createPiConfig, createPiEngine, piCapabilities, probePi, withPiEngine } from "@mendcode/engine-pi"
import { createSidebarTool } from "./sidebar"
import { createCustomizeUiTool } from "./customize-ui"
import { createExtendTool, extensionToolCheck } from "./extend-tool"
import { createSettingsTool } from "./settings-tool"
import { workflowScriptTool, workflowStartTool, workflowStatusTool, workflowSaveTool, workflowControlTool, workflowEventsTool, workflowArtifactsTool } from "./workflow-tools"
import { sessionsTool, tellTool } from "./peer-tools"
import { threadsTool } from "./thread-tool"
import { packagesTool } from "./packages-tool"
import { sessionMetaTool } from "./session-meta-tool"
import { createCodeGraphTools, createCodeOverview, createIndexGate, createIndexer } from "@mendcode/codegraph"
import { GRAPH_TOOL_PATTERNS, graphIndexMode } from "./graph-gate"
import { filteredCatalog, modelAllowed } from "./models"
import { createToolOutputs, toolOutputSettings } from "./tool-output"
import { createOneTree } from "./one-tree"
import { createSessionTranscripts } from "./session-transcripts"
import { rolesFor, shellFor } from "./profiles"
import { createMcpAuth, createMcpManager, mcpResourceTools, mcpTools, type McpServerConfig } from "@mendcode/mcp"
import { createMcpConfigLoader } from "./mcp-loader"
import { HOST_MCP_SERVER } from "./host-mcp"
import { defaultLayers, type ExtensionLayer } from "@mendcode/packages"
import { createAfterWrite, createDiagnosticsTool, createFormatterManager, createLspManager, createLspTool, installLspServer } from "@mendcode/lsp"
import { realClock } from "@mendcode/kernel"
import { computeBuildId } from "@mendcode/build-id"
import { remoteListenerConfig, validateRemoteListener } from "./remote"
import { HTTP_WEB } from "./http-web"
import { startDaemon } from "./daemon"
import { claudeCodeProbe, codexAppServerProbe, nativeCodexProbe } from "./quota-probes"
import { createCodegraphStatus } from "./codegraph-status"
import { systemPartsWith, type PromptFiles } from "./extensions"
import { promptContextParts, promptFileOverrides } from "./prompt-context"
import { outputStyleText } from "./output-styles"
import { createPromptModes } from "./prompt-modes"
import { invalidChoice, modelEngine, resolveModel, usableEffort, type ModelCatalog } from "./models"
import { claudeAlias, claudeCompactEnv, claudeSubagentEnv, createClaudeDetection, createClaudeModelCatalog, probeClaude } from "./claude-models"
import { createEngineRouter } from "./engine-router"
import { withCodexEngine } from "./codex-router"
import { threadMcpEnabled } from "./thread-mcp-policy"
import { createProviderService } from "./providers"
import { createProviderAuth } from "./provider-auth"
import { createCacheTtl } from "./cache-ttl"
import { readUsageProfile } from "./usage-profile"
import { windowOverride } from "./session-context-window"
import { memoryExtractionPrompt } from "./memory-extract-prompt"
import type { ModelChoice, ModelInfo } from "@mendcode/protocol"
import { effectiveSettings, featureOn, findModel, modelContextOf } from "@mendcode/protocol"
import { claudeFastModel } from "@mendcode/protocol/wire"
import { globalTrigger } from "./context-limits"
import { hosting } from "./hosting"
import { createLocalDictation } from "./voice-local"
import { DETACHED_IDLE_EXIT_MS, runsAsUserService } from "./user-service"

/** Data lives in ~/.mendcode-v2, fully separate from legacy MendCode (~/.local/share/mendcode is never touched). */
export const DEFAULT_DIR = path.join(homedir(), ".mendcode-v2")

/** The daemon's flags: this process's own, or the host's when the terminal runs the daemon in-process (./hosting). */
const argv = hosting.argv ?? process.argv
/** A log line: the daemon's log file when a terminal hosts it (its screen is the TUI), stderr otherwise. */
const logLine = (message: string) => (hosting.log ? hosting.log("info", message) : console.error(message))
// Before anything is started: what a Claude Code shell left in the environment must not reach the sessions' commands.
dropHostSessionEnv(process.env)

function arg(name: string) {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? argv[index + 1] : undefined
}

// Started lean (apps/cli/src/launcher.ts LEAN_JIT): JSC has read its options, so the user's commands run by this daemon get the environment the user had.
if (process.env.MENDCODE_V2_LEAN_JIT === "1") for (const key of ["BUN_JSC_useDFGJIT", "BUN_JSC_useFTLJIT", "MENDCODE_V2_LEAN_JIT"]) delete process.env[key]
const dir = arg("dir") ?? process.env.MENDCODE_V2_DIR ?? DEFAULT_DIR
/** `--safe-mode` (or MENDCODE_SAFE_MODE=1): no extensions, packages, shell hooks, MCP or project tools, whatever the settings say (docs/tiers.md). */
const safeMode = argv.includes("--safe-mode") || process.env.MENDCODE_SAFE_MODE === "1"
// Settings `proxy` (docs/resources-config.md): every outbound request of this process goes through one policy-aware fetch.
installNetworkPolicy({ settings: () => { try { return extractionSettings() } catch { return {} } } })
for (const name of ["listen", "tls-cert", "tls-key", "log-level", "http-listen", "mflow-listen", "local-transport"]) {
  if (argv.includes(`--${name}`) && (!arg(name) || arg(name)!.startsWith("--"))) throw new Error(`--${name} needs a value`)
}
if (arg("local-transport") && arg("local-transport") !== "tcp" && arg("local-transport") !== "unix") throw new Error("--local-transport must be tcp or unix")
const remoteOptions = argv.includes("--local-only") ? {} : remoteListenerConfig(dir, { ...(arg("listen") ? { listen: arg("listen")! } : {}), ...(arg("tls-cert") ? { tlsCert: arg("tls-cert")! } : {}), ...(arg("tls-key") ? { tlsKey: arg("tls-key")! } : {}) })
validateRemoteListener(remoteOptions)
// Code graph tools index lazily on first use; `MENDCODE_CODEGRAPH=0` leaves them out entirely.
const codegraphStatus = createCodegraphStatus()
// One indexer for the tools and for the Galaxy panel's code mode (`codegraph.overview`), so both read the same graph of a project.
const codeIndexer = process.env.MENDCODE_CODEGRAPH === "0" ? undefined : createIndexer({ cacheDir: path.join(dir, "codegraph"), now: Date.now, onIndex: codegraphStatus.publish })
// Which folders are indexed (docs/code-graph.md): `auto` a git repository under the size limit, or the project's `/graph on|off`.
const codeGate = codeIndexer ? createIndexGate() : undefined
const graphGateOf = (cwd: string, signal?: AbortSignal) => codeGate!.check({ cwd, mode: graphIndexMode(extractionSettings(), cwd), signal })
const codeGraphTools = codeIndexer ? createCodeGraphTools({ cacheDir: path.join(dir, "codegraph"), indexer: codeIndexer, gate: graphGateOf }) : []
/** The graph tools leave the model's list in a folder the gate skips; the footer is told once. Unknown yet (a size not measured): listed. */
const hiddenGraphTools = (directory: string): readonly string[] => {
  if (!codeGate || !featureOn(extractionSettings(), "codegraph", { safeMode })) return []
  const verdict = codeGate.peek({ cwd: directory, mode: graphIndexMode(extractionSettings(), directory) })
  if (!verdict || verdict.index) return []
  const last = codegraphStatus.get(directory)
  if (last?.state !== "skipped" || last.reason !== verdict.reason) codegraphStatus.publish({ cwd: directory, state: "skipped", reason: verdict.reason })
  return GRAPH_TOOL_PATTERNS
}
const socketPath = arg("socket") ?? path.join(dir, "mendd.sock")
/** native = MendCode's own loop on the user's ChatGPT subscription; codex = Codex app-server; faux = offline test engine. */
const engineName = arg("engine") ?? process.env.MENDCODE_V2_ENGINE ?? "native"
const cwd = arg("cwd") ?? process.cwd()

const systemPrompt = engineName === "native" ? await loadSystemPrompt() : () => ""
const compactionPrompt = engineName === "native" ? await loadCompactionPrompt() : ""
const continuationPrompt = engineName === "native" ? await loadContinuationPrompt() : ""
/** Project AGENTS.md / CLAUDE.md plus the user's global ~/.mendcode-v2/AGENTS.md. */
const instructionsFor = createInstructionLoader({ globalFile: path.join(dir, "AGENTS.md"), paths: (root) => projectSources(root, extractionSettings(), remoteInstructions(dir).pathFor).instructions, ...instructionControls(() => extractionSettings()) })
/**
 * Extension layers (enabled packages, the user's and the project's own folders). The daemon's version reads
 * the disabled packages from settings; it replaces this default when the daemon builds the engine, before any turn.
 */
let layersFor = (directory: string): ExtensionLayer[] => defaultLayers({ userDir: dir, directory })
/** Skills of every layer: packages, ~/.mendcode-v2/skills, project .mendcode/skills. */
let skills = createSkillLoader({ userDir: dir, layers: (cwd) => layersFor(cwd) })
/**
 * MCP servers from every layer's mcp.json. Nothing runs until a turn in a project with servers configured;
 * idle servers stop after 10 minutes (P6).
 */
// Remote (url) servers that answer 401 are authorized with OAuth; their tokens live in <dir>/mcp-auth.json (mode 0600).
// A tier below `full`, `features.mcp: false` and safe mode leave it with no servers at all: tools, prompts, mentions and the debug view see an empty config.
const mcpAllowed = () => featureOn(extractionSettings(), "mcp", { safeMode })
/** Servers extensions register (`api.registerMcpServer`); bound once the daemon built its extensions. */
let extensionMcpServers: (directory: string) => Promise<Record<string, McpServerConfig>> = async () => ({})
const mcp = createMcpManager({ configLoader: createMcpConfigLoader({ userDir: dir, layers: (directory) => layersFor(directory), allowed: mcpAllowed, trustedDirs: () => extractionSettings().trustedToolDirs, extensionServers: (directory) => extensionMcpServers(directory) }), auth: createMcpAuth({ dir }) })
/** Language servers are lazy, provisioned only from offline caches, and stopped after 5 idle minutes. */
const lsp = createLspManager({ cacheDir: path.join(dir, "lsp") })
const formatter = createFormatterManager()
/**
 * After a write: a configured formatter finishes first (4 s limit per file). Diagnostics come only from a language server that is already
 * running, waited for 300 ms; what it reports later (within 4 s) goes on the session's next tool result. A write never starts a server
 * itself: after its result is returned, a server that is installed locally for the written file is started in the background (never
 * provisioned), so later writes get diagnostics. There is no LSP feature id: language servers are on unless the user's settings (with
 * the tier and safe mode applied) deny both the `lsp` and the `diagnostics` tool. The minimalist tier never warms up, and
 * MENDCODE_LSP_WARMUP=0 turns the warm-up alone off.
 */
const lspWarmUp = () => {
  if (process.env.MENDCODE_LSP_WARMUP === "0") return false
  // The minimalist tier promises the least memory: a language server there runs only when the model or the user asks for one.
  if (extractionSettings().tier === "minimalist") return false
  const rules = policyRules(effectiveSettings(extractionSettings(), { safeMode }))
  return !(toolDisabled("lsp", rules) && toolDisabled("diagnostics", rules))
}
const afterWrite = createAfterWrite({ manager: lsp, formatter, budgetMs: 4_000, diagnosticsWaitMs: 300, warmUp: lspWarmUp })
/**
 * Models of the user's subscription, from the Codex CLI's cache (read-only), plus Claude Code's when the user's own
 * `claude` is installed (MENDCODE_CLAUDE=0 hides them; MENDCODE_CLAUDE_BIN points at a `claude` outside PATH).
 * Only the native engine lets the user choose.
 */
const codexModels = createCodexModelCatalog()
const claudeBin = process.env.MENDCODE_CLAUDE_BIN || "claude"
const claudeDetection = createClaudeDetection({ probe: () => probeClaude(claudeBin) })
const claudeModels = createClaudeModelCatalog()
const claudeProbed = engineName === "native" && process.env.MENDCODE_CLAUDE !== "0"
if (claudeProbed) void claudeDetection.refresh()
/** API-key providers from `<dir>/providers.json` and the environment (ANTHROPIC_API_KEY, OPENAI_API_KEY, ...); their models join the catalog namespaced `<provider>:<model>`. */
const providerMetadata = createProviderMetadataAuth({ dir })
/** Providers user extensions register (`api.registerProvider` with a baseUrl); bound once the daemon built its extensions. */
let extensionProviders: () => Record<string, unknown> = () => ({})
/** The models.dev provider whose API prices a subscription engine's calls. */
const LIST_PRICE_VENDOR: Readonly<Record<string, string>> = { chatgpt: "openai", codex: "openai", claude: "anthropic" }
/** models.dev's reasoning levels and prices for the models providers and ACP agents list; fetched in the background, never awaited. */
const modelsDev = createModelsDev({ dir, log: (message) => logLine(`[MODELS]: ${message}`) })
const providerService = createProviderService({ dir, settings: () => extractionSettings(), keyForEnv: providerMetadata.keyForEnv, extensions: () => extensionProviders(), modelsDev })
const providerAuth = createProviderAuth({ dir, providers: providerService, metadata: providerMetadata })
const subscriptionHeaders = async () => {
  const owned = providerAuth.chatgpt.status()
  if (owned.error) throw new Error("[AUTH]: v2 ChatGPT login failed; use /connect chatgpt")
  return owned.source === "v2" ? providerAuth.chatgpt.headers() : codexSubscriptionHeaders()()
}
/** A login `subscriptionHeaders` can use: MendCode's own (/connect chatgpt) or the Codex CLI's. Only whether it exists; nothing is read. */
const subscriptionLogin = () => providerAuth.chatgpt.status().source === "v2" || existsSync(path.join(process.env.CODEX_HOME ?? path.join(homedir(), ".codex"), "auth.json"))
/** External agents that speak the Agent Client Protocol, from `<dir>/acp-agents.json`; each is a model `acp:<name>`. */
const acpAgents = createAcpAgents({
  dir,
  displayName: acpAgentName,
  catalogEfforts: (model) => {
    const slash = model.indexOf("/")
    const facts = slash > 0 ? modelsDev.facts(model.slice(0, slash), model.slice(slash + 1)) : undefined
    return facts ? catalogEfforts(facts) : undefined
  },
})
// The catalog is only fetched for a daemon with somewhere to use it, and well after the first frame.
if (engineName === "native") setTimeout(() => { if (providerService.models(true).length > 0 || acpAgents.models().length > 0) void modelsDev.refresh() }, 5_000).unref?.()
/**
 * The user's own pi over its RPC mode (docs/pi-engine.md). Opt-in twice: the tier must allow it (`full`, or no tier) and the user
 * must ask for it with `<dir>/pi.json` or `/tier pi on`. Its models are listed then; pi itself starts on the first turn of a session that picks one.
 */
const piConfig = createPiConfig({ dir, optedIn: () => extractionSettings().features?.pi === true })
const piEnabled = () => engineName === "native" && featureOn(extractionSettings(), "pi", { safeMode })
let stopPi: (() => void) | undefined
/** Virtual models user extensions register (`api.registerVirtualModel`), listed over the real models they route to; bound with the extensions. */
let extensionVirtualModels: (real: readonly ModelInfo[]) => ModelInfo[] = () => []
let virtualModelFallback: (model: string) => string = (model) => model
const realModels = (readOnly?: boolean): ModelInfo[] => [...codexModels(), ...(engineName === "native" ? providerService.models(readOnly) : []), ...(claudeProbed && claudeDetection.installed() ? claudeModels() : []), ...(engineName === "native" ? acpAgents.models() : []), ...(piEnabled() ? piConfig.models() : []), ...(engineName === "native" && threadMcpEnabled(extractionSettings(), "codex", safeMode) ? codexModels().map((model) => ({ ...model, id: `codex:${model.id}`, name: `${model.name} · Codex`, engine: "codex" as const })) : [])]
const modelCatalog: ModelCatalog = filteredCatalog({
  selectable: engineName === "native",
  list: (readOnly) => { const real = realModels(readOnly); return engineName === "native" ? [...real, ...extensionVirtualModels(real)] : real },
  ...(claudeProbed ? { refresh: claudeDetection.refresh } : {}),
  defaults: { model: NATIVE_DEFAULTS.model, effort: NATIVE_DEFAULTS.effort },
}, () => extractionSettings())
let stopClaude: (() => void) | undefined
let stopAcp: (() => void) | undefined

/** The model provider of the native engine: ids without a namespace use the ChatGPT subscription, `<provider>:<model>` ids go to that API-key provider. */
/**
 * A request the subscription backend has not answered at all after this long is retried at once. It answers in about a second; the slowest
 * first call of the official client in 36 runs took 7.1 s, and both requests that hit the earlier 30 s limit were answered in under 2 s when retried.
 */
const CHATGPT_HEADER_TIMEOUT_MS = 10_000
/** After the headers the backend sends `response.created` in the same second; a body with no byte for this long is retried at once. Later silence keeps the stream's own 120 s limit. */
const CHATGPT_FIRST_EVENT_TIMEOUT_MS = 20_000
function routedProvider(input: { onResponseHeaders?: (headers: Headers) => void } = {}) {
  const router = createProviderRouter({
    fallback: createResponsesProvider({
      id: NATIVE_DEFAULTS.providerId,
      model: NATIVE_DEFAULTS.model,
      effort: NATIVE_DEFAULTS.effort,
      baseUrl: CHATGPT_CODEX_BASE_URL,
      headers: subscriptionHeaders,
      headerTimeoutMs: CHATGPT_HEADER_TIMEOUT_MS,
      firstEventTimeoutMs: CHATGPT_FIRST_EVENT_TIMEOUT_MS,
      serviceTier: () => extractionSettings().serviceTier === "fast" ? "priority" : undefined,
      ...(input.onResponseHeaders ? { onResponseHeaders: input.onResponseHeaders } : {}),
    }),
    providers: () => providerService.runtime(),
  })
  return { ...router, async *stream(request: import("@mendcode/engine-native").ModelRequest) {
    // A virtual model that reached a request without a session (a per-turn pick, an auxiliary call) goes to its first real model, never to the network as is.
    if (request.model?.startsWith("virtual:")) request = { ...request, model: virtualModelFallback(request.model) }
    if (request.model?.startsWith("virtual:")) throw new Error("[PROVIDER]: virtual model has no real model available")
    if (!modelAllowed(request.model ?? router.model, extractionSettings())) throw new Error("[PROVIDER]: model is excluded from the catalog")
    yield* router.stream(request)
  } }
}

/** One tool-less completion (Dream, `/btw`), with the given model or the default one; a namespaced model uses its API-key provider. */
let completionTrace: import("@mendcode/protocol").TracePort | undefined
/** One Tree's memory of a session (set where it is built), dropped when the session is deleted. */
let forgetOneTree: ((sessionId: import("@mendcode/protocol").SessionId) => void) | undefined
async function completeWithUsage(input: { system: string; prompt: string; signal: AbortSignal; model?: ModelChoice | undefined; onText?(text: string): void }) {
  const span = completionTrace?.start("session.llm")
  let status: "ok" | "error" = "ok"
  let text = ""
  let usage: import("./budgets").BudgetUsage | undefined
  try {
    const provider = routedProvider()
    // An ACP agent runs whole sessions, not single completions: a session on one falls back to the default model here.
    const model = input.model && acpAgents.agentOf(input.model.model) === undefined ? usableEffort(input.model, modelCatalog) : undefined
    for await (const event of provider.stream({ system: input.system, messages: [{ role: "user", content: input.prompt }], tools: [], ...(model ? { model: model.model, effort: model.effort, parameters: model.parameters } : {}), signal: input.signal })) {
      if (event.type === "text") {
        text += event.delta
        input.onText?.(event.delta)
      }
      // A call may report usage more than once (cumulative); the last report is the total.
      if (event.type === "usage") usage = { provider: provider.idFor?.(model?.model) ?? provider.id, model: model?.model ?? provider.model, ...event.usage }
    }
    return { text, usage }
  } catch (error) { status = "error"; throw error }
  finally { span?.end(input.signal.aborted ? "cancelled" : status, usage ? { inputTokens: usage.input, outputTokens: usage.output } : {}) }
}
const complete = async (input: { system: string; prompt: string; signal: AbortSignal; model?: ModelChoice | undefined; onText?(text: string): void }) => (await completeWithUsage(input)).text

/** Dream's completion, with the dream role's model (the default one when unset) and the token counts its budget needs. */
let extractionSettings: () => import("@mendcode/protocol").Settings = () => ({})
const dreamComplete = (prompt: string, signal: AbortSignal, model?: ModelChoice) => completeWithUsage({ system: "You curate long-term memory for a coding assistant. Reply with JSON only.", prompt, signal, model })

/** The system prompt as named parts, so the engine can both join them and report each one's size. `memory` is the memory block for this prompt. */
function systemParts(root: string, memory: string, prompts: PromptFiles, modelID?: string, contextFiles = true): SystemPart[] {
  const skillBlock = skills.block(root)
  // SYSTEM.md replaces the packaged prompt, APPEND_SYSTEM.md follows as a part of its own; the project's files win over the user's.
  const parts = promptContextParts(dir, root, systemPartsWith({
    files: promptFileOverrides(dir, root, prompts),
    root,
    packaged: systemPrompt,
    rest: [
      { id: "instructions", label: "project instructions", text: contextFiles ? instructionsFor(root) : "" },
      { id: "skills", label: "skills", text: skillBlock, count: (skillBlock.match(/^- /gm) ?? []).length },
      { id: "memory", label: "memory", text: memory, count: (memory.match(/^- \[/gm) ?? []).length },
    ],
  }), { ...(modelID ? { modelID } : {}) })
  // `/output-style` is the user's explicit tone choice, so it applies in every prompt mode; `default` adds nothing.
  const chosenStyle = extractionSettings().outputStyle
  const style = outputStyleText(chosenStyle === "caveman" && !featureOn(extractionSettings(), "caveman") ? undefined : chosenStyle)
  return style ? [...parts, { id: "style", label: "output style", text: style }] : parts
}

// Only the selected engine's package is loaded (P5): codex and faux are not needed by a native daemon.
const createCodexEngine = engineName === "codex" ? (await import("@mendcode/engine-codex")).createCodexEngine : undefined
const createFauxEngine = engineName !== "native" && engineName !== "codex" ? (await import("@mendcode/engine-faux")).createFauxEngine : undefined

const otlp = otlpFromEnvironment(process.env)
/** The home whose other programs this daemon may read: the user's for the default data directory, a given one for tests, none for a private `--dir`. */
const foreignRoot = process.env.MENDCODE_FOREIGN_HOME || (dir === DEFAULT_DIR ? homedir() : undefined)
export const daemon = await startDaemon({
  ...(arg("http-listen") ? { httpListen: arg("http-listen")! } : {}),
  runtimeInfo: { version: packageJson.version, channel: packageJson.version.includes("beta") ? "beta" : packageJson.version.includes("dev") ? "dev" : "stable" },
  ...(arg("http-server") ? { http: JSON.parse(arg("http-server")!) } : {}),
  ...(argv.includes("--web") ? { web: HTTP_WEB } : {}),
  ...(hosting.log ? { log: hosting.log } : {}),
  release: { version: packageJson.version },
  trace: argv.includes("--trace") || process.env.MENDCODE_TRACE === "1",
  ...(otlp ? { otlp } : {}),
  ...(arg("mflow-listen") ? { mflowListen: arg("mflow-listen")! } : {}),
  ...(arg("log-level") ? { logLevel: logLevel(arg("log-level"))! } : {}),
  ...remoteOptions,
  defaultDirectory: cwd,
  dir,
  socketPath,
  // On-device dictation (macOS): `/voice` listens through Apple's speech model, free and without a key (docs/voice.md).
  voice: { local: createLocalDictation({ dir }) },
  // Everything this process starts (engines, MCP servers, hooks) is not the user at a terminal (docs/permissions.md).
  agentOrigin: { descendants: true },
  ...(arg("local-transport") ? { localTransport: arg("local-transport") as "tcp" | "unix" } : {}),
  ...(argv.includes("--pure") || safeMode ? { extensionsEnabled: false } : {}),
  ...(safeMode ? { safeMode: true, shellHooksEnabled: false } : {}),
  // ~/.agents and ~/.claude are read only by a daemon on the default data directory (or one told where home is), so a private --dir stays self-contained.
  // The same rule for the chats other programs keep (`threads`): only the daemon on the default data directory reads them.
  ...(foreignRoot ? { foreignThreads: { homes: { claude: process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(foreignRoot, ".claude"), codex: process.env.CODEX_HOME?.trim() || path.join(foreignRoot, ".codex") }, v1Db: path.join(process.env.MENDCODE_FOREIGN_HOME ? path.join(foreignRoot, ".local", "share") : process.env.XDG_DATA_HOME?.trim() || path.join(foreignRoot, ".local", "share"), "mendcode", "mendcode-local.db") } } : {}),
  ...(process.env.MENDCODE_FOREIGN_HOME ? { foreignHome: process.env.MENDCODE_FOREIGN_HOME } : dir === DEFAULT_DIR ? { foreignHome: homedir() } : {}),
  ...(process.env.MENDCODE_REASONING_ENDPOINT && process.env.MENDCODE_REASONING_TOKEN ? { reasoningEvaluator: createLoopbackJevEvaluator({ endpoint: process.env.MENDCODE_REASONING_ENDPOINT, token: process.env.MENDCODE_REASONING_TOKEN }) } : {}),
  codegraphStatus,
  ...(codeIndexer ? { codeOverview: createCodeOverview({ indexer: codeIndexer }) } : {}),
  ...(codeGate ? { codeGate } : {}),
  // Quota refresh (docs/usage-limit.md): how each provider's windows can be asked for. Nothing runs unless the user's `quotaRefresh` lists the provider.
  quotaRefresh: {
    probes: engineName === "native"
      ? {
          codex: nativeCodexProbe({ provider: (onHeaders) => routedProvider({ onResponseHeaders: onHeaders }), models: () => codexModels(), now: Date.now }),
          claude: async (input) => {
            await claudeDetection.refresh()
            if (!claudeDetection.installed()) throw new Error("[PROBE]: Claude Code is not installed")
            await claudeCodeProbe({ bin: claudeBin, dataDir: dir })(input)
          },
        }
      : engineName === "codex" ? { codex: codexAppServerProbe({ bin: process.env.MENDCODE_CODEX_BIN || "codex", dataDir: dir }) } : {},
  },
  // `/tier computer on` (features.computer) switches it on while the daemon runs; the environment variable still does at start.
  computer: { enabled: process.env.MENDCODE_COMPUTER === "1" ? true : () => extractionSettings().features?.computer === true },
  browser: { enabled: process.env.MENDCODE_BROWSER === "1", ...(process.env.MENDCODE_BROWSER_PATH ? { executable: process.env.MENDCODE_BROWSER_PATH } : {}) },
  engine: ({ notify, engineBackground, engineAgentEvent, trace, continuity, tasks, clock, store, grants, runLimits, sessionRules, emitGlobal, secrets, memory, background, interactive, workflows, peers, threads, packages, sessionMeta, loops, worktrees, prWatch, goals, review, customTools, extensionLayers, agents, plans, extensions, skills: skillLoader, recall, computer, browser, harness, compound, budget, aiConfig, inlineShell, reasoning, settingsWrite }) => {
    extensionProviders = () => extensions.transportProviders()
    extensionMcpServers = (directory) => extensions.mcpServers(directory)
    extensionVirtualModels = (real) => extensions.virtualModels(real)
    virtualModelFallback = (model) => extensions.routeModel({ model }, { sessionId: "", cwd: "", role: "main" }, modelCatalog.list()).model
    // `promptCacheTtl` and the `wait_cache` feature (docs/prompt-cache.md): the lifetime a native call asks Anthropic for.
    const cacheTtl = createCacheTtl({
      clock,
      settings: () => store.settings.get(),
      learns: () => featureOn(store.settings.get(), "wait_cache", { safeMode }),
      provider: (id) => providerService.list(true).find((provider) => provider.id === id),
    })
    const sessionSandbox = ({ sessionId, cwd: root }: { sessionId: Parameters<typeof store.sessionDirectory>[0]; cwd: string }) => {
      const settings = store.settings.get()
      const writableRoots = [...(settings.sandbox?.writableRoots ?? []), ...declaredRoots(settings.additionalDirectories, runLimits.get(sessionId)?.addDirs)]
      return sandboxPolicy({ config: { ...settings.sandbox, writableRoots }, cwd: root })
    }
    // Sessions sharing one checkout (docs/one-tree.md): every engine reports what its calls wrote and read, one shared memory.
    const oneTree = createOneTree({ now: () => clock.now(), enabled: () => featureOn(store.settings.get(), "one_tree", { safeMode }), title: (writer) => {
      // `<session>#<agent>`: one of Claude Code's sub-agents in that session.
      const [sessionId, agent] = writer.split("#") as [typeof writer, string | undefined]
      const title = store.sessionInfo(sessionId)?.title?.trim()
      return agent ? `a sub-agent${title ? ` of «${title.slice(0, 30)}»` : ""}` : title
    } })
    completionTrace = trace
    forgetOneTree = oneTree.forget
    extractionSettings = () => store.settings.get()
    layersFor = extensionLayers
    skills = skillLoader
    // Memories are ranked for the session's latest prompt (full-text matches, recency, links; pinned always in) instead of all being injected.
    const memorySelector = createMemorySelector(memory, { settings: (directory) => memorySettings(store.settings.get(), directory) })
    const memoryFor = (root: string, context: SystemContext | undefined) => memorySelector.block({ directory: root, prompt: context?.prompt ?? "", ...(context ? { sessionId: context.sessionId } : {}) })
    // No search key: the subscription's own search endpoint answers with the login the engine already uses (MENDCODE_WEB_SEARCH=0 turns it off).
    const subscriptionSearch = process.env.MENDCODE_WEB_SEARCH === "0" ? undefined : {
      baseUrl: CHATGPT_CODEX_BASE_URL,
      headers: subscriptionHeaders,
      model: () => NATIVE_DEFAULTS.model,
      available: subscriptionLogin,
    }
    const keyedTools = [createWebSearchTool(subscriptionSearch ? { subscription: subscriptionSearch } : {})].filter((tool): tool is Tool => tool !== undefined)
    // A Claude Code session (`host`) has no image tool of its own: the ChatGPT login or an OpenAI key makes image_gen work there unconfigured,
    // as the hosted `image_generation` does for a native session. MENDCODE_IMAGE_GEN=0 turns both off.
    const imageGenTool = (host = false) => createDaemonImageGenTool({ dir, settings: () => store.settings.get(), provider: routedProvider(), models: () => modelCatalog.list(), credentials: (id) => providerService.imageTransport?.(id), subscriptionHeaders, ...(host ? { implicit: () => process.env.MENDCODE_IMAGE_GEN !== "0" && (subscriptionLogin() || providerService.imageTransport?.("openai") !== undefined) } : {}) })
    const builtinTools = [...BUILTIN_TOOLS, ...keyedTools, createDiagnosticsTool(lsp), questionTool, todoTool, createSkillTool(skills, { docs: `${PROGRAM_NAME} docs skills` }), createRememberTool(memory.propose, memory), createMemoryGraphTool(memory), createToolDefine({ userDir: dir }), workflowStartTool, workflowScriptTool, workflowStatusTool, createSidebarTool(dir, (directory, widgets) => emitGlobal({ type: "sidebar.changed", ...(directory ? { directory } : {}), widgets })), sessionsTool, tellTool, threadsTool, packagesTool, sessionMetaTool, loopTool, worktreeTool, prWatchTool, ...codeGraphTools, createLspTool(lsp), workflowSaveTool, workflowControlTool, workflowEventsTool, workflowArtifactsTool, aiConfigTool]
    // Extensions tell an override from a clash, and `api.builtinTool` wraps, by these.
    builtinTools.push(createCustomizeUiTool(dir, extensions.reload, emitGlobal))
    builtinTools.push(createExtendTool({ dir, extensions: { reload: extensions.reload, report: extensions.report, routeInput: extensions.routeInput, checkTool: extensionToolCheck(extensions) } }))
    builtinTools.push(createSettingsTool({ settings: () => store.settings.get(), check: (patch) => store.settings.check(patch), write: settingsWrite }))
    builtinTools.push(createMemoryTool(memory))
    // Interactive sessions need a pseudo-terminal: macOS and Linux under Bun, Windows only with MENDCODE_V2_CONPTY=1. Elsewhere the model only sees `shell`.
    if (ptyAvailable()) builtinTools.push(shellSession)
    // Registered wherever they can work; the feature `computer` (off until `/tier computer on`) keeps them out of the model's tool list.
    if (process.platform === "darwin" || process.env.MENDCODE_COMPUTER === "1") builtinTools.push(...createComputerTools())
    if (process.env.MENDCODE_BROWSER === "1") builtinTools.push(browserTool)
    extensions.setBuiltinTools(builtinTools)
    const mainModel = (sessionId: Parameters<typeof store.sessionModel>[0]) => resolveModel({ role: "main", session: store.sessionModel(sessionId), roles: rolesFor(store.settings.get(), store.sessionInfo(sessionId)?.directory), catalog: modelCatalog })
    /** The model one turn runs on: its per-turn override (already validated at submit) or the session's. */
    const turnModel = (sessionId: Parameters<typeof store.sessionModel>[0], override?: ModelChoice) => override ? usableEffort(override, modelCatalog) : mainModel(sessionId)
    const toolOutputs = createToolOutputs(dir, Date.now, store.writeStoredFile)
    // `/env` credentials for the engines that run their own tools; `engineEnvironment: false` keeps them native-only.
    const credentialsFor = (sessionId: Parameters<typeof store.sessionModel>[0]) => engineEnvironment({ enabled: store.settings.get().engineEnvironment !== false, values: () => secrets.environment?.(sessionId) ?? {} })
    const transcripts = createSessionTranscripts(dir, Date.now, store.writeStoredFile)
    const configured = engineName === "native"
      ? withAcpEngine({
          usesAcp: (sessionId, override) => acpAgents.agentOf(turnModel(sessionId, override).model) !== undefined,
          // Created on the first ACP turn only (P5). The agent's session id is kept per (session, agent) so a restart can resume it.
          acp: async () => {
            const engine = createAcpEngine({
              agents: acpAgents,
              agentFor: (sessionId, override) => acpAgents.agentOf(turnModel(sessionId, override).model),
              modelFor: (sessionId, override) => acpAgents.modelOf(turnModel(sessionId, override).model),
              onModels: acpAgents.learn,
              effortFor: (sessionId, override) => turnModel(sessionId, override).effort,
              onEfforts: acpAgents.learnEfforts,
              cwdFor: (sessionId) => store.sessionDirectory(sessionId) || cwd,
              environment: credentialsFor,
              hostServers: (sessionId) => harness.servers(sessionId),
              waitingForMcp: harness.waiting,
              bindings: {
                get: (sessionId, agent) => store.engineBindings.get(sessionId, `acp:${agent}`),
                set: (sessionId, agent, acpSessionId) => store.engineBindings.set(sessionId, `acp:${agent}`, acpSessionId),
              },
              clock,
              readBlob: async (ref) => new Uint8Array(store.readBlob(ref.sha256)),
              ...(process.env.MENDCODE_ACP_TRACE
                ? { trace: (direction: "in" | "out", line: string) => appendFileSync(process.env.MENDCODE_ACP_TRACE!, `${direction} ${line.trimEnd().slice(0, 2000)}\n`) }
                : {}),
            })
            stopAcp = () => engine.stop()
            return engine
          },
          base: createEngineRouter({
          usesClaude: (sessionId, override) => modelEngine(turnModel(sessionId, override), modelCatalog) === "claude",
          // Loaded on the first Claude Code turn only (P5).
          claude: async () => {
            const { createClaudeEngine, claudeCacheEnv } = await import("@mendcode/engine-claude")
            const terminalRendering = await loadTerminalRendering()
            const engine = createClaudeEngine({
              bin: claudeBin,
              clock,
              cwdFor: (sessionId) => store.sessionDirectory(sessionId) || cwd,
              // The minimal prompt mode adds nothing to any engine's prompt.
              // MendCode's native tools (code graph, computer use, memory, settings) through the daemon's loopback bridge.
              sessionArgs: (sessionId) => harness.args(sessionId),
              waitingForMcp: harness.waiting,
              subagentContext: (sessionId) => harness.instructions(sessionId),
              oneTree: oneTree.note,
              ownTools: `mcp__${HOST_MCP_SERVER}__`,
              appendSystem: (root) => (createPromptModes(dir).status(root).mode === "minimal" ? undefined : terminalRendering),
              // `/fast` reaches Claude Code on the models that have its fast mode; the process starts with it.
              modelFor: (sessionId, override) => { const turn = turnModel(sessionId, override); const choice = claudeAlias(turn); return (turn.fast ?? store.settings.get().serviceTier === "fast") && claudeFastModel(choice.model) ? { ...choice, fast: true } : choice },
              bindings: {
                get: (sessionId) => store.engineBindings.get(sessionId, "claude"),
                set: (sessionId, claudeSessionId) => store.engineBindings.set(sessionId, "claude", claudeSessionId),
              },
              onQuota: emitGlobal,
              notify,
              onBackground: engineBackground,
              // Why a session's Claude Code process ended: the trail for a background agent that stopped with it.
              onClose: (sessionId, reason, background) => logLine(`[CLAUDE]: ${sessionId} process ended: ${reason}${background ? `; ${background} background task${background === 1 ? "" : "s"} ended with it` : ""}`),
              onAgentEvent: engineAgentEvent,
              safetyPrompts: () => store.settings.get().engineSafetyPrompts,
              // `claudeCacheTtl` (opt-in): a `promptCacheTtl` of 1h is handed to the next Claude Code process as its documented variables.
              // The Agent tool's sub-agents: the `subagent` role when it is a Claude model, else Sonnet under Opus (`cheap_subagents`).
              env: (sessionId, model) => {
                const settings = store.settings.get()
                const subagent = claudeSubagentEnv({ model: model.model, subagent: rolesFor(settings, store.sessionDirectory(sessionId) || cwd).subagent, cheap: featureOn(settings, "cheap_subagents", { safeMode }), inherited: process.env.CLAUDE_CODE_SUBAGENT_MODEL })
                const cache = claudeCacheEnv(settings)
                // Compaction at MendCode's point (`claude_compact`), not near Claude Code's 1M window.
                const compact = claudeCompactEnv({ model: model.model, settings, on: featureOn(settings, "claude_compact", { safeMode }) })
                return cache || subagent || compact ? { ...cache, ...subagent, ...compact } : undefined
              },
              environment: credentialsFor,
              readBlob: async (ref) => new Uint8Array(store.readBlob(ref.sha256)),
              ...(process.env.MENDCODE_CLAUDE_TRACE
                ? { trace: (direction: "in" | "out", line: string) => appendFileSync(process.env.MENDCODE_CLAUDE_TRACE!, `${direction} ${line.trimEnd().slice(0, 2000)}\n`) }
                : {}),
            })
            stopClaude = () => engine.stop()
            return engine
          },
          primary: createNativeEngine({
          compound,
          reasoning,
          beforeModel: (request) => budget.guard(request),
          onMissingUsage: () => budget.record(),
          trace,
          provider: routedProvider({
            onResponseHeaders: (headers) => {
              const quota = chatgptQuota(headers, clock.now())
              if (quota) emitGlobal(quota)
            },
          }),
          tools: builtinTools.map((tool) => tool.name !== "webfetch" ? tool : { ...tool, execute: (args, context) => tool.execute(args, { ...context, ...(featureOn(extractionSettings(), "webfetch_modes", { safeMode }) ? { webfetchResources: createWebfetchResources(path.join(dir, "fetch")) } : {}) }) }),
          hooks: extensions.hooks,
          // The model sees ‹secret:N› markers only; tools get the value just before they run (docs/secrets.md).
          secrets,
          history: {
            load: async (sessionId) => {
              const messages = store.engineMessages.load(sessionId, "native") as ModelMessage[]
              return messages.length ? messages : undefined
            },
            save: async (sessionId, messages) => store.engineMessages.save(sessionId, "native", messages),
            replace: async (sessionId, messages) => store.engineMessages.replace(sessionId, "native", messages),
          },
          // COMPACTION.md (project over user) replaces the packaged compaction prompt.
          compactionPrompt: (root) => extensions.prompts.read(root).compaction ?? compactionPrompt,
          continuationPrompt,
          background,
          interactive,
          continuity,
          workflows,
          peers,
          threads,
          packages,
          sessionMeta,
          recall,
          computer,
          browser,
          loops,
          worktrees,
          prWatch,
          review,
          aiConfig,
          inlineShell,
          goals,
          // "Approve for this session" grants are shared with the daemon (permissions.list / permissions.revoke).
          grants,
          authorityAnchors: (sessionId) => store.permissionRecords.authorityAnchors(sessionId),
          // `smart` mode: extra allow-listed commands from settings; the reviewer runs only when the permissionReviewer role is set (off by default).
          permissionAllow: () => store.settings.get().permissionAllow,
          smartSandboxTrust: () => store.settings.get().smartSandboxTrust,
          // The tier's effects (tools of a feature that is off, flags a feature carries) are applied here, never stored.
          permissionPolicy: () => effectiveSettings(store.settings.get(), { safeMode }),
          memoryAlways: () => emitGlobal({ type: "settings.changed", settings: store.settings.set({ memoryRequireApproval: false }) }),
          memorySettings: (sessionId) => memorySettings(store.settings.get(), store.sessionDirectory(sessionId)),
          permissionReviewer: createPermissionReviewer({
            complete: async (request) => {
              await budget.guard({ model: request.model?.model ?? modelCatalog.defaults.model, signal: request.signal })
              try {
                const answer = await completeWithUsage(request)
                budget.record(answer.usage)
                return answer.text
              } catch (error) { budget.record(); throw error }
            },
            modelFor: (sessionId) => {
              const settings = store.settings.get()
              const choice = rolesFor(settings, store.sessionInfo(sessionId)?.directory)[settings.permissionReviewerRole ?? "permissionReviewer"]
              return choice && !invalidChoice(choice, modelCatalog, "permissionReviewer") ? choice : undefined
            },
          }),
          // A virtual model (`api.registerVirtualModel`) is answered here with the real model its route picks for this call.
          modelFor: (sessionId, role) => {
            const choice = tasks.isChild(sessionId) && store.sessionModel(sessionId) ? usableEffort(store.sessionModel(sessionId)!, modelCatalog) : resolveModel({ role, session: store.sessionModel(sessionId), roles: rolesFor(store.settings.get(), store.sessionInfo(sessionId)?.directory), catalog: modelCatalog })
            return choice.model.startsWith("virtual:") ? usableEffort(extensions.routeModel(choice, { sessionId, cwd: store.sessionDirectory(sessionId) ?? "", role }, modelCatalog.list()), modelCatalog) : choice
          },
          subagents: true,
          tasks,
          // Custom agents (`agents/*.md`): the session's selected one and the sub-agents `task` can name; their model is checked against the catalog's efforts.
          agents,
          plans,
          agentModel: (choice) => usableEffort(choice, modelCatalog),
          // `promptCache` setting: legacy (unset), off or smart (docs/prompt-cache.md).
          promptCache: () => store.settings.get().promptCache,
          cacheTtl: cacheTtl.ttlFor,
          shell: (sessionId) => shellFor(store.settings.get(), sessionId ? store.sessionDirectory(sessionId) : undefined),
          // `shellEnvironment`, `shellCommandPrefix`, `loginShell` and `web` settings (docs/resources-config.md): read per call, so a change applies to the next command.
          shellSettings: () => {
            const settings = store.settings.get()
            return { environment: settings.shellEnvironment, policy: { prefix: settings.shellCommandPrefix, login: settings.loginShell }, dataDir: path.resolve(dir) }
          },
          web: () => store.settings.get().web,
          sessionRules,
          // OS sandbox (`sandbox` setting): off unless the user turned it on with /sandbox.
          // Declared extra directories (`additionalDirectories`, `--add-dir`) are writable too, so approving a command there is not defeated by the sandbox.
          sandbox: sessionSandbox,
          toolOutput: () => toolOutputSettings(store.settings.get(), safeMode),
          saveToolOutput: toolOutputs.save,
          cacheConfig: (sessionId) => cacheConfigFor(store.settings.get(), store.sessionDirectory(sessionId) ?? process.cwd()),
          projectTools: async (root, sessionId, scope) => {
            const image = imageGenTool(scope?.host === true)
            const mcpOn = mcpAllowed()
            return [...(image ? [image] : []), ...(mcpOn ? await mcpTools(mcp, root).catch(() => []) : []), ...(mcpOn ? await mcpResourceTools({ manager: mcp, directory: root }).catch(() => []) : []), ...(safeMode ? [] : await customTools.tools(root).catch(() => [])), ...(await extensions.tools(root, sessionId).catch(() => []))]
          },
          afterWrite,
          lateWriteNotes: afterWrite.late,
          oneTree: oneTree.note,
          // The subscription backend runs web search itself: no API key, no local process. MENDCODE_WEB_SEARCH=0 turns it off.
          // The provider-run web search is offered only when no `websearch` tool is registered: the model needs one way to search, and the hosted one has been failing.
          hostedTools: () => [...(process.env.MENDCODE_WEB_SEARCH === "0" || keyedTools.length ? [] : (["web_search"] as const)), ...(process.env.MENDCODE_IMAGE_GEN === "0" ? [] : (["image_generation"] as const))],
          blobPath: (ref) => store.blobPath(ref.sha256),
          // Env wins for testing; then the model's `modelContext.compactAt`; then the user's setting; otherwise the engine default.
          compactAtTokens: (_sessionId, model) => {
            const settings = store.settings.get()
            return globalTrigger(settings, process.env, modelContextOf(settings, model ? findModel(modelCatalog.list(), model) : undefined)?.compactAt).tokens
          },
          compaction: () => store.settings.get().compaction,
          transcript: (input) => transcripts.save(input),
          readStoredFile: store.readStoredFile,
          contextWindowFor: (sessionId) => modelCatalog.list().find((model) => model.id === mainModel(sessionId).model)?.contextWindow,
          contextWindowOverrideFor: (sessionId, model) => windowOverride({ meta: store.meta, sessionId, model: model ? findModel(modelCatalog.list(), model) : undefined, settings: store.settings.get() })?.tokens,
          cwdFor: (sessionId) => store.sessionDirectory(sessionId) || cwd,
          // `read` and `@file` load nearby instructions by the same rules (names, root markers, includes) as the system prompt.
          instructions: instructionControls(() => store.settings.get()),
          readBlob: async (ref) => new Uint8Array(store.readBlob(ref.sha256)),
          // Tool images (screenshots): bytes go to the blob store, history keeps the ref, and the session owns it so cleaning keeps it.
          storeBlob: async (bytes, mime, sessionId) => {
            const ref = store.putBlob(bytes, mime)
            store.refBlob(ref, sessionId)
            return ref
          },
          runLimits: (sessionId) => runLimits.get(sessionId),
          hiddenTools: hiddenGraphTools,
          system: (root, context) => systemWithLimits(joinSystemParts(systemParts(root, memoryFor(root, context), extensions.prompts, context ? mainModel(context.sessionId).model : undefined, context ? runLimits.get(context.sessionId)?.noContextFiles !== true : true)), context ? runLimits.get(context.sessionId) : undefined),
          systemParts: (root, context) => {
            const limits = context ? runLimits.get(context.sessionId) : undefined
            const parts = systemParts(root, memoryFor(root, context), extensions.prompts, context ? mainModel(context.sessionId).model : undefined, limits?.noContextFiles !== true)
            return limits?.systemPrompt !== undefined || limits?.appendSystemPrompt ? [{ id: "run", label: "scripted run prompt", text: systemWithLimits(joinSystemParts(parts), limits) }] : parts
          },
        }),
        }),
        })
      : engineName === "codex"
      ? createCodexEngine!({
          cwd,
          clock,
          bindings: {
            get: (sessionId) => store.engineBindings.get(sessionId, "codex"),
            set: (sessionId, threadId) => store.engineBindings.set(sessionId, "codex", threadId),
          },
          onQuota: emitGlobal,
          ...(process.env.MENDCODE_CODEX_TRACE
            ? { trace: (direction, line) => appendFileSync(process.env.MENDCODE_CODEX_TRACE!, `${direction} ${line.trimEnd().slice(0, 2000)}\n`) }
            : {}),
        })
      : createFauxEngine!({ clock })
    if (engineName !== "native") return configured
    // pi is created on the first turn of a session on a pi model (P5); its version, read then, decides which of its events to rely on.
    let piCapabilitiesNow = piCapabilities(undefined)
    const withCodex = withCodexEngine({
      base: configured,
      usesCodex: (sessionId, override) => modelEngine(turnModel(sessionId, override), modelCatalog) === "codex",
      create: async (turn) => {
        const { createCodexEngine } = await import("@mendcode/engine-codex")
        const model = turnModel(turn.sessionId, turn.selection?.model)
        return createCodexEngine({
          cwd: store.sessionDirectory(turn.sessionId) || cwd, clock, model: model.model.slice("codex:".length), ...(model.effort ? { effort: model.effort } : {}), ...((model.fast ?? store.settings.get().serviceTier === "fast") ? { fast: true } : {}),
          bindings: { get: (id) => store.engineBindings.get(id, "codex"), set: (id, thread) => store.engineBindings.set(id, "codex", thread) },
          onQuota: emitGlobal,
          environment: credentialsFor(turn.sessionId),
          storeImage: async (bytes, mime, sessionId) => {
            const ref = store.putBlob(bytes, mime)
            store.refBlob(ref, sessionId)
            return ref
          },
        })
      },
    })
    return withPiEngine({
      base: withCodex,
      usesPi: (sessionId, override) => piEnabled() && modelEngine(turnModel(sessionId, override), modelCatalog) === "pi",
      pi: async (sessionId) => {
        const resolved = piConfig.resolved()
        const sandbox = sessionSandbox({ sessionId, cwd: store.sessionDirectory(sessionId) || cwd })
        const probe = await probePi({ command: resolved.command, env: resolved.env, ...(sandbox ? { sandbox } : {}) })
        if (!probe.ok) throw new Error(`pi --version did not answer; check the sandbox, install pi or set "command" in pi.json`)
        piCapabilitiesNow = probe.capabilities
        const engine = createPiEngine({
          config: piConfig,
          modelFor: (sessionId, override) => turnModel(sessionId, override),
          cwdFor: (sessionId) => store.sessionDirectory(sessionId) || cwd,
          environment: credentialsFor,
          projectTrusted: (root) => (store.settings.get().trustedToolDirs ?? []).some((entry) => canonicalDir(entry) === canonicalDir(root)),
          sandbox: sessionSandbox,
          permissionFor: (sessionId) => store.permissionModeOf(sessionId),
          smartBash: ({ sessionId, cwd: root, args }) => {
            const settings = store.settings.get()
            return classifySmart({ tool: { name: "shell", permission: "execute" }, args, cwd: root, extraRoots: declaredRoots(settings.additionalDirectories, runLimits.get(sessionId)?.addDirs), ...(settings.permissionAllow ? { allowCommands: settings.permissionAllow } : {}) }).decision
          },
          capabilities: () => {
            const current = piConfig.resolved()
            // Capability evidence belongs to the probed executable/environment, never a replacement from pi.json.
            return current.command === resolved.command && JSON.stringify(current.env) === JSON.stringify(resolved.env) ? piCapabilitiesNow : piCapabilities(undefined)
          },
          bindings: {
            get: (sessionId) => store.engineBindings.get(sessionId, "pi"),
            set: (sessionId, sessionFile) => store.engineBindings.set(sessionId, "pi", sessionFile),
          },
          clock,
          readBlob: async (ref) => new Uint8Array(store.readBlob(ref.sha256)),
          ...(process.env.MENDCODE_PI_TRACE
            ? { trace: (direction: "in" | "out", line: string) => appendFileSync(process.env.MENDCODE_PI_TRACE!, `${direction} ${line.trimEnd().slice(0, 2000)}\n`) }
            : {}),
        })
        stopPi = () => engine.stop()
        return engine
      },
    })
  },
  clock: realClock,
  buildId: computeBuildId(),
  info: {
    engine: engineName,
    ...(engineName === "native" ? { model: NATIVE_DEFAULTS.model, effort: NATIVE_DEFAULTS.effort } : {}),
    ...(engineName === "native"
      ? {
          login: async () => {
            try {
              const owned = providerAuth.chatgpt.status()
              if (owned.error) return { ok: false, message: owned.error }
              if (owned.source === "v2") return { ok: owned.state === "authorized", ...(owned.state !== "authorized" ? { message: `ChatGPT login ${owned.state}` } : {}) }
              await codexSubscriptionHeaders()()
              return { ok: true }
            } catch (error) {
              return { ok: false, message: error instanceof Error ? error.message : String(error) }
            }
          },
        }
      : {}),
  },
  mcp,
  lsp,
  lspInstall: ({ server, cwd }) => installLspServer({ id: server, cwd, cacheDir: path.join(dir, "lsp") }),
  formatter,
  models: modelCatalog,
  ...(engineName === "native" ? { providers: providerService, providerAuth } : {}),
  ...(engineName === "native" ? { dream: { complete: dreamComplete }, complete, setupComplete: completeWithUsage,
    extractMemory: async (job, signal, onUsage) => {
      const result = await dreamComplete(memoryExtractionPrompt(job.text), signal, resolveModel({ role: "memoryExtractor", roles: rolesFor(extractionSettings(), job.directory), catalog: modelCatalog }))
      if (typeof result !== "string" && result.usage) onUsage?.(result.usage)
      const text = typeof result === "string" ? result : result.text
      const parsed = JSON.parse(text.replace(/^```(?:json)?\s*|\s*```$/g, ""))
      if (!Array.isArray(parsed.memories) || parsed.memories.length > 20) throw new Error("Invalid extraction result")
      return parsed.memories.map((entry: unknown) => {
        if (typeof entry !== "object" || !entry) throw new Error("Invalid extracted memory")
        const memory = entry as Record<string, unknown>
        if (!["project", "user"].includes(String(memory.scope)) || typeof memory.text !== "string" || !memory.text.trim() || memory.text.length > 2_000 || typeof memory.category !== "string") throw new Error("Invalid extracted memory")
        return { scope: memory.scope as "project" | "user", text: memory.text, category: memory.category }
      })
    },
  } : {}),
  usageProfile: () => readUsageProfile(),
  listPrice: (provider, model) => {
    // A subscription's work is priced at its vendor's API price: models.dev lists the API, not the plan.
    const cost = modelsDev.facts(LIST_PRICE_VENDOR[provider] ?? provider, model)?.cost
    return cost ? { input: cost.input, output: cost.output, cacheRead: cost.cache_read, cacheWrite: cost.cache_write } : undefined
  },
  // A daemon a terminal started detached leaves once nothing needs it; the user service and a foreground `daemon run` stay.
  ...(hosting.active || process.stdout.isTTY || runsAsUserService(process.env) ? {} : { idleExitMs: DETACHED_IDLE_EXIT_MS }),
  onSessionRemoved: (sessionId) => forgetOneTree?.(sessionId),
  onShutdown: () => {
    stopClaude?.()
    stopAcp?.()
    stopPi?.()
    void Promise.allSettled([mcp.stop(), lsp.stop(), formatter.stop()]).finally(() => hosting.active ? hosting.onStopped?.() : process.exit(0))
  },
})
// A host owns the terminal and the signals; only a process that is the daemon prints the ready line and exits on SIGINT/SIGTERM.
if (!hosting.active) process.stdout.write(`${JSON.stringify({ ready: true, pid: process.pid, socketPath, transport: daemon.localEndpoint ? "tcp" : "unix", engine: engineName })}\n`)

for (const signal of hosting.active ? [] : ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    // MCP children (and their process groups), Claude Code, ACP agent and pi processes never outlive the daemon.
    stopClaude?.()
    stopAcp?.()
    stopPi?.()
    void Promise.allSettled([daemon.stop(), mcp.stop(), lsp.stop(), formatter.stop()]).then(() => process.exit(0))
  })
}

/** Stops the daemon and every child it started: MCP servers and their process groups, language servers, formatters, Claude Code, ACP agent and pi engines. */
export async function stopDaemon() {
  stopClaude?.()
  stopAcp?.()
  stopPi?.()
  await Promise.allSettled([daemon.stop(), mcp.stop(), lsp.stop(), formatter.stop()])
}
