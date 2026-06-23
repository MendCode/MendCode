import type { ReviewComment, ReviewCommentAuthor, ReviewFile, ReviewLineSide, ReviewState } from "./review-state"

export type AddReviewCommentInput = {
  author: ReviewCommentAuthor
  filePath: string
  blockIndex: number
  side?: ReviewLineSide
  line?: number
  body: string
  now?: string
}

export function addReviewComment(state: ReviewState, input: AddReviewCommentInput): ReviewState {
  const body = input.body.trim()
  if (!body) return state
  const comment: ReviewComment = {
    id: reviewCommentID(input),
    author: input.author,
    filePath: input.filePath,
    blockIndex: input.blockIndex,
    side: input.side ?? "both",
    line: input.line,
    body,
    stale: false,
    createdAt: input.now ?? new Date().toISOString(),
  }
  return { ...state, comments: [...state.comments, comment] }
}

export function clearReviewComments(
  state: ReviewState,
  input?: { staleOnly?: boolean; filePath?: string },
): ReviewState {
  if (!input?.staleOnly && !input?.filePath) return { ...state, comments: [] }
  return {
    ...state,
    comments: state.comments.filter((comment) => {
      if (input.filePath && comment.filePath !== input.filePath) return true
      if (input.staleOnly && !comment.stale) return true
      return false
    }),
  }
}

export function commentsForBlock(state: ReviewState, filePath: string, blockIndex: number) {
  return state.comments.filter(
    (comment) =>
      comment.filePath === filePath &&
      comment.blockIndex === blockIndex &&
      comment.line === undefined &&
      !comment.stale,
  )
}

export function commentsForLine(
  state: ReviewState,
  filePath: string,
  blockIndex: number,
  line?: number,
  side?: ReviewLineSide,
) {
  if (line === undefined) return []
  return state.comments.filter(
    (comment) =>
      comment.filePath === filePath &&
      comment.blockIndex === blockIndex &&
      comment.line === line &&
      (side === undefined || comment.side === "both" || comment.side === side) &&
      !comment.stale,
  )
}

export function reconcileReviewComments(comments: ReviewComment[], files: ReviewFile[]): ReviewComment[] {
  return comments.map((comment) => {
    const file = files.find((item) => item.path === comment.filePath || item.previousPath === comment.filePath)
    if (!file) return { ...comment, stale: true }
    const block = file.blocks.find((item) => item.index === comment.blockIndex)
    if (!block) return { ...comment, filePath: file.path, stale: true }
    if (comment.line === undefined) return { ...comment, filePath: file.path, stale: false }
    const lineStillExists = block.lines.some((line) => {
      if (comment.side === "old") return line.oldLine === comment.line
      if (comment.side === "new") return line.newLine === comment.line
      return line.oldLine === comment.line || line.newLine === comment.line
    })
    return { ...comment, filePath: file.path, stale: !lineStillExists }
  })
}

export function applyReconciledComments(next: ReviewState, previous: ReviewState): ReviewState {
  return {
    ...next,
    comments: reconcileReviewComments(previous.comments, next.files),
  }
}

function reviewCommentID(input: AddReviewCommentInput) {
  const seed = [
    input.author,
    input.filePath,
    input.blockIndex,
    input.side ?? "both",
    input.line ?? "block",
    input.body.trim(),
    input.now ?? Date.now(),
  ].join(":")
  let hash = 2166136261
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return `rc_${(hash >>> 0).toString(36)}`
}
