import { mkdir, readdir, readFile, writeFile } from "fs/promises"
import { existsSync } from "fs"
import path from "path"
import { memoryPaths, readMemoryConfig } from "./config"
import { memoryExtractorFailureReason, proposeMemory, readMemoryExtractorContext, type MemoryProposal } from "./proposals"
import { resolveModelRoles } from "../config/models"
import { providerAuthStatus } from "../runtime/readiness"
import { runProviderAdapter } from "../runtime/provider-adapters"

export type MemorySideChatMessage = {
  id: string
  role: "user" | "assistant"
  text: string
  createdAt: string
}

const MEMORY_SIDE_CHAT_ACTION_KINDS = [
  "propose-memory",
  "propose-policy",
  "explain-state",
  "dream-dry-run",
  "create-memory",
  "edit-memory",
  "delete-memory",
  "move-memory",
  "create-category",
  "edit-category",
  "delete-category",
] as const

export type MemorySideChatActionKind = typeof MEMORY_SIDE_CHAT_ACTION_KINDS[number]

export type MemorySideChatAction = {
  kind: MemorySideChatActionKind
  text: string
  categoryIDs?: string[]
  scope?: "project" | "global"
  targetID?: string
  targetScope?: "project" | "global"
  categoryID?: string
}

export type MemorySideChatSession = {
  id: string
  root: string
  selectedWorkspaceID: string | null
  selectedGroupID: string | null
  selectedCategoryID: string | null
  history: MemorySideChatMessage[]
  status: "idle" | "running" | "canceled"
  proposals: string[]
  updatedAt: string
}

export type MemorySideChatResponder = (input: {
  message: string
  history: MemorySideChatMessage[]
  context: Pick<MemorySideChatSession, "selectedWorkspaceID" | "selectedGroupID" | "selectedCategoryID">
    & { pageContext?: string | null }
  connectedProviderIDs?: readonly string[]
  signal?: AbortSignal
}) => Promise<{ text: string; actions?: MemorySideChatAction[] }>

export type MemoryAssistantRoleResult =
  | {
      ok: true
      roleName: string
      providerID: string
      modelID: string
      authMode: string
      runner?: "adapter" | "runtime-provider"
    }
  | {
      ok: false
      reason: string
    }

export type MemoryAssistantRuntimeRolesResult =
  | {
      ok: true
      roles: Extract<MemoryAssistantRoleResult, { ok: true }>[]
    }
  | {
      ok: false
      reason: string
    }

function nowID(prefix = "memchat") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function chatFile(root: string | undefined, id: string) {
  return path.join(memoryPaths(root).projectDir, "side-chat", `${id}.json`)
}

function normalizeSession(input: Partial<MemorySideChatSession> & { id?: string; root: string }): MemorySideChatSession {
  return {
    id: input.id || nowID(),
    root: input.root,
    selectedWorkspaceID: input.selectedWorkspaceID ?? null,
    selectedGroupID: input.selectedGroupID ?? null,
    selectedCategoryID: input.selectedCategoryID ?? null,
    history: Array.isArray(input.history) ? input.history.filter((message): message is MemorySideChatMessage => Boolean(message?.id && message.text)) : [],
    status: input.status === "running" || input.status === "canceled" ? input.status : "idle",
    proposals: Array.isArray(input.proposals) ? input.proposals.filter((item): item is string => typeof item === "string") : [],
    updatedAt: input.updatedAt || new Date().toISOString(),
  }
}

function extractJsonObject(text: string) {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "")
  if (!trimmed) return ""
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed
  const start = trimmed.indexOf("{")
  const end = trimmed.lastIndexOf("}")
  if (start === -1 || end <= start) return trimmed
  return trimmed.slice(start, end + 1)
}

function normalizeAction(input: unknown): MemorySideChatAction | null {
  if (!input || typeof input !== "object") return null
  const action = input as Record<string, unknown>
  const kind = action.kind
  if (!MEMORY_SIDE_CHAT_ACTION_KINDS.includes(kind as MemorySideChatActionKind)) return null
  if (typeof action.text !== "string" || !action.text.trim()) return null
  const scope = action.scope === "global" || action.scope === "project" ? action.scope : undefined
  const targetScope = action.targetScope === "global" || action.targetScope === "project" ? action.targetScope : undefined
  return {
    kind,
    text: action.text.trim(),
    scope,
    targetScope,
    targetID: typeof action.targetID === "string" && action.targetID.trim() ? action.targetID.trim() : undefined,
    categoryID: typeof action.categoryID === "string" && action.categoryID.trim() ? action.categoryID.trim() : undefined,
    categoryIDs: Array.isArray(action.categoryIDs)
      ? action.categoryIDs.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
      : undefined,
  }
}

export function parseMemorySideChatResponse(outputText: string) {
  const raw = outputText.trim()
  const fallback = { text: raw || "No memory assistant response.", actions: [] as MemorySideChatAction[] }
  if (!raw) return fallback
  try {
    const parsed = JSON.parse(extractJsonObject(raw)) as Record<string, unknown>
    const text = typeof parsed.reply === "string"
      ? parsed.reply.trim()
      : typeof parsed.text === "string"
        ? parsed.text.trim()
        : fallback.text
    const actions = Array.isArray(parsed.actions)
      ? parsed.actions.map(normalizeAction).filter((item): item is MemorySideChatAction => Boolean(item))
      : []
    return { text: text || fallback.text, actions }
  } catch {
    return fallback
  }
}

export function memoryAssistantFailureReason(error: unknown) {
  const reason = memoryExtractorFailureReason(error).replace(/^memory extractor/i, "memory side chat")
  if (/^bad request$/i.test(reason)) {
    return "memory side chat provider rejected the configured model request"
  }
  return reason
}

function compactReason(value: unknown) {
  const text = Array.isArray(value) ? value.join("; ") : String(value ?? "")
  return text.replace(/\s+/g, " ").trim().slice(0, 240)
}

async function runnableAuthMode(
  root: string,
  role: { providerID: string; modelID: string; authMode?: string | null },
  input: { connectedProviderIDs?: readonly string[] } = {},
) {
  const configuredAuthMode = typeof role.authMode === "string" && role.authMode.trim() ? role.authMode.trim() : null
  const auth = await providerAuthStatus(role.providerID, role.modelID, { authMode: configuredAuthMode, skipNext: true }, root)
  if (input.connectedProviderIDs?.includes(role.providerID)) {
    return {
      ok: true as const,
      authMode: configuredAuthMode || auth.authMode || "connected-provider",
      runner: "adapter" as const,
    }
  }
  const blockers = compactReason(auth.blockers)
  if (role.providerID === "openai") {
    if (configuredAuthMode === "api-key") {
      return process.env.OPENAI_API_KEY
        ? { ok: true as const, authMode: "api-key" }
        : { ok: false as const, reason: blockers || "missing env:OPENAI_API_KEY" }
    }
    if (configuredAuthMode === "chatgpt-subscription-oauth") {
      return auth.mendRunReady
        ? { ok: true as const, authMode: "chatgpt-subscription-oauth", runner: "adapter" as const }
        : { ok: false as const, reason: blockers || "OpenAI OAuth state is not usable" }
    }
    if (auth.mendRunReady && auth.mendAuth?.type === "oauth") return { ok: true as const, authMode: "chatgpt-subscription-oauth", runner: "adapter" as const }
    if (process.env.OPENAI_API_KEY) return { ok: true as const, authMode: "api-key", runner: "adapter" as const }
    return { ok: false as const, reason: blockers || "missing usable OpenAI auth state or OPENAI_API_KEY" }
  }
  if (auth.mendRunReady) return { ok: true as const, authMode: configuredAuthMode || "api-key", runner: "adapter" as const }
  return { ok: false as const, reason: blockers || `auth is not ready for ${role.providerID}` }
}

export function memorySideChatInstructions() {
  return [
    "You are MendCode's Memory side chat: a focused assistant for saved memories, pending proposals, memory policies, categories, and Dream configuration.",
    "Answer in the user's language.",
    "You can inspect saved memory, pending memory proposals, the selected memory page context, and this side-chat history.",
    "Treat the full memory context as available by default. A selected project/category only focuses the answer; it does not remove global/current-project memory from context.",
    "Use the selected page context first when answering questions about what is visible or selected in the Memory page.",
    "You cannot run shell commands, browse git state, or silently apply changes.",
    "You can help configure memory behavior by drafting reviewable control actions for memory facts, category/policy rules, and Dream scheduling/source rules.",
    "You can draft actions to create, edit, delete, or move memories; create, edit, or delete categories; update category policies; and prepare Dream dry runs.",
    "When the user asks to change memory state, use the most specific action kind instead of only explaining.",
    "Do not say you cannot configure memory or Dream when the user asks. Explain that you can prepare a reviewable proposal and include the action.",
    "If selected page context or saved memory is present, do not claim that no context exists.",
    "Use propose-memory for durable facts/preferences/rules to remember.",
    "Use propose-policy for category, scope, prompt, write policy, extraction, or save-behavior changes.",
    "Use dream-dry-run for Dream schedule, cadence, source permissions, and dry-run requests.",
    "For Dream scheduling, prefer a flexible time window/range over a fixed exact time unless the user explicitly demands a fixed time.",
    "When a user asks for a fixed Dream time like 21:00, suggest a nearby window such as 18:00-23:00 and draft that window as the reviewable action.",
    "Use explain-state only when the user asks how the current memory state works and no proposal is needed.",
    "Every action is reviewable and pending. Never imply that the change was already applied.",
    "Return strict JSON only:",
    '{"reply":"short helpful answer","actions":[{"kind":"move-memory","targetID":"memory-id","categoryID":"project.security","text":"Move this memory into Security for review.","scope":"project","categoryIDs":["memory.policy"]},{"kind":"dream-dry-run","text":"reviewable Dream config or dry-run request","scope":"project","categoryIDs":["memory.dream"]}]}',
    "Use an empty actions array when no proposal is needed.",
  ].join("\n")
}

function sideChatProposalForAction(action: MemorySideChatAction) {
  if (action.kind === "explain-state") return null
  const categoryIDs = action.categoryIDs?.length
    ? action.categoryIDs
    : action.kind === "dream-dry-run"
      ? ["memory.dream"]
      : action.kind === "propose-policy" || action.kind.includes("category") || action.kind === "move-memory" || action.kind === "edit-memory" || action.kind === "delete-memory"
        ? ["memory.policy"]
        : undefined
  const label = action.kind === "dream-dry-run"
    ? "Dream proposal"
    : action.kind === "propose-policy"
      ? "Memory policy proposal"
      : action.kind === "create-memory"
        ? "Create memory proposal"
        : action.kind === "edit-memory"
          ? "Edit memory proposal"
          : action.kind === "delete-memory"
            ? "Delete memory proposal"
            : action.kind === "move-memory"
              ? "Move memory proposal"
              : action.kind.includes("category")
                ? "Category proposal"
                : "Memory proposal"
  const details = [
    action.targetID ? `target=${action.targetID}` : "",
    action.targetScope ? `targetScope=${action.targetScope}` : "",
    action.categoryID ? `category=${action.categoryID}` : "",
  ].filter(Boolean).join(" · ")
  return {
    scope: action.scope ?? "project",
    text: action.kind === "propose-memory" ? action.text : `${label}${details ? ` (${details})` : ""}: ${action.text}`,
    categoryIDs,
    tags: ["side-chat", action.kind, ...(categoryIDs ?? [])],
    reason: `${label} drafted by Memory side chat for review.`,
  }
}

export function memorySideChatMessage(input: Parameters<MemorySideChatResponder>[0], existing: string) {
  const history = input.history.slice(-12).map((message) => `${message.role.toUpperCase()}: ${message.text}`).join("\n\n")
  return [
    "<selected_context>",
    `workspaceID: ${input.context.selectedWorkspaceID ?? "current"}`,
    `groupID: ${input.context.selectedGroupID ?? "none"}`,
    `categoryID: ${input.context.selectedCategoryID ?? "none"}`,
    "</selected_context>",
    "",
    "<selected_page_context>",
    input.context.pageContext?.trim() || "- none",
    "</selected_page_context>",
    "",
    "<memory_context>",
    existing || "- none",
    "</memory_context>",
    "",
    "<side_chat_history>",
    history || "- none",
    "</side_chat_history>",
    "",
    "<latest_user_message>",
    input.message,
    "</latest_user_message>",
  ].join("\n")
}

export async function buildMemorySideChatRequest(root: string, input: Parameters<MemorySideChatResponder>[0]) {
  const context = await readMemoryExtractorContext(root)
  return {
    instructions: memorySideChatInstructions(),
    message: memorySideChatMessage(input, context.existing),
  }
}

export async function resolveMemoryAssistantRole(
  root?: string,
  input: { connectedProviderIDs?: readonly string[] } = {},
): Promise<MemoryAssistantRoleResult> {
  const paths = memoryPaths(root)
  const config = await readMemoryConfig(paths.root)
  if (!config.memoryAssistantRole || config.memoryAssistantRole === "none") {
    return { ok: false, reason: "memory side chat disabled" }
  }

  const resolved = await resolveModelRoles(paths.root)
  if (!resolved.enabled) return { ok: false, reason: "memory side chat model not configured" }
  const roles = resolved.roles as Record<string, any>
  const candidates = [...new Set([config.memoryAssistantRole, "memoryExtractor", "small", "default"])]
  const failures: string[] = []
  for (const roleName of candidates) {
    const role = roles[roleName]
    if (!role?.configured || !role.providerID || !role.modelID) continue
    const runnable = await runnableAuthMode(paths.root, role, input)
    if (!runnable.ok) {
      failures.push(`${roleName}: ${runnable.reason}`)
      continue
    }
    return {
      ok: true,
      roleName,
      providerID: role.providerID,
      modelID: role.modelID,
      authMode: runnable.authMode,
      runner: runnable.runner,
    }
  }
  return {
    ok: false,
    reason: failures.length
      ? `memory side chat auth not ready: ${failures.join(" | ")}`
      : `memory side chat role not configured: ${config.memoryAssistantRole}`,
  }
}

export async function resolveMemoryAssistantRuntimeRole(root?: string): Promise<MemoryAssistantRoleResult> {
  const candidates = await resolveMemoryAssistantRuntimeRoles(root)
  if (!candidates.ok) return candidates
  return candidates.roles[0] ?? { ok: false, reason: "memory side chat model not configured" }
}

export async function resolveMemoryAssistantRuntimeRoles(root?: string): Promise<MemoryAssistantRuntimeRolesResult> {
  const paths = memoryPaths(root)
  const config = await readMemoryConfig(paths.root)
  if (!config.memoryAssistantRole || config.memoryAssistantRole === "none") {
    return { ok: false, reason: "memory side chat disabled" }
  }

  const resolved = await resolveModelRoles(paths.root)
  if (!resolved.enabled) return { ok: false, reason: "memory side chat model not configured" }
  const roles = resolved.roles as Record<string, any>
  const candidates = [...new Set([config.memoryAssistantRole, "memoryExtractor", "small", "default"])]
  const runnable: Extract<MemoryAssistantRoleResult, { ok: true }>[] = []
  for (const roleName of candidates) {
    const role = roles[roleName]
    if (!role?.configured || !role.providerID || !role.modelID) continue
    runnable.push({
      ok: true,
      roleName,
      providerID: role.providerID,
      modelID: role.modelID,
      authMode: typeof role.authMode === "string" && role.authMode.trim() ? role.authMode.trim() : "runtime-provider",
      runner: "runtime-provider",
    })
  }
  if (runnable.length) return { ok: true, roles: runnable }
  return { ok: false, reason: `memory side chat role not configured: ${config.memoryAssistantRole}` }
}

export async function defaultMemorySideChatResponder(root: string, input: Parameters<MemorySideChatResponder>[0]) {
  const role = await resolveMemoryAssistantRole(root, { connectedProviderIDs: input.connectedProviderIDs })
  if (!role.ok) {
    return {
      text: `${role.reason}. The Setup model role is configured, but its provider auth is not runnable yet. Connect the provider in Setup or provide the required runtime credential.`,
      actions: [],
    }
  }
  const { instructions, message } = await buildMemorySideChatRequest(root, input)
  const result = await runProviderAdapter(root, {
    providerID: role.providerID,
    modelID: role.modelID,
    authMode: role.authMode,
    instructions,
    messages: [{
      role: "user",
      content: message,
    }],
  }).catch((error) => ({
    ok: false as const,
    status: 1,
    statusText: "memory side chat failed",
    errorPreview: memoryAssistantFailureReason(error),
    telemetry: { elapsedMs: null, usage: null, cost: null },
  }))
  if (!result.ok) return { text: memoryAssistantFailureReason(result.errorPreview || result.statusText), actions: [] }
  return parseMemorySideChatResponse(result.outputText || "")
}

export async function readMemorySideChat(id: string, root?: string) {
  const file = chatFile(root, id)
  if (!existsSync(file)) return null
  return normalizeSession(JSON.parse(await readFile(file, "utf8")))
}

export async function listMemorySideChats(root?: string) {
  const dir = path.join(memoryPaths(root).projectDir, "side-chat")
  if (!existsSync(dir)) return [] as MemorySideChatSession[]
  const files = await readdir(dir).catch(() => [] as string[])
  const sessions = await Promise.all(files
    .filter((file) => file.endsWith(".json"))
    .map(async (file) => {
      try {
        return normalizeSession(JSON.parse(await readFile(path.join(dir, file), "utf8")))
      } catch {
        return null
      }
    }))
  return sessions
    .filter((session): session is MemorySideChatSession => Boolean(session))
    .filter((session) => session.history.length > 0 || session.proposals.length > 0)
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function writeMemorySideChat(session: MemorySideChatSession, root?: string) {
  const next = normalizeSession({ ...session, updatedAt: new Date().toISOString() })
  const file = chatFile(root, next.id)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`)
  return next
}

export function createMemorySideChatSession(input: {
  root: string
  selectedWorkspaceID?: string | null
  selectedGroupID?: string | null
  selectedCategoryID?: string | null
}) {
  return normalizeSession({
    root: input.root,
    selectedWorkspaceID: input.selectedWorkspaceID ?? null,
    selectedGroupID: input.selectedGroupID ?? null,
    selectedCategoryID: input.selectedCategoryID ?? null,
  })
}

export async function startMemorySideChat(input: {
  root: string
  selectedWorkspaceID?: string | null
  selectedGroupID?: string | null
  selectedCategoryID?: string | null
}) {
  return writeMemorySideChat(createMemorySideChatSession(input), input.root)
}

export async function sendMemorySideChatMessage(input: {
  session: MemorySideChatSession
  message: string
  responder?: MemorySideChatResponder
  pageContext?: string | null
  signal?: AbortSignal
}) {
  if (input.signal?.aborted) {
    const canceled = await writeMemorySideChat({ ...input.session, status: "canceled" }, input.session.root)
    return { session: canceled, proposals: [] as MemoryProposal[], canceled: true }
  }
  const now = new Date().toISOString()
  const userMessage: MemorySideChatMessage = { id: nowID("msg"), role: "user", text: input.message.trim(), createdAt: now }
  let session = await writeMemorySideChat({ ...input.session, status: "running", history: [...input.session.history, userMessage] }, input.session.root)
  const responder = input.responder ?? ((payload) => defaultMemorySideChatResponder(session.root, payload))
  const response = await responder({
    message: input.message,
    history: session.history,
    context: {
      selectedWorkspaceID: session.selectedWorkspaceID,
      selectedGroupID: session.selectedGroupID,
      selectedCategoryID: session.selectedCategoryID,
      pageContext: input.pageContext ?? null,
    },
    signal: input.signal,
  })
  if (input.signal?.aborted) {
    const canceled = await writeMemorySideChat({ ...session, status: "canceled" }, session.root)
    return { session: canceled, proposals: [] as MemoryProposal[], canceled: true }
  }
  const proposals: MemoryProposal[] = []
  for (const action of response.actions ?? []) {
    const proposal = sideChatProposalForAction(action)
    if (!proposal) continue
    proposals.push(await proposeMemory({
      ...proposal,
      source: "memory-side-chat",
    }, session.root))
  }
  const assistantMessage: MemorySideChatMessage = { id: nowID("msg"), role: "assistant", text: response.text, createdAt: new Date().toISOString() }
  session = await writeMemorySideChat({
    ...session,
    status: "idle",
    history: [...session.history, assistantMessage],
    proposals: [...session.proposals, ...proposals.map((proposal) => proposal.id)],
  }, session.root)
  return { session, proposals, canceled: false }
}

export async function cancelMemorySideChat(session: MemorySideChatSession) {
  return writeMemorySideChat({ ...session, status: "canceled" }, session.root)
}
