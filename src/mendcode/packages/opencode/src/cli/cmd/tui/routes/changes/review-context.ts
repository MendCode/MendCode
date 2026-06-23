import type { ReviewFile, ReviewState } from "./review-state"
import { activeReviewFile, activeReviewBlock, activeReviewLine, reviewStats } from "./review-state"

export type ReviewSummaryOptions = {
  includePatch?: boolean
  filePath?: string
  maxFiles?: number
  maxBlocksPerFile?: number
  maxComments?: number
}

export function reviewContextSummary(state: ReviewState, options: ReviewSummaryOptions = {}) {
  const stats = reviewStats(state.files)
  const selectedFile = activeReviewFile(state)
  const selectedBlock = activeReviewBlock(state)
  const selectedLine = activeReviewLine(state)
  const files = state.files.slice(0, options.maxFiles ?? 24).map((file) => summarizeFile(file, options))
  const comments = state.comments.slice(0, options.maxComments ?? 40).map((comment) => ({
    id: comment.id,
    author: comment.author,
    filePath: comment.filePath,
    blockIndex: comment.blockIndex,
    line: comment.line,
    stale: comment.stale,
    body: comment.body,
  }))
  return {
    id: state.id,
    workspaceRoot: state.workspaceRoot,
    loadedAt: state.loadedAt,
    stats: {
      files: stats.files,
      additions: stats.additions,
      deletions: stats.deletions,
      blocks: stats.blocks,
    },
    selection: {
      filePath: selectedFile?.path,
      blockIndex: selectedBlock?.index,
      blockHeader: selectedBlock?.header,
      line: selectedLine?.newLine ?? selectedLine?.oldLine,
      lineKind: selectedLine?.kind,
    },
    files,
    comments,
    staleComments: comments.filter((comment) => comment.stale).length,
  }
}

export function reviewContextText(state: ReviewState, options: ReviewSummaryOptions = {}) {
  const summary = reviewContextSummary(state, options)
  const lines = [
    "MendCode review workspace:",
    `- Files: ${summary.stats.files}, diff blocks: ${summary.stats.blocks}, +${summary.stats.additions}/-${summary.stats.deletions}`,
    summary.selection.filePath
      ? `- Selected: ${summary.selection.filePath}${summary.selection.blockHeader ? ` ${summary.selection.blockHeader}` : ""}${summary.selection.line ? ` line ${summary.selection.line} (${summary.selection.lineKind})` : ""}`
      : "- Selected: none",
  ]
  for (const file of summary.files) {
    lines.push(
      `- ${file.path}: ${file.changeType}, +${file.additions}/-${file.deletions}, blocks ${file.blocks.length}`,
    )
  }
  for (const comment of summary.comments) {
    lines.push(
      `- ${comment.stale ? "stale " : ""}${comment.author} comment ${comment.filePath}:${comment.line ?? `block ${comment.blockIndex + 1}`}: ${comment.body}`,
    )
  }
  return lines.join("\n")
}

export function selectedReviewPatch(state: ReviewState, filePath?: string) {
  const file = filePath ? state.files.find((item) => item.path === filePath) : activeReviewFile(state)
  if (!file) return undefined
  return file.rawPatch
}

function summarizeFile(file: ReviewFile, options: ReviewSummaryOptions) {
  const includePatch = options.includePatch && (!options.filePath || options.filePath === file.path)
  return {
    path: file.path,
    previousPath: file.previousPath,
    changeType: file.changeType,
    additions: file.additions,
    deletions: file.deletions,
    blocks: file.blocks.slice(0, options.maxBlocksPerFile ?? 8).map((block) => ({
      index: block.index,
      header: block.header,
      oldStart: block.oldStart,
      oldEnd: block.oldEnd,
      newStart: block.newStart,
      newEnd: block.newEnd,
      additions: block.lines.filter((line) => line.kind === "added").length,
      deletions: block.lines.filter((line) => line.kind === "removed").length,
    })),
    patch: includePatch ? file.rawPatch : undefined,
  }
}
