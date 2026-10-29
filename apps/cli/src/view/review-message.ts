import { locationLabel, type ReviewComment } from "./review-comments"

/**
 * "Send review": every comment of the session becomes one user message to the agent, wrapped in
 * `<mendcode_review_context>` like v1 wraps its review workspace summary. Each entry names the file and line range, quotes the
 * diff rows it is about and carries the comment:
 *
 *     <mendcode_review_context>
 *     MendCode review workspace:
 *     - Comments: 2 on 1 file (branch main)
 *
 *     1. user comment src/a.ts:11-12
 *        ```diff
 *        -removed line
 *        +added line one
 *        ```
 *        comment: Why was this removed?
 *     </mendcode_review_context>
 */
export const REVIEW_TAG = "mendcode_review_context"

/** Room left under the protocol's inline text limit (64 KiB) for the rest of the message. */
const MAX_MESSAGE = 60_000
const EXCERPT_STEPS = [40, 12, 4, 0] as const
const INDENT = "   "

function entry(comment: ReviewComment, index: number, excerptRows: number): string[] {
  const lines = [`${index + 1}. ${comment.author ?? "user"} comment ${locationLabel(comment)}`]
  const quoted = comment.excerpt.slice(0, excerptRows)
  if (quoted.length > 0) {
    lines.push(`${INDENT}\`\`\`diff`)
    for (const row of quoted) lines.push(`${INDENT}${row}`)
    if (comment.excerpt.length > quoted.length) lines.push(`${INDENT}… ${comment.excerpt.length - quoted.length} more rows`)
    lines.push(`${INDENT}\`\`\``)
  }
  const [first = "", ...rest] = comment.body.split("\n")
  lines.push(`${INDENT}comment: ${first}`, ...rest.map((row) => `${INDENT}         ${row}`))
  return lines
}

/** The review message for `comments`, in the order they were written. Empty string when there are none. */
export function reviewMessage(input: { comments: readonly ReviewComment[]; branch?: string }): string {
  const { comments } = input
  if (comments.length === 0) return ""
  const files = new Set(comments.map((comment) => comment.path)).size
  const head = [
    `<${REVIEW_TAG}>`,
    "MendCode review workspace:",
    `- Comments: ${comments.length} on ${files} ${files === 1 ? "file" : "files"}${input.branch ? ` (branch ${input.branch})` : ""}`,
  ]
  let message = ""
  for (const rows of EXCERPT_STEPS) {
    message = [...head, "", ...comments.flatMap((comment, index) => entry(comment, index, rows)), `</${REVIEW_TAG}>`].join("\n")
    if (message.length <= MAX_MESSAGE) break
  }
  return message
}
