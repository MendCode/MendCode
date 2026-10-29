import { z } from "zod"
import { MAX_BODY, MAX_COMMENTS, MAX_EXCERPT_ROWS } from "./review-data"
import { lazySchema } from "./lazy"

const Range = lazySchema(() => z.strictObject({ from: z.number().int().nonnegative(), to: z.number().int().nonnegative() }).refine((range) => range.to >= range.from, "invalid range"))
export const ReviewComment = lazySchema(() => z.strictObject({
  id: z.string().min(1).max(40),
  path: z.string().min(1).max(1024),
  kind: z.enum(["line", "hunk", "file"]),
  hunk: z.number().int().min(-1),
  header: z.string().max(400),
  excerpt: z.array(z.string().max(480)).max(MAX_EXCERPT_ROWS),
  newRange: Range.optional(),
  oldRange: Range.optional(),
  author: z.enum(["user", "agent", "assistant"]).optional(),
  side: z.enum(["old", "new", "both"]).optional(),
  stale: z.boolean().optional(),
  body: z.string().trim().min(1).max(MAX_BODY),
  createdAt: z.number().int().nonnegative(),
}))
export const ReviewSelection = lazySchema(() => z.strictObject({
  filePath: z.string().min(1).max(1024).optional(),
  blockIndex: z.number().int().nonnegative().optional(),
  row: z.number().int().nonnegative().optional(),
}))
export const ReviewSnapshot = lazySchema(() => z.strictObject({
  revision: z.number().int().nonnegative(),
  selection: ReviewSelection,
  comments: z.array(ReviewComment).max(MAX_COMMENTS),
}))
export type ReviewSnapshot = z.infer<typeof ReviewSnapshot>

export const ReviewRead = lazySchema(() => z.strictObject({
  action: z.enum(["current", "summary", "file", "comment_list"]).default("current"),
  filePath: z.string().min(1).max(1024).optional(),
  includePatch: z.boolean().optional(),
}))
export const ReviewChange = lazySchema(() => z.strictObject({
  action: z.enum(["reload", "navigate", "comment_add", "comment_clear", "sync"]),
  filePath: z.string().min(1).max(1024).optional(),
  blockIndex: z.number().int().nonnegative().optional(),
  line: z.number().int().positive().optional(),
  side: z.enum(["old", "new", "both"]).optional(),
  body: z.string().trim().min(1).max(MAX_BODY).optional(),
  author: z.enum(["user", "agent", "assistant"]).optional(),
  direction: z.enum(["next-file", "prev-file", "next-block", "prev-block"]).optional(),
  staleOnly: z.boolean().optional(),
  /** Targeted client edits, never a wholesale replacement of shared comments. */
  upsert: z.array(ReviewComment).max(MAX_COMMENTS).optional(),
  remove: z.array(z.string().min(1).max(40)).max(MAX_COMMENTS).optional(),
  selection: ReviewSelection.optional(),
}))
export type ReviewRead = z.infer<typeof ReviewRead>
export type ReviewChange = z.infer<typeof ReviewChange>
