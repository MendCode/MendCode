import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./review.txt"
import { InstanceState } from "@/effect/instance-state"
import { loadWorkspaceDiff } from "@/cli/cmd/tui/routes/changes/load-diff"
import {
  getActiveReviewState,
  reviewCommentAdd,
  reviewCommentClear,
  reviewCommentList,
  reviewGetFile,
  reviewNavigate,
  reviewReload,
  reviewSummary,
} from "@/cli/cmd/tui/routes/changes/review-actions"

const Action = Schema.Literals([
  "current",
  "summary",
  "file",
  "navigate",
  "reload",
  "comment_add",
  "comment_list",
  "comment_clear",
])

const Direction = Schema.Literals(["next-file", "prev-file", "next-block", "prev-block"])
const Author = Schema.Literals(["user", "agent", "assistant"])
const Side = Schema.Literals(["old", "new", "both"])

export const Parameters = Schema.Struct({
  action: Action.annotate({
    description: "Review workspace action.",
  }),
  filePath: Schema.optional(Schema.String).annotate({
    description: "File path for file, navigate, comment_add, or comment_clear.",
  }),
  blockIndex: Schema.optional(Schema.Number).annotate({
    description: "Zero-based diff block index for navigate or comment_add.",
  }),
  line: Schema.optional(Schema.Number).annotate({
    description: "Line number for comment_add.",
  }),
  side: Schema.optional(Side).annotate({
    description: "Diff side for comment_add line anchors.",
  }),
  body: Schema.optional(Schema.String).annotate({
    description: "Comment body for comment_add.",
  }),
  author: Schema.optional(Author).annotate({
    description: "Comment author. Defaults to assistant.",
  }),
  direction: Schema.optional(Direction).annotate({
    description: "Navigation direction for navigate.",
  }),
  includePatch: Schema.optional(Schema.Boolean).annotate({
    description: "For file action only. Include raw patch for the selected or requested file.",
  }),
  staleOnly: Schema.optional(Schema.Boolean).annotate({
    description: "For comment_clear only. Clear only stale comments.",
  }),
})

type Metadata = {
  action: Schema.Schema.Type<typeof Parameters>["action"]
  files?: number
  comments?: number
  selectedFile?: string
  selectedBlock?: number
}

export const ReviewTool = Tool.define<typeof Parameters, Metadata, never>(
  "review",
  Effect.gen(function* () {
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, _ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const root = instance.worktree || instance.directory

          if (params.action === "reload") {
            const loaded = loadWorkspaceDiff(root)
            if (loaded.error) return output(params.action, loaded.error, root)
            const state = reviewReload(root, loaded.diff)
            return output(
              params.action,
              state ? JSON.stringify(reviewSummary(root), null, 2) : "No review state.",
              root,
            )
          }

          if (!getActiveReviewState(root)) {
            const loaded = loadWorkspaceDiff(root)
            if (!loaded.error) reviewReload(root, loaded.diff)
          }

          if (params.action === "current" || params.action === "summary") {
            const summary = reviewSummary(root)
            return output(
              params.action,
              summary ? JSON.stringify(summary, null, 2) : "No active review workspace.",
              root,
            )
          }

          if (params.action === "file") {
            const file = reviewGetFile(root, params.filePath, params.includePatch === true)
            return output(params.action, file ? JSON.stringify(file, null, 2) : "Review file not found.", root)
          }

          if (params.action === "navigate") {
            const next = params.direction
              ? reviewNavigate(root, { direction: normalizeDirection(params.direction) })
              : reviewNavigate(root, {
                  filePath: params.filePath,
                  blockIndex: params.blockIndex,
                })
            return output(
              params.action,
              next ? JSON.stringify(reviewSummary(root), null, 2) : "No active review workspace.",
              root,
            )
          }

          if (params.action === "comment_add") {
            if (!params.filePath) return output(params.action, "filePath is required for comment_add", root)
            const blockIndex = params.blockIndex
            if (blockIndex === undefined) return output(params.action, "blockIndex is required for comment_add", root)
            if (!params.body?.trim()) return output(params.action, "body is required for comment_add", root)
            const next = reviewCommentAdd(root, {
              filePath: params.filePath,
              blockIndex: blockIndex,
              line: params.line,
              side: params.side,
              body: params.body,
              author: params.author,
            })
            return output(
              params.action,
              next ? JSON.stringify(reviewCommentList(root), null, 2) : "No active review workspace.",
              root,
            )
          }

          if (params.action === "comment_list") {
            return output(params.action, JSON.stringify(reviewCommentList(root), null, 2), root)
          }

          if (params.action === "comment_clear") {
            const next = reviewCommentClear(root, {
              staleOnly: params.staleOnly,
              filePath: params.filePath,
            })
            return output(
              params.action,
              next ? JSON.stringify(reviewCommentList(root), null, 2) : "No active review workspace.",
              root,
            )
          }

          return output(params.action, `Unsupported review action ${params.action}`, root)
        }),
    }
  }),
)

function output(action: Metadata["action"], text: string, root: string) {
  const summary = reviewSummary(root)
  return {
    title: `Review ${action}`,
    output: text,
    metadata: {
      action,
      files: summary?.stats.files,
      comments: reviewCommentList(root).length,
      selectedFile: summary?.selection.filePath,
      selectedBlock: summary?.selection.blockIndex,
    },
  }
}

function normalizeDirection(direction: Schema.Schema.Type<typeof Direction>) {
  if (direction === "next-block") return "next-block"
  if (direction === "prev-block") return "prev-block"
  return direction
}
