import { existsSync } from "fs"
import { appendFile, chmod, mkdir, readFile, writeFile } from "fs/promises"
import path from "path"
import { mendPaths } from "../config/paths"
import { resolveModelRoles } from "../config/models"
import { readPromptMode } from "../prompt/mode"
import { composePromptPolicy } from "../prompt/compose"
import { aiEnvStatus, providerAuthStatus } from "./readiness"
import { budgetEnforcementStatus } from "./budget"
import { runProviderAdapter, runSupportStatus } from "./provider-adapters"

type RunArgs = {
  dryRun: boolean
  json: boolean
  sessionID: string
  promptMode: string | null
  focusID: string | null
  prompt: string
}

export function parseRunArgs(args: string[], commandName: "run" | "chat"): RunArgs {
  const flags: RunArgs = { dryRun: false, json: false, sessionID: "default", promptMode: null, focusID: null, prompt: "" }
  const rest: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "--dry-run") flags.dryRun = true
    else if (arg === "--json") flags.json = true
    else if (arg === "--session") {
      const value = args[++i]
      if (!value) throw new Error(`Usage: mend ${commandName} [--json] [--dry-run] [--session <id>] <message>`)
      flags.sessionID = value
    } else if (arg === "--prompt-mode") {
      const value = args[++i]
      if (!value) throw new Error(`Usage: mend ${commandName} [--prompt-mode minimal|focus|full] <message>`)
      flags.promptMode = value
    } else if (arg === "--focus") {
      const value = args[++i]
      if (!value) throw new Error(`Usage: mend ${commandName} [--focus <id>] <message>`)
      flags.focusID = value
    } else rest.push(arg)
  }
  return { ...flags, prompt: rest.join(" ").trim() }
}

function redactedTextInfo(text: string, limit = 120) {
  return {
    bytes: Buffer.byteLength(text || ""),
    preview: (text || "").length > limit ? `${text.slice(0, limit - 3)}...` : text || "",
    storedFullText: false,
  }
}

export async function buildRunPlan(input: { prompt: string; dryRun: boolean; promptMode?: string | null; focusID?: string | null; root?: string }) {
  const paths = mendPaths(input.root)
  const resolved = await resolveModelRoles(paths.root)
  const envStatus = await aiEnvStatus(paths.root)
  const providerID = (resolved.roles.default as any)?.providerID || null
  const modelID = (resolved.roles.default as any)?.modelID || null
  const authMode = (resolved.roles.default as any)?.authMode || null
  const [authStatus, budgetGate, persistedPromptMode] = await Promise.all([
    providerAuthStatus(providerID, modelID, { authMode }, paths.root),
    budgetEnforcementStatus({ providerID, modelID, authMode }, paths.root),
    readPromptMode(paths.root),
  ])
  const support = await runSupportStatus({ providerID, modelID, authMode: authStatus.authMode || authMode, root: paths.root })
  const promptMode = input.promptMode || persistedPromptMode.mode
  const promptPolicy = await composePromptPolicy({ root: paths.root, mode: promptMode, focusID: input.focusID || resolved.focus || "codex", modelID })
  return {
    mode: input.dryRun ? "dry-run" : "blocked-real-run",
    promptPreview: redactedTextInfo(input.prompt).preview,
    promptBytes: Buffer.byteLength(input.prompt),
    selected: {
      providerID,
      modelID,
      runtimeModel: resolved.defaultModel,
    },
    ready: resolved.enabled && Boolean(resolved.defaultModel) && envStatus.defaultReady,
    blockers: [
      ...(resolved.enabled ? [] : [".mendcode/models.yaml enabled=false"]),
      ...(resolved.defaultModel ? [] : ["roles.default providerID/modelID is not configured"]),
      ...(((envStatus.roles as any).default?.missingEnv || []) as string[]).map((key) => `missing env:${key}`),
      ...((authStatus.blockers || []) as string[]).filter((blocker) => !(((envStatus.roles as any).default?.missingEnv || []) as string[]).some((key) => blocker === `missing env:${key}`)),
      ...(support.supported ? [] : [support.reason]),
      ...(budgetGate.blockers || []),
    ],
    warnings: [...(budgetGate.warnings || [])],
    auth: authStatus,
    runSupport: support,
    budgetGate,
    promptPolicy: {
      mode: promptPolicy.mode,
      focusID: promptPolicy.focusID,
      instructionsBytes: promptPolicy.instructionsBytes,
      instructionsPreview: promptPolicy.instructionsPreview,
      policyInstructionsBytes: promptPolicy.policyInstructionsBytes,
      basePromptSource: promptPolicy.basePromptSource,
      basePromptBytes: promptPolicy.basePromptBytes,
      usesOpenCodeGenericProviderPrompt: promptPolicy.usesOpenCodeGenericProviderPrompt,
      usesMendCodeHarnessPrompt: promptPolicy.usesMendCodeHarnessPrompt,
      fallbackReason: promptPolicy.fallbackReason,
      includeProjectInstructions: promptPolicy.includeProjectInstructions,
      includeSkillsByDefault: promptPolicy.includeSkillsByDefault,
      includeCustomInstructions: promptPolicy.includeCustomInstructions,
      includeMcpContext: promptPolicy.includeMcpContext,
      sections: promptPolicy.sections.map((section) => ({
        id: section.id,
        label: section.label,
        source: section.source,
        bytes: section.bytes,
        preview: section.preview,
      })),
      source: promptPolicy.source,
      persistedModeUsed: !input.promptMode,
    },
    instructions: promptPolicy.instructions,
    wouldCallProvider: !input.dryRun && support.supported,
    wouldRunDonorRuntime: false,
    secretsPrinted: false,
    next: "Configure models/auth first; then run `mend run <prompt>`.",
  }
}

export function redactedRunPlanOutput(plan: any) {
  const { instructions, ...publicPlan } = plan
  return {
    ...publicPlan,
    instructionsBytes: Buffer.byteLength(instructions || ""),
    printsFullPrompt: false,
  }
}

function chatSessionID(raw: string) {
  const value = String(raw || "default").trim()
  if (!/^[a-zA-Z0-9_.-]+$/.test(value)) throw new Error("Chat session id may contain only letters, numbers, dot, underscore, and dash.")
  return value
}

function chatSessionPath(root: string, sessionID: string) {
  return path.join(mendPaths(root).mendDir, "runs", "chat", `${chatSessionID(sessionID)}.json`)
}

export async function readChatSession(sessionID: string, root?: string) {
  const paths = mendPaths(root)
  const file = chatSessionPath(paths.root, sessionID)
  if (!existsSync(file)) {
    return {
      version: 0,
      id: chatSessionID(sessionID),
      createdAt: new Date().toISOString(),
      updatedAt: null,
      messages: [],
      telemetry: { runs: 0, totalTokens: 0, estimatedUsd: 0, estimatedUsdAvailableRuns: 0 },
      storage: { path: path.relative(paths.root, file), ignoredByGit: true, storesFullLocalTranscript: true },
    }
  }
  return JSON.parse(await readFile(file, "utf8"))
}

export async function writeChatSession(session: any, root?: string) {
  const paths = mendPaths(root)
  const file = chatSessionPath(paths.root, session.id)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 })
}

export async function appendRunHistory(record: any, root?: string) {
  const file = mendPaths(root).runHistory
  await mkdir(path.dirname(file), { recursive: true })
  await appendFile(file, `${JSON.stringify(record)}\n`, { mode: 0o600 })
  await chmod(file, 0o600)
  return file
}

export function transcriptPrompt(messages: Array<{ role: string; content: string }>) {
  return messages.map((message) => `${message.role.toUpperCase()}: ${message.content}`).join("\n\n")
}

export function accumulateSessionTelemetry(session: any, telemetry: any) {
  const normalized = telemetry?.usageNormalized
  const cost = telemetry?.cost
  session.telemetry ||= { runs: 0, totalTokens: 0, estimatedUsd: 0, estimatedUsdAvailableRuns: 0 }
  session.telemetry.runs++
  if (normalized?.available) session.telemetry.totalTokens += normalized.totalTokens || 0
  if (cost?.available && typeof cost.estimatedUsd === "number") {
    session.telemetry.estimatedUsd += cost.estimatedUsd
    session.telemetry.estimatedUsdAvailableRuns++
  }
}

export function safeRunRecord({ plan, result, prompt }: { plan: any; result: any; prompt: string }) {
  return {
    version: 0,
    id: `run-${new Date().toISOString().replaceAll(":", "-")}-${Math.random().toString(36).slice(2, 8)}`,
    startedAt: new Date(Date.now() - (result.telemetry?.elapsedMs || 0)).toISOString(),
    endedAt: new Date().toISOString(),
    ok: result.ok === true,
    status: result.status,
    selected: plan.selected,
    prompt: {
      bytes: Buffer.byteLength(prompt),
      preview: prompt.length > 120 ? `${prompt.slice(0, 117)}...` : prompt,
      storedFullText: false,
    },
    output: {
      bytes: Buffer.byteLength(result.outputText || ""),
      preview: (result.outputText || "").length > 240 ? `${result.outputText.slice(0, 237)}...` : result.outputText || "",
      storedFullText: false,
    },
    telemetry: result.telemetry || null,
    wouldRunDonorRuntime: false,
    secretsPrinted: false,
  }
}

export async function executeRunPlan(input: { plan: any; prompt: string; messages?: any[]; root?: string }) {
  const paths = mendPaths(input.root)
  const result = await runProviderAdapter(paths.root, {
    providerID: input.plan.selected.providerID,
    modelID: input.plan.selected.modelID,
    authMode: input.plan.runSupport.authMode,
    prompt: input.prompt,
    messages: input.messages,
    instructions: input.plan.instructions,
  })
  const record = safeRunRecord({ plan: input.plan, result, prompt: input.prompt })
  await appendRunHistory(record, paths.root)
  return { result, record }
}
