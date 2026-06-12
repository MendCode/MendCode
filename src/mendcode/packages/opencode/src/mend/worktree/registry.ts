import { existsSync } from "fs"
import { mkdir, readFile, writeFile } from "fs/promises"
import path from "path"
import { mendPaths } from "../config/paths"
import type {
  GitWorktreeEntry,
  WorktreeManagerState,
  WorktreePassport,
  WorktreeReconciliation,
  WorktreeRecord,
} from "./types"

export function worktreeStatePath(root?: string) {
  return path.join(mendPaths(root).mendDir, "worktree", "state.json")
}

export function emptyWorktreeState(now = new Date().toISOString()): WorktreeManagerState {
  return {
    version: 1,
    branchPrefix: "mend/",
    defaultExecutor: "native",
    worktrees: {},
    operations: {},
    updatedAt: now,
  }
}

export async function readWorktreeState(root?: string): Promise<WorktreeManagerState> {
  const file = worktreeStatePath(root)
  if (!existsSync(file)) return emptyWorktreeState()
  const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<WorktreeManagerState>
  return {
    ...emptyWorktreeState(parsed.updatedAt),
    ...parsed,
    version: 1,
    worktrees: parsed.worktrees || {},
    operations: parsed.operations || {},
  }
}

export async function writeWorktreeState(state: WorktreeManagerState, root?: string) {
  const file = worktreeStatePath(root)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`)
}

export function worktreeRecordID(input: Pick<WorktreePassport, "repoRoot" | "path" | "branch">) {
  const key = `${input.repoRoot}\0${input.path}\0${input.branch || ""}`
  return Buffer.from(key).toString("base64url")
}

export function createWorktreeRecord(
  input: WorktreePassport & { id?: string; ownership?: "owned" | "adopted" | "external"; now?: string; dirty?: WorktreeRecord["dirty"] },
): WorktreeRecord {
  const now = input.now || new Date().toISOString()
  const id = input.id || worktreeRecordID(input)
  return {
    id,
    creator: input.creator,
    ownership: input.ownership || (input.creator === "user-adopted" ? "adopted" : "owned"),
    repoRoot: input.repoRoot,
    path: input.path,
    branch: input.branch,
    baseRef: input.baseRef,
    executor: input.executor,
    sessions: input.sessions,
    packages: input.packages,
    mflowMode: input.mflowMode,
    creationPlan: input.creationPlan,
    cleanupPolicy: input.cleanupPolicy,
    dirty: input.dirty || { checkedAt: now, clean: true, summary: "not checked" },
    lastReconciledAt: null,
    drift: [],
    createdAt: now,
    updatedAt: now,
  }
}

export async function saveWorktreeRecord(record: WorktreeRecord, root?: string) {
  const state = await readWorktreeState(root)
  state.worktrees[record.id] = { ...record, updatedAt: new Date().toISOString() }
  await writeWorktreeState(state, root)
  return state.worktrees[record.id]!
}

export function reconcileWorktreeState(
  state: WorktreeManagerState,
  gitEntries: GitWorktreeEntry[],
  now = new Date().toISOString(),
): WorktreeReconciliation {
  const gitByPath = new Map(gitEntries.map((entry) => [entry.path, entry]))
  const records = Object.values(state.worktrees).map((record) => {
    const git = gitByPath.get(record.path)
    if (!git) return { ...record, ownership: "stale" as const, lastReconciledAt: now, drift: ["missing-from-git"] }
    if ((git.branch || null) !== (record.branch || null)) {
      return {
        ...record,
        ownership: "drifted" as const,
        lastReconciledAt: now,
        drift: [`branch registry=${record.branch || "none"} git=${git.branch || "none"}`],
      }
    }
    return { ...record, lastReconciledAt: now, drift: [] }
  })
  const managedPaths = new Set(records.map((record) => record.path))
  return {
    records,
    external: gitEntries.filter((entry) => !managedPaths.has(entry.path)),
    stale: records.filter((record) => record.ownership === "stale"),
    drifted: records.filter((record) => record.ownership === "drifted"),
  }
}
