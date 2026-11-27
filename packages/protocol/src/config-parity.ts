import { z } from "zod"
import { lazySchema } from "./lazy"

/**
 * Configuration parity between a device and its hub (docs/sync.md, "Keeping the hub like this machine"). The hub side answers
 * `manifest`, takes a bundle in pieces (`stage`) and applies it (`apply`); `run` is this machine's own request to compare with a
 * saved remote and, with `apply`, bring it level. Only a local client sends `run`; only a local client or a full (never a sync,
 * run, bot or read-only) token sends the others.
 */

/** Raw bytes in one `stage` piece (well inside a 256 KiB frame once base64 encoded). */
export const PARITY_CHUNK_BYTES = 128 * 1024
/** The most a staged bundle holds; a bigger difference is reported, not sent. */
export const PARITY_MAX_BUNDLE_BYTES = 32 * 1024 * 1024

const id = z.string().regex(/^[a-f0-9]{16,64}$/)
const sha = z.string().regex(/^[0-9a-f]{64}$/)

export const ConfigParityInput = lazySchema(() => z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("manifest"), tools: z.boolean().optional() }),
  z.strictObject({ op: z.literal("stage"), id, offset: z.number().int().nonnegative(), total: z.number().int().positive().max(PARITY_MAX_BUNDLE_BYTES), data: z.string().max(Math.ceil(PARITY_CHUNK_BYTES * 4 / 3) + 8) }),
  z.strictObject({ op: z.literal("apply"), id, sha256: sha }),
  z.strictObject({ op: z.literal("run"), remote: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(), apply: z.boolean().optional(), allowFlagged: z.array(z.string().min(1).max(512)).max(50).optional(), allowCode: z.boolean().optional() }),
]))
export type ConfigParityInput = z.infer<typeof ConfigParityInput>
