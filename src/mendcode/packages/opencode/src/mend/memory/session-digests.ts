import { existsSync } from "fs"
import { mkdir, readdir, readFile, rename, writeFile } from "fs/promises"
import path from "path"
import { memoryPaths, resolveProjectMemoryRoot } from "./config"
import { redactMemoryText } from "./proposals"

const MAX_SUMMARY_CHARS = 4_000
const MAX_SIGNAL_CHARS = 240
const MAX_SIGNALS = 12
const MAX_FILES = 24

export type MemorySessionDigest = {
  id: string
  sessionID: string
  projectRoot: string | null
  title: string | null
  createdAt: string
  updatedAt: string
  summary: string
  decisions: string[]
  corrections: string[]
  validations: string[]
  files: string[]
  evidenceRefs: string[]
  redactions: string[]
  consumedBy: string[]
}

type SessionLike = {
  id?: unknown
  title?: unknown
  directory?: unknown
  root?: unknown
  cwd?: unknown
  updatedAt?: unknown
  time?: { updated?: unknown }
  messages?: unknown
  files?: unknown
}

type SessionMessage = {
  role?: unknown
  content?: unknown
  ok?: unknown
}

function digestDir(root?: string) {
  return path.join(memoryPaths(root).globalDir, "dream", "session-digests")
}

function digestPath(root: string | undefined, id: string) {
  return path.join(digestDir(root), `${id}.json`)
}

function nowID() {
  return `session_digest_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function list(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
}

function bounded(value: string, max: number) {
  return value.replace(/\s+/g, " ").trim().slice(0, max)
}

function uniqueBounded(values: string[], maxItems: number, maxChars = MAX_SIGNAL_CHARS) {
  return [...new Set(values.map((value) => bounded(value, maxChars)).filter(Boolean))].slice(0, maxItems)
}

function sessionMessages(session: SessionLike) {
  if (!Array.isArray(session.messages)) return []
  return session.messages.filter((message): message is SessionMessage => Boolean(message && typeof message === "object"))
}

function messageText(message: SessionMessage) {
  return text(message.content)
}

function signalLines(values: string[]) {
  return uniqueBounded(values.flatMap((value) => value.split(/\r?\n/)).filter((line) => /\b(always|never|must|should|prefer|decision|decided|actually|correct|do not|don't|use|run|test|typecheck|build|release|validated|passed|failed)\b/i.test(line)), MAX_SIGNALS)
}

function normalizeDigest(input: Partial<MemorySessionDigest> & Pick<MemorySessionDigest, "id" | "sessionID">): MemorySessionDigest {
  const createdAt = text(input.createdAt) || new Date().toISOString()
  return {
    id: input.id,
    sessionID: input.sessionID,
    projectRoot: text(input.projectRoot) || null,
    title: text(input.title) || null,
    createdAt,
    updatedAt: text(input.updatedAt) || createdAt,
    summary: bounded(text(input.summary), MAX_SUMMARY_CHARS),
    decisions: uniqueBounded(input.decisions ?? [], MAX_SIGNALS),
    corrections: uniqueBounded(input.corrections ?? [], MAX_SIGNALS),
    validations: uniqueBounded(input.validations ?? [], MAX_SIGNALS),
    files: [...new Set(list(input.files))].slice(0, MAX_FILES),
    evidenceRefs: [...new Set(list(input.evidenceRefs))].slice(0, MAX_FILES),
    redactions: [...new Set(list(input.redactions))],
    consumedBy: [...new Set(list(input.consumedBy))],
  }
}

async function writeDigest(digest: MemorySessionDigest, root?: string) {
  const file = digestPath(root, digest.id)
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(temporary, `${JSON.stringify(digest, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, file)
  return digest
}

export function buildMemorySessionDigest(sessionInput: unknown, root?: string) {
  const session = sessionInput && typeof sessionInput === "object" ? sessionInput as SessionLike : {}
  const messages = sessionMessages(session)
  const sessionID = text(session.id) || "unknown"
  const contents = messages.map(messageText).filter(Boolean)
  const userMessages = messages.filter((message) => text(message.role).toLowerCase() === "user").map(messageText).filter(Boolean)
  const assistantMessages = messages.filter((message) => text(message.role).toLowerCase() === "assistant").map(messageText).filter(Boolean)
  const redacted = redactMemoryText(contents.join("\n\n"))
  const redactedUsers = redactMemoryText(userMessages.join("\n"))
  const redactedAssistant = redactMemoryText(assistantMessages.join("\n"))
  const projectRoot = resolveProjectMemoryRoot(
    text(session.root) || text(root),
    text(session.directory) || text(session.cwd),
  ) ?? null
  const summaryParts = [
    text(session.title) ? `Session: ${text(session.title)}` : `Session ${sessionID}`,
    redactedUsers.text ? `User: ${bounded(redactedUsers.text, 1_600)}` : "",
    redactedAssistant.text ? `Assistant outcome: ${bounded(redactedAssistant.text, 1_600)}` : "",
  ].filter(Boolean)
  const userSignals = signalLines(redactedUsers.text ? [redactedUsers.text] : [])
  const assistantSignals = signalLines(redactedAssistant.text ? [redactedAssistant.text] : [])
  const validations = uniqueBounded(
    [...userSignals, ...assistantSignals].filter((line) => /\b(test|typecheck|build|validated|passed|failed|check)\b/i.test(line)),
    MAX_SIGNALS,
  )
  const corrections = uniqueBounded(
    userSignals.filter((line) => /\b(actually|correct|correction|no,|not that|instead)\b/i.test(line)),
    MAX_SIGNALS,
  )
  const decisions = uniqueBounded(
    userSignals.filter((line) => /\b(always|never|must|should|prefer|decision|decided|do not|don't)\b/i.test(line)),
    MAX_SIGNALS,
  )
  const updatedAt = text(session.updatedAt) || (typeof session.time?.updated === "number" ? new Date(session.time.updated).toISOString() : new Date().toISOString())
  return normalizeDigest({
    id: nowID(),
    sessionID,
    projectRoot,
    title: text(session.title) || null,
    createdAt: new Date().toISOString(),
    updatedAt,
    summary: summaryParts.join("\n\n"),
    decisions,
    corrections,
    validations,
    files: list(session.files),
    evidenceRefs: [`session:${sessionID}`],
    redactions: [...new Set([...redacted.redactions, ...redactedUsers.redactions, ...redactedAssistant.redactions])],
  })
}

export async function writeMemorySessionDigest(input: Omit<MemorySessionDigest, "id" | "createdAt" | "updatedAt" | "redactions" | "consumedBy"> & Partial<Pick<MemorySessionDigest, "id" | "createdAt" | "updatedAt" | "redactions" | "consumedBy">>, root?: string) {
  const redacted = redactMemoryText(input.summary)
  const digest = normalizeDigest({
    ...input,
    id: input.id || nowID(),
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: input.updatedAt || new Date().toISOString(),
    summary: redacted.text,
    redactions: [...new Set([...(input.redactions ?? []), ...redacted.redactions])],
    consumedBy: input.consumedBy ?? [],
  })
  return writeDigest(digest, root)
}

export async function writeMemorySessionDigestFromSession(session: unknown, root?: string) {
  const digest = buildMemorySessionDigest(session, root)
  return writeDigest(digest, root)
}

export async function listMemorySessionDigests(root?: string, options: { includeConsumed?: boolean; limit?: number } = {}) {
  const directory = digestDir(root)
  if (!existsSync(directory)) return []
  const projectRoot = root ? memoryPaths(root).root : null
  const files = await readdir(directory).catch(() => [])
  const digests = await Promise.all(files.filter((file) => file.endsWith(".json")).map(async (file) => {
    try {
      const parsed = await readFile(path.join(directory, file), "utf8").then((value) => JSON.parse(value) as Partial<MemorySessionDigest> & Pick<MemorySessionDigest, "id" | "sessionID">)
      return normalizeDigest(parsed)
    } catch {
      return null
    }
  }))
  return digests
    .filter((digest): digest is MemorySessionDigest => Boolean(digest?.id))
    .filter((digest) => !projectRoot || digest.projectRoot === projectRoot)
    .filter((digest) => options.includeConsumed || digest.consumedBy.length === 0)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, Math.max(1, Math.min(500, options.limit ?? 100)))
}

export async function markMemorySessionDigestsConsumed(ids: string[], runID: string, root?: string) {
  const uniqueIDs = [...new Set(ids.filter(Boolean))]
  const digests = await Promise.all(uniqueIDs.map(async (id) => {
    const file = digestPath(root, id)
    if (!existsSync(file)) return null
    try {
      const parsed = await readFile(file, "utf8").then((value) => JSON.parse(value) as Partial<MemorySessionDigest> & Pick<MemorySessionDigest, "id" | "sessionID">)
      const next = normalizeDigest({ ...parsed, consumedBy: [...(parsed.consumedBy ?? []), runID] })
      return writeDigest(next, root)
    } catch {
      return null
    }
  }))
  return digests.filter((digest): digest is MemorySessionDigest => Boolean(digest))
}
