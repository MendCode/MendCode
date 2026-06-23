import crypto from "crypto"
import fs from "fs"
import os from "os"
import path from "path"
import {
  addReviewComment,
  clearReviewComments,
  reconcileReviewComments,
  type AddReviewCommentInput,
} from "./review-comments"
import { reviewContextSummary, reviewContextText, selectedReviewPatch } from "./review-context"
import {
  activeReviewFile,
  createReviewState,
  selectNextFile,
  selectNextBlock,
  type ReviewSelection,
  type ReviewState,
} from "./review-state"
import { loadWorkspaceDiff } from "./load-diff"

const activeReviews = new Map<string, ReviewState>()

export function setActiveReviewState(state: ReviewState) {
  activeReviews.set(state.workspaceRoot, state)
  writePersistedReviewState(state)
  return state
}

export function getActiveReviewState(workspaceRoot: string) {
  return activeReviews.get(workspaceRoot)
}

export function clearActiveReviewState(workspaceRoot: string) {
  activeReviews.delete(workspaceRoot)
  deletePersistedReviewState(workspaceRoot)
}

export function dropActiveReviewState(workspaceRoot: string) {
  activeReviews.delete(workspaceRoot)
}

export function reviewCurrent(workspaceRoot: string) {
  return getActiveOrHydratedReviewState(workspaceRoot)
}

export function reviewSummary(workspaceRoot: string, options?: Parameters<typeof reviewContextSummary>[1]) {
  const state = getActiveOrHydratedReviewState(workspaceRoot)
  return state ? reviewContextSummary(state, options) : undefined
}

export function reviewContextForAssistant(workspaceRoot: string) {
  const state = getActiveOrHydratedReviewState(workspaceRoot)
  return state ? reviewContextText(state) : undefined
}

export function reviewGetFile(workspaceRoot: string, filePath?: string, includePatch = false) {
  const state = getActiveOrHydratedReviewState(workspaceRoot)
  if (!state) return undefined
  const file = filePath ? state.files.find((item) => item.path === filePath) : activeReviewFile(state)
  if (!file) return undefined
  return {
    ...file,
    rawPatch: includePatch ? selectedReviewPatch(state, file.path) : undefined,
  }
}

export function reviewNavigate(
  workspaceRoot: string,
  selection: ReviewSelection | { direction: "next-file" | "prev-file" | "next-block" | "prev-block" },
) {
  const state = getActiveOrHydratedReviewState(workspaceRoot)
  if (!state) return undefined
  const nextSelection =
    "direction" in selection
      ? selection.direction === "next-file"
        ? selectNextFile(state, 1)
        : selection.direction === "prev-file"
          ? selectNextFile(state, -1)
          : selection.direction === "next-block"
            ? selectNextBlock(state, 1)
            : selectNextBlock(state, -1)
      : selection
  return setActiveReviewState({ ...state, selection: { ...state.selection, ...nextSelection } })
}

export function reviewCommentAdd(
  workspaceRoot: string,
  input: Omit<AddReviewCommentInput, "author"> & { author?: AddReviewCommentInput["author"] },
) {
  const state = getActiveOrHydratedReviewState(workspaceRoot)
  if (!state) return undefined
  return setActiveReviewState(addReviewComment(state, { ...input, author: input.author ?? "assistant" }))
}

export function reviewCommentList(workspaceRoot: string) {
  return getActiveOrHydratedReviewState(workspaceRoot)?.comments ?? []
}

export function reviewCommentClear(workspaceRoot: string, input?: { staleOnly?: boolean; filePath?: string }) {
  const state = getActiveOrHydratedReviewState(workspaceRoot)
  if (!state) return undefined
  return setActiveReviewState(clearReviewComments(state, input))
}

export function reviewReload(workspaceRoot: string, diff: string) {
  const previous = getActiveReviewState(workspaceRoot) ?? readPersistedReviewState(workspaceRoot)
  const next = createReviewState({ workspaceRoot, diff })
  if (!previous) return setActiveReviewState(next)
  return setActiveReviewState({
    ...next,
    selection: {
      filePath: next.files.some((file) => file.path === previous.selection.filePath)
        ? previous.selection.filePath
        : next.files[0]?.path,
      blockIndex: previous.selection.blockIndex,
      lineID: previous.selection.lineID,
    },
    comments: reconcileReviewComments(previous.comments, next.files),
  })
}

type PersistedReviewState = Pick<ReviewState, "workspaceRoot" | "comments" | "selection"> & {
  version: 1
  updatedAt: string
}

function getActiveOrHydratedReviewState(workspaceRoot: string) {
  return getActiveReviewState(workspaceRoot) ?? hydrateReviewState(workspaceRoot)
}

function hydrateReviewState(workspaceRoot: string) {
  if (!persistedReviewStateExists(workspaceRoot)) return undefined
  const loaded = loadWorkspaceDiff(workspaceRoot)
  if (!loaded.diff.trim()) return undefined
  return reviewReload(workspaceRoot, loaded.diff)
}

function readPersistedReviewState(workspaceRoot: string): ReviewState | undefined {
  const snapshot = readPersistedReviewSnapshot(workspaceRoot)
  if (!snapshot) return undefined
  return {
    id: `review:${workspaceRoot}:persisted`,
    workspaceRoot,
    source: "working-tree",
    files: [],
    comments: snapshot.comments,
    selection: snapshot.selection,
    loadedAt: snapshot.updatedAt,
  }
}

function readPersistedReviewSnapshot(workspaceRoot: string): PersistedReviewState | undefined {
  try {
    const raw = fs.readFileSync(reviewStateFile(workspaceRoot), "utf8")
    const parsed = JSON.parse(raw) as Partial<PersistedReviewState>
    if (parsed.version !== 1 || parsed.workspaceRoot !== workspaceRoot) return undefined
    return {
      version: 1,
      workspaceRoot,
      comments: Array.isArray(parsed.comments) ? parsed.comments : [],
      selection: isSelection(parsed.selection) ? parsed.selection : {},
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : new Date().toISOString(),
    }
  } catch {
    return undefined
  }
}

function writePersistedReviewState(state: ReviewState) {
  try {
    const file = reviewStateFile(state.workspaceRoot)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const snapshot: PersistedReviewState = {
      version: 1,
      workspaceRoot: state.workspaceRoot,
      comments: state.comments,
      selection: state.selection,
      updatedAt: new Date().toISOString(),
    }
    fs.writeFileSync(file, JSON.stringify(snapshot, null, 2), "utf8")
  } catch {
    // Review cache is best-effort; the TUI still works with process-local state.
  }
}

function deletePersistedReviewState(workspaceRoot: string) {
  try {
    fs.rmSync(reviewStateFile(workspaceRoot), { force: true })
  } catch {}
}

function persistedReviewStateExists(workspaceRoot: string) {
  try {
    return fs.existsSync(reviewStateFile(workspaceRoot))
  } catch {
    return false
  }
}

function reviewStateFile(workspaceRoot: string) {
  const hash = crypto.createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 24)
  return path.join(os.homedir(), ".mendcode", "cache", "changes-review", `${hash}.json`)
}

function isSelection(value: unknown): value is ReviewSelection {
  if (!value || typeof value !== "object") return false
  const selection = value as Partial<Record<keyof ReviewSelection, unknown>>
  return (
    (selection.filePath === undefined || typeof selection.filePath === "string") &&
    (selection.blockIndex === undefined || typeof selection.blockIndex === "number") &&
    (selection.lineID === undefined || typeof selection.lineID === "string")
  )
}
