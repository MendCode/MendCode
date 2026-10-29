import { z } from "zod"
import { lazySchema } from "./lazy"

/** Own-session metadata only. Linking/refreshing a PR runs gh on demand, never on a timer. */
export const SessionMetaInput = lazySchema(() => z.strictObject({
  action: z.enum(["rename", "regenerate_title", "link_pr", "unlink_pr", "settle", "restore", "pin", "rules", "check"]),
  title: z.string().min(1).max(200).optional(),
  pr: z.string().min(1).max(2048).optional(),
  reason: z.string().min(1).max(400).optional(),
  pinned: z.boolean().optional(),
  inactiveDays: z.number().int().min(1).max(3650).nullable().optional(),
  prClosed: z.boolean().optional(),
  disabled: z.boolean().optional(),
}))
export type SessionMetaInput = z.infer<typeof SessionMetaInput>

/**
 * The unsent draft of a session, as a list row needs it. `preview` is the first line the user typed (attachment tokens left out,
 * empty for a draft of attachments only) and `chars` is the typed size, so a list can label a session with no title `Draft · …`
 * without reading the draft. A read-only token never gets it (it cannot call `draft.get` either).
 */
export const SessionDraft = lazySchema(() => z.strictObject({
  preview: z.string().max(200),
  chars: z.number().int().nonnegative(),
  attachments: z.number().int().nonnegative(),
  images: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}))
export type SessionDraft = z.infer<typeof SessionDraft>

export const SessionLifecycle = lazySchema(() => z.strictObject({
  pinnedAt: z.number().int().nonnegative().optional(),
  settledReason: z.string().max(400).optional(),
  pr: z.strictObject({ number: z.number().int().positive(), url: z.string().max(2048), title: z.string().max(200), state: z.enum(["OPEN", "MERGED", "CLOSED"]), branch: z.string().max(200), checkedAt: z.number().int().nonnegative() }).optional(),
  rules: z.strictObject({ inactiveDays: z.number().int().min(1).max(3650).optional(), prClosed: z.boolean().optional(), disabled: z.boolean().optional() }).optional(),
}))
export type SessionLifecycle = z.infer<typeof SessionLifecycle>
