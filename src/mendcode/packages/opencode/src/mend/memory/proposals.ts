import { existsSync } from "fs"
import { mkdir, readFile, readdir, stat, writeFile } from "fs/promises"
import path from "path"
import { memoryPaths, readMemoryConfig, type MemoryScope } from "./config"
import { appendMemoryEntry, readMemoryEntries, type MemoryEntry, type MemorySensitivity } from "./store"
import { resolveModelRoles } from "../config/models"
import { runProviderAdapter } from "../runtime/provider-adapters"

export type MemoryProposalStatus = "pending" | "applied" | "rejected"

export type MemoryProposal = {
  id: string
  version: 0
  status: MemoryProposalStatus
  scope: MemoryScope
  text: string
  tags: string[]
  cwd: string | null
  files: string[]
  source: string
  evidence: string | null
  confidence: number
  durability: number
  changeRisk: number
  reason: string | null
  sensitivity: MemorySensitivity
  redactions: string[]
  createdAt: string
  updatedAt: string
  appliedEntryID: string | null
}

export type ProposeMemoryInput = {
  text: string
  scope?: MemoryScope
  tags?: string[]
  cwd?: string | null
  files?: string[]
  source?: string
  evidence?: string | null
  confidence?: number
  durability?: number
  changeRisk?: number
  reason?: string | null
}

export type ProposeMemoriesFromTextInput = Omit<ProposeMemoryInput, "text"> & {
  text: string
  maxProposals?: number
}

export type MemoryExtractorRoleResult =
  | {
      ok: true
      roleName: string
      providerID: string
      modelID: string
      authMode: string
    }
  | {
      ok: false
      reason: string
    }

export type AutoMemoryResult = {
  enabled: boolean
  output: boolean
  skipped: boolean
  reason: string | null
  proposals: MemoryProposal[]
  callsProviders: boolean
  writesMemory: false
}

export const MEMORY_EXTRACTION_POLICY = [
  "Only propose memory that should remain useful far into the future.",
  "Keep only durable user preferences, stable project decisions, recurring constraints, long-lived repo facts, safety rules, and workflow conventions.",
  "Be highly selective: prefer one consolidated memory, and never propose more than two memories from one conversation.",
  "Reject uncertain facts, likely-to-change details, hypotheses, guesses, stale conclusions, and anything that may be wrong after the current task evolves.",
  "Do not require the user to literally say remember, save, guardar, or memoria; strong future-facing preferences and rules are valid candidates.",
  "Reject anything about what just happened, what is currently happening, what was just checked, what should be done next, or what was already answered.",
  "Reject temporary state, one-off task details, status updates, todo-like recommendations, transient debugging context, raw logs, secrets, and anything already present in saved memory.",
  "A proposal must be self-contained, specific, and useful without the surrounding chat. If it would not help a future session, return nothing.",
  "Generated proposals are review-only; never apply them automatically.",
].join("\n")

function nowID(prefix = "memprop") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function normalizeStringList(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
}

function redactionPatterns() {
  return [
    { label: "env-assignment", pattern: /\b[A-Z][A-Z0-9_]{2,}\s*=\s*[^\s"'`]+/g },
    { label: "bearer-token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi },
    { label: "openai-key", pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
    { label: "generic-token", pattern: /\b(?:api[_-]?key|token|secret|password)\b\s*[:=]\s*[^\s"'`]+/gi },
  ]
}

export function redactMemoryText(text: string) {
  let redacted = text.trim()
  const redactions: string[] = []
  for (const { label, pattern } of redactionPatterns()) {
    if (!pattern.test(redacted)) continue
    pattern.lastIndex = 0
    redacted = redacted.replace(pattern, `[REDACTED:${label}]`)
    redactions.push(label)
  }
  return { text: redacted, redactions: [...new Set(redactions)] }
}

function sensitivityFor(redactions: string[], text: string): MemorySensitivity {
  if (redactions.length) return "high"
  if (/\b(auth|secret|token|credential|password|keychain|keepass|env)\b/i.test(text)) return "medium"
  return "low"
}

function proposalPath(root: string | undefined, id: string) {
  return path.join(memoryPaths(root).proposalsDir, `${id}.json`)
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, "utf8")) as T
}

async function writeProposal(proposal: MemoryProposal, root?: string) {
  const paths = memoryPaths(root)
  await mkdir(paths.proposalsDir, { recursive: true })
  await writeFile(proposalPath(paths.root, proposal.id), `${JSON.stringify(proposal, null, 2)}\n`)
  return proposal
}

export async function proposeMemory(input: ProposeMemoryInput, root?: string) {
  const paths = memoryPaths(root)
  const redacted = redactMemoryText(input.text)
  if (!redacted.text) throw new Error("Cannot propose empty memory text")
  const now = new Date().toISOString()
  const proposal: MemoryProposal = {
    id: nowID(),
    version: 0,
    status: "pending",
    scope: input.scope === "global" ? "global" : "project",
    text: redacted.text,
    tags: normalizeStringList(input.tags),
    cwd: typeof input.cwd === "string" && input.cwd.trim() ? input.cwd : paths.root,
    files: normalizeStringList(input.files),
    source: typeof input.source === "string" && input.source.trim() ? input.source : "manual-proposal",
    evidence: typeof input.evidence === "string" && input.evidence.trim() ? input.evidence.trim() : null,
    confidence: typeof input.confidence === "number" && Number.isFinite(input.confidence) ? Math.max(0, Math.min(1, input.confidence)) : redacted.redactions.length ? 0.45 : 0.7,
    durability: typeof input.durability === "number" && Number.isFinite(input.durability) ? Math.max(0, Math.min(1, input.durability)) : 0.7,
    changeRisk: typeof input.changeRisk === "number" && Number.isFinite(input.changeRisk) ? Math.max(0, Math.min(1, input.changeRisk)) : 0.3,
    reason: typeof input.reason === "string" && input.reason.trim() ? input.reason.trim() : null,
    sensitivity: sensitivityFor(redacted.redactions, input.text),
    redactions: redacted.redactions,
    createdAt: now,
    updatedAt: now,
    appliedEntryID: null,
  }
  return writeProposal(proposal, paths.root)
}

function memoryFingerprint(text: string) {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[`*_()[\]{}.,:;!?'"-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function isNearDuplicate(candidate: string, existing: string[]) {
  const normalized = memoryFingerprint(candidate)
  if (!normalized) return true
  return existing.some((item) => {
    if (item === normalized) return true
    if (item.includes(normalized) || normalized.includes(item)) return true
    const candidateTerms = new Set(normalized.split(" ").filter((term) => term.length > 3))
    const existingTerms = new Set(item.split(" ").filter((term) => term.length > 3))
    const candidateCodeTerms = new Set(normalized.split(" ").filter((term) => /[_./-]/.test(term) || /\b(js|css|docker|frontend|backend|forgejo|zerobase|webpack|makefile)\b/i.test(term)))
    const existingCodeTerms = new Set(item.split(" ").filter((term) => /[_./-]/.test(term) || /\b(js|css|docker|frontend|backend|forgejo|zerobase|webpack|makefile)\b/i.test(term)))
    if (candidateCodeTerms.size >= 2 && existingCodeTerms.size >= 2) {
      let codeOverlap = 0
      for (const term of candidateCodeTerms) if (existingCodeTerms.has(term)) codeOverlap++
      if (codeOverlap >= 2) return true
    }
    if (candidateTerms.size < 5 || existingTerms.size < 5) return false
    let overlap = 0
    for (const term of candidateTerms) if (existingTerms.has(term)) overlap++
    return overlap / Math.min(candidateTerms.size, existingTerms.size) >= 0.72
  })
}

export function memoryExtractorFailureReason(error: unknown) {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : String(error ?? "")
  const reason = raw.replace(/\s+/g, " ").trim()
  if (!reason) return "memory extractor model failed"
  if (/MENDCODE_OPENAI_OAUTH_CLIENT_ID|OPENAI_OAUTH_CLIENT_ID|ChatGPT subscription OAuth/i.test(reason))
    return "memory extractor auth missing"
  if (/OPENAI_API_KEY/i.test(reason)) return "memory extractor API key missing"
  if (/auth mode is not implemented/i.test(reason)) return "memory extractor auth unsupported"
  return reason.slice(0, 240)
}

export function extractorPrompt() {
  return [
    "You are MendCode's memory extractor.",
    MEMORY_EXTRACTION_POLICY,
    "",
    "Return strict JSON only:",
    '{"proposals":[{"shouldRemember":true,"scope":"project|global","text":"durable memory","tags":["short-tag"],"durability":0.0,"confidence":0.0,"changeRisk":0.0,"reason":"why this is worth remembering"}]}',
    "",
    "Rules:",
    "- Return an empty proposals array unless the input contains genuinely durable future-use information that should be remembered indefinitely.",
    "- Only set shouldRemember=true when durability is at least 0.8, confidence is at least 0.75, and changeRisk is at most 0.25.",
    "- Do not require explicit memory wording. If the user says something is very important, says always/never, gives a future workflow rule, states a durable preference, or corrects how the assistant should behave in future sessions, treat it as a strong memory candidate.",
    "- Repo-scoped workflow rules such as 'Para este repo, cuando hagas cambios visibles de TUI, valida con smoke test antes de decir listo' are strong project memory candidates even if the assistant only replies 'entendido'.",
    "- Assistant text such as 'I will not save this yet' is not a reason to skip. Extract from the user's durable instruction, not from whether the assistant remembered to save it.",
    "- Review saved_memory and pending_memory before proposing. If either already contains an equivalent fact, return an empty proposals array.",
    "- Saved global memories apply across projects. Saved project memories and pending project proposals apply to this repo. Use that scope evidence when checking duplicates.",
    "- If the user repeats or lightly rephrases a durable preference that is not in saved_memory or pending_memory, propose it once.",
    "- Prefer a single consolidated proposal. Return two only when there are two clearly separate durable memories. Never return more than two.",
    "- Do not split related details into multiple memories; merge them into one precise memory.",
    "- Do not propose uncertain, provisional, likely-to-change, disputed, weakly inferred, or recently discovered facts unless the user clearly frames them as a future preference, rule, or decision.",
    "- Scope must be conservative. Use project by default.",
    "- Use project for repo/app/product-specific facts, architecture, setup, env/deploy behavior, local paths, commands, files, docs, framework choices, or limitations.",
    "- Use global only for durable user preferences, communication style, safety rules, or workflows that should follow the user across unrelated repos.",
    "- If the memory mentions a specific project/repo/product name, choose project unless the text is explicitly a cross-project preference.",
    "- Do not propose memories from recent events, current status, temporary blockers, findings from the current task, task lists, or next-step recommendations.",
    "- Do not memorize the existence or contents of files unless the user explicitly asks to remember a durable rule, constraint, or preference from them.",
    "- Memory should describe durable facts/preferences, not todos or summaries of recent work.",
    "- Do not propose text copied from an assistant answer unless the user explicitly asks to remember it.",
    "- Do not propose anything already covered by existing memory.",
    "- Do not include markdown, prose, or code fences.",
  ].join("\n")
}

type ExtractedMemoryProposal = {
  shouldRemember: boolean
  scope: MemoryScope
  text: string
  tags: string[]
  durability: number
  confidence: number
  changeRisk: number
  reason: string | null
}

function parseExtractorJSON(text: string, maxProposals = 2): ExtractedMemoryProposal[] {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "")
  if (!trimmed) return []
  let parsed: any
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return []
  }
  const proposals = Array.isArray(parsed?.proposals) ? parsed.proposals : []
  const limit = Math.max(0, Math.min(2, maxProposals))
  return proposals
    .filter((item: any) => typeof item?.text === "string" && item.text.trim().length >= 16)
    .map((item: any): ExtractedMemoryProposal => ({
      shouldRemember: item.shouldRemember === true,
      scope: item.scope === "global" ? "global" as const : "project" as const,
      text: item.text.trim(),
      tags: normalizeStringList(item.tags),
      durability: typeof item.durability === "number" && Number.isFinite(item.durability) ? Math.max(0, Math.min(1, item.durability)) : 0,
      confidence: typeof item.confidence === "number" && Number.isFinite(item.confidence) ? Math.max(0, Math.min(1, item.confidence)) : 0,
      changeRisk: typeof item.changeRisk === "number" && Number.isFinite(item.changeRisk) ? Math.max(0, Math.min(1, item.changeRisk)) : 1,
      reason: typeof item.reason === "string" && item.reason.trim() ? item.reason.trim().slice(0, 240) : null,
    }))
    .filter((item: ExtractedMemoryProposal) => item.shouldRemember && item.durability >= 0.8 && item.confidence >= 0.75 && item.changeRisk <= 0.25)
    .slice(0, limit)
}

export async function resolveMemoryExtractorRole(root?: string): Promise<MemoryExtractorRoleResult> {
  const paths = memoryPaths(root)
  const config = await readMemoryConfig(paths.root)
  if (!config.extractorRole || config.extractorRole === "none") {
    return { ok: false, reason: "memory extractor disabled" }
  }

  const resolved = await resolveModelRoles(paths.root)
  const role = (resolved.roles as Record<string, any>)[config.extractorRole]
  if (!resolved.enabled || !role?.configured || !role.providerID || !role.modelID) {
    return { ok: false, reason: `memory extractor role not configured: ${config.extractorRole}` }
  }
  return {
    ok: true,
    roleName: config.extractorRole,
    providerID: role.providerID,
    modelID: role.modelID,
    authMode: role.authMode || "api-key",
  }
}

export async function readMemoryExtractorContext(root?: string) {
  const paths = memoryPaths(root)
  const [globalEntries, projectEntries, proposals] = await Promise.all([
    readMemoryEntries("global", paths.root).catch(() => []),
    readMemoryEntries("project", paths.root).catch(() => []),
    listMemoryProposals(paths.root, "all").catch(() => []),
  ])
  const saved = [...globalEntries, ...projectEntries]
  const pending = proposals.filter((proposal) => proposal.status === "pending")
  const historical = proposals.filter((proposal) => proposal.status !== "pending")
  const existing = [
    "<saved_memory>",
    ...saved.map((item) => `- [saved][${item.scope}] ${item.text}`),
    saved.length ? "" : "- none",
    "</saved_memory>",
    "",
    "<pending_memory>",
    ...pending.map((item) => `- [pending][${item.scope}] ${item.text}`),
    pending.length ? "" : "- none",
    "</pending_memory>",
    "",
    "<historical_memory_proposals>",
    ...historical.map((item) => `- [${item.status}][${item.scope}] ${item.text}`),
    historical.length ? "" : "- none",
    "</historical_memory_proposals>",
  ].join("\n")
  const existingItems = [...saved, ...proposals]
  const existingFingerprints = existingItems.map((item) => memoryFingerprint(item.text)).filter(Boolean)
  return { existing, existingFingerprints }
}

export function memoryExtractorCandidateMessage(input: ProposeMemoriesFromTextInput, existing: string) {
  return [
    "<memory_context>",
    existing || "- none",
    "</memory_context>",
    "",
    "<candidate_turn>",
    input.text,
    "</candidate_turn>",
  ].join("\n")
}

export async function proposeMemoriesFromExtractorText(
  input: ProposeMemoriesFromTextInput,
  outputText: string,
  root?: string,
  existingFingerprints?: string[],
) {
  const paths = memoryPaths(root)
  const fingerprints = new Set(existingFingerprints ?? (await readMemoryExtractorContext(paths.root)).existingFingerprints)
  const extracted: ExtractedMemoryProposal[] = []
  for (const item of parseExtractorJSON(outputText || "", input.maxProposals ?? 2)) {
    if (isNearDuplicate(item.text, [...fingerprints])) continue
    extracted.push(item)
    fingerprints.add(memoryFingerprint(item.text))
  }
  const proposals: MemoryProposal[] = []
  for (const item of extracted) {
    proposals.push(await proposeMemory({
      scope: item.scope,
      text: item.text,
      tags: [...normalizeStringList(input.tags), ...item.tags],
      cwd: input.cwd,
      files: input.files,
      source: input.source || "model-extract",
      evidence: input.evidence,
      confidence: item.confidence,
      durability: item.durability,
      changeRisk: item.changeRisk,
      reason: item.reason,
    }, paths.root))
  }
  return { proposals, candidates: extracted.length, callsProviders: true as const, readsSecrets: false as const, writesMemory: false as const, skipped: false, reason: null }
}

export async function proposeMemoriesWithExtractor(input: ProposeMemoriesFromTextInput, root?: string) {
  const paths = memoryPaths(root)
  const role = await resolveMemoryExtractorRole(paths.root)
  if (!role.ok) {
    return { proposals: [], candidates: 0, callsProviders: false as const, readsSecrets: false as const, writesMemory: false as const, skipped: true, reason: role.reason }
  }

  const context = await readMemoryExtractorContext(paths.root)

  const result = await runProviderAdapter(paths.root, {
    providerID: role.providerID,
    modelID: role.modelID,
    authMode: role.authMode,
    instructions: extractorPrompt(),
    messages: [{
      role: "user",
      content: memoryExtractorCandidateMessage(input, context.existing),
    }],
  }).catch((error) => ({
    ok: false as const,
    status: 1,
    statusText: "memory extractor failed",
    errorPreview: memoryExtractorFailureReason(error),
    telemetry: { elapsedMs: null, usage: null, cost: null },
  }))
  if (!result.ok) {
    return { proposals: [], candidates: 0, callsProviders: true as const, readsSecrets: false as const, writesMemory: false as const, skipped: true, reason: memoryExtractorFailureReason(result.errorPreview || result.statusText) }
  }

  return proposeMemoriesFromExtractorText({
    ...input,
    source: input.source || `model-extract:${role.roleName}`,
  }, result.outputText || "", paths.root, context.existingFingerprints)
}

function transcriptFromMessages(messages: Array<{ role?: string; content?: unknown }>) {
  return messages
    .map((message) => {
      const role = typeof message.role === "string" ? message.role.toUpperCase() : "UNKNOWN"
      const content = typeof message.content === "string" ? message.content : ""
      return content.trim() ? `${role}: ${content}` : ""
    })
    .filter(Boolean)
    .join("\n\n")
}

export async function autoProposeMemoriesFromSession(session: any, root?: string): Promise<AutoMemoryResult> {
  const paths = memoryPaths(root)
  const config = await readMemoryConfig(paths.root)
  if (!config.enabled || !config.generate) {
    return { enabled: config.enabled, output: config.generate, skipped: true, reason: "memory output disabled", proposals: [], callsProviders: false, writesMemory: false }
  }
  const messages = Array.isArray(session?.messages) ? session.messages : []
  if (messages.length < 2) {
    return { enabled: config.enabled, output: config.generate, skipped: true, reason: "not enough session messages", proposals: [], callsProviders: false, writesMemory: false }
  }
  const evidence = `chat:${session.id || "unknown"}:messages:${messages.length}`
  const existing = await listMemoryProposals(paths.root, "all")
  if (existing.some((proposal) => proposal.evidence === evidence)) {
    return { enabled: config.enabled, output: config.generate, skipped: true, reason: "session already proposed", proposals: [], callsProviders: false, writesMemory: false }
  }
  const result = await proposeMemoriesWithExtractor({
    scope: "project",
    text: transcriptFromMessages(messages),
    tags: ["chat", "auto"],
    cwd: paths.root,
    source: "auto-chat-extract",
    evidence,
    maxProposals: 2,
  }, paths.root)
  return { enabled: config.enabled, output: config.generate, skipped: result.skipped ?? false, reason: result.reason ?? null, proposals: result.proposals, callsProviders: result.callsProviders, writesMemory: false }
}

async function walkMemoryFiles(dir: string, limit = 120): Promise<string[]> {
  const out: string[] = []
  async function walk(current: string) {
    if (out.length >= limit) return
    const entries = await readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (out.length >= limit) break
      const file = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === "rollout_summaries") continue
        await walk(file)
      } else if (/\.(md|txt|json|jsonl)$/i.test(entry.name)) {
        const info = await stat(file).catch(() => null)
        if (info && info.size > 0 && info.size <= 256_000) out.push(file)
      }
    }
  }
  await walk(dir)
  return out
}

export async function importCodexMemories(input: { codexMemoryDir?: string; apply?: boolean; maxProposals?: number } = {}, root?: string) {
  const paths = memoryPaths(root)
  const home = process.env.HOME || ""
  const codexMemoryDir = input.codexMemoryDir || path.join(home, ".codex", "memories")
  const maxProposals = Math.max(1, Math.min(50, input.maxProposals ?? 20))
  if (!existsSync(codexMemoryDir)) {
    return { codexMemoryDir, exists: false, apply: input.apply === true, candidates: [], proposals: [], callsProviders: false as const, writesMemory: false as const }
  }
  const files = await walkMemoryFiles(codexMemoryDir)
  const candidates: Array<{ file: string; text: string }> = []
  for (const file of files) {
    const text = await readFile(file, "utf8").catch(() => "")
    if (text.trim()) candidates.push({ file: path.relative(codexMemoryDir, file), text: text.trim().slice(0, 12_000) })
    if (candidates.length >= maxProposals) break
  }
  const extracted = input.apply && candidates.length
    ? await proposeMemoriesWithExtractor({
      scope: "global",
      text: candidates.map((candidate) => `<file path="${candidate.file}">\n${candidate.text}\n</file>`).join("\n\n"),
      tags: ["codex-import"],
      cwd: paths.root,
      source: "codex-memory-import",
      evidence: codexMemoryDir,
      maxProposals,
    }, paths.root)
    : null
  return {
    codexMemoryDir,
    exists: true,
    apply: input.apply === true,
    candidates,
    proposals: extracted?.proposals ?? [],
    callsProviders: extracted?.callsProviders ?? false,
    skipped: extracted?.skipped ?? !input.apply,
    reason: extracted?.reason ?? (input.apply ? null : "preview only"),
    writesMemory: false as const,
  }
}

export async function listMemoryProposals(root?: string, status?: MemoryProposalStatus | "all") {
  const paths = memoryPaths(root)
  if (!existsSync(paths.proposalsDir)) return []
  const files = await readdir(paths.proposalsDir).catch(() => [])
  const proposals = await Promise.all(files.filter((file) => file.endsWith(".json")).map((file) => readJson<MemoryProposal>(path.join(paths.proposalsDir, file)).catch(() => null)))
  return proposals
    .filter((proposal): proposal is MemoryProposal => Boolean(proposal?.id))
    .filter((proposal) => !status || status === "all" || proposal.status === status)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function readMemoryProposal(id: string, root?: string) {
  if (!id) throw new Error("Missing memory proposal id")
  const file = proposalPath(root, id)
  if (!existsSync(file)) throw new Error(`Unknown memory proposal: ${id}`)
  return readJson<MemoryProposal>(file)
}

export async function updateMemoryProposal(id: string, patch: Partial<Pick<MemoryProposal, "scope" | "text" | "tags" | "confidence" | "durability" | "changeRisk" | "reason">>, root?: string) {
  const proposal = await readMemoryProposal(id, root)
  if (proposal.status !== "pending") throw new Error(`Memory proposal ${id} is ${proposal.status}`)
  const next: MemoryProposal = {
    ...proposal,
    scope: patch.scope === "global" ? "global" : patch.scope === "project" ? "project" : proposal.scope,
    text: typeof patch.text === "string" && patch.text.trim() ? patch.text.trim() : proposal.text,
    tags: patch.tags ? normalizeStringList(patch.tags) : proposal.tags,
    confidence: typeof patch.confidence === "number" && Number.isFinite(patch.confidence) ? Math.max(0, Math.min(1, patch.confidence)) : proposal.confidence,
    durability: typeof patch.durability === "number" && Number.isFinite(patch.durability) ? Math.max(0, Math.min(1, patch.durability)) : proposal.durability,
    changeRisk: typeof patch.changeRisk === "number" && Number.isFinite(patch.changeRisk) ? Math.max(0, Math.min(1, patch.changeRisk)) : proposal.changeRisk,
    reason: typeof patch.reason === "string" && patch.reason.trim() ? patch.reason.trim() : proposal.reason,
    updatedAt: new Date().toISOString(),
  }
  await writeProposal(next, root)
  return next
}

export async function applyMemoryProposal(id: string, root?: string) {
  const proposal = await readMemoryProposal(id, root)
  if (proposal.status !== "pending") throw new Error(`Memory proposal ${id} is ${proposal.status}`)
  const entry: MemoryEntry = await appendMemoryEntry({
    scope: proposal.scope,
    text: proposal.text,
    tags: proposal.tags,
    cwd: proposal.cwd,
    files: proposal.files,
    source: proposal.source,
    evidence: proposal.evidence,
    confidence: proposal.confidence,
    sensitivity: proposal.sensitivity,
  }, root)
  const next: MemoryProposal = { ...proposal, status: "applied", updatedAt: new Date().toISOString(), appliedEntryID: entry.id }
  await writeProposal(next, root)
  return { proposal: next, entry }
}

export async function rejectMemoryProposal(id: string, root?: string) {
  const proposal = await readMemoryProposal(id, root)
  if (proposal.status !== "pending") throw new Error(`Memory proposal ${id} is ${proposal.status}`)
  const next: MemoryProposal = { ...proposal, status: "rejected", updatedAt: new Date().toISOString() }
  await writeProposal(next, root)
  return next
}
