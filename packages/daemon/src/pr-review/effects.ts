import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { z } from "zod"
import type { Effect, EffectLedger } from "./contracts"

/**
 * The remote-effects ledger (docs/pr-review.md, R03): every write to the provider (a review, a reply, a resolved thread, a push,
 * a claim) is recorded as `pending` in `<dataDir>/pr-review/effects.json` before it is sent and marked `done` with what the
 * provider returned. The record is what makes a retry safe without promising exactly-once:
 *
 * - `intend` with a key already `done` returns that effect unchanged: the caller must not send it again.
 * - `intend` with a key still `pending` returns the same pending effect: the earlier send may have reached the provider (a crash
 *   or a timeout after a successful post), so the caller reads the remote first (the marker, the branch tip) and calls `done`
 *   when it is there, sends again only when it is not.
 * - An `abandoned` effect is intended again under the same id (the work was dropped, a later attempt may send it).
 *
 * Written atomically (temp + rename, 0600) on every change, so pending effects survive a restart. Bounded at `retain`: finished
 * effects (done, abandoned) go first, oldest first; a pending one is dropped only when more than `retain` are pending at once.
 * A damaged file is kept aside (`.corrupt-<time>`) and the ledger starts empty; the remote markers still stop a double post.
 */

export const DEFAULT_EFFECT_RETAIN = 2000

const Stored = z.object({
  id: z.string().min(1).max(80),
  kind: z.enum(["review", "comment", "reply", "resolve", "push", "claim"]),
  key: z.string().min(1).max(20_000),
  jobId: z.string().max(80).optional(),
  state: z.enum(["pending", "done", "abandoned"]),
  createdAt: z.number(),
  updatedAt: z.number(),
  remote: z.string().max(500).optional(),
  marker: z.string().max(500).optional(),
  /** Why it was abandoned, for the job's detail. */
  reason: z.string().max(600).optional(),
})
export type StoredEffect = Effect & { reason?: string | undefined }
const File = z.object({ version: z.literal(1), effects: z.array(z.unknown()) })

export type EffectLedgerOptions = { file: string; now?: () => number; retain?: number }
export type EffectLedgerService = EffectLedger & {
  readonly file: string
  get(id: string): StoredEffect | undefined
  /** The effects of one job, oldest first. */
  ofJob(jobId: string): StoredEffect[]
}

export function createEffectLedger({ file, now = Date.now, retain = DEFAULT_EFFECT_RETAIN }: EffectLedgerOptions): EffectLedgerService {
  let effects: StoredEffect[] = load()

  function load(): StoredEffect[] {
    let text: string
    try { text = readFileSync(file, "utf8") } catch { return [] }
    let items: unknown[] | undefined
    try { const parsed = File.safeParse(JSON.parse(text)); if (parsed.success) items = parsed.data.effects } catch { /* kept aside below */ }
    if (!items) { keepAside(true); return [] }
    const valid = items.flatMap((item) => { const effect = Stored.safeParse(item); return effect.success ? [effect.data as StoredEffect] : [] })
    if (valid.length !== items.length) keepAside(false)
    return valid
  }
  function keepAside(move: boolean) {
    const aside = `${file}.corrupt-${now()}`
    try { if (move) renameSync(file, aside); else copyFileSync(file, aside) } catch { /* nothing to keep */ }
  }
  function prune() {
    if (effects.length <= retain) return
    const finished = effects.filter((effect) => effect.state !== "pending").toSorted((a, b) => a.updatedAt - b.updatedAt)
    const drop = new Set(finished.slice(0, effects.length - retain))
    effects = effects.filter((effect) => !drop.has(effect))
    // Only when pending effects alone exceed the bound: the oldest go (their markers still guard the remote).
    if (effects.length > retain) effects = effects.toSorted((a, b) => a.createdAt - b.createdAt).slice(effects.length - retain)
  }
  function save() {
    prune()
    try {
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
      const temp = `${file}.${crypto.randomUUID()}.tmp`
      writeFileSync(temp, JSON.stringify({ version: 1, effects }), { mode: 0o600, flag: "wx" })
      renameSync(temp, file)
    } catch { /* an unsaved effect still holds until the daemon stops */ }
  }
  const copy = (effect: StoredEffect): StoredEffect => ({ ...effect })
  const indexOf = (id: string) => {
    const index = effects.findIndex((effect) => effect.id === id)
    if (index < 0) throw new RangeError(`[PR_REVIEW]: no effect ${id}`)
    return index
  }
  function put(index: number, next: StoredEffect) {
    const parsed = Stored.safeParse(next)
    if (!parsed.success) throw new RangeError(`[PR_REVIEW]: invalid effect ${next.id}: ${parsed.error.issues[0]?.message ?? "unknown"}`)
    const stored = parsed.data as StoredEffect
    effects[index] = stored
    save()
    return copy(stored)
  }

  return {
    file,
    intend({ kind, key, jobId, marker }) {
      const index = effects.findIndex((effect) => effect.key === key)
      const existing = effects[index]
      if (existing && existing.state !== "abandoned") return copy(existing)
      const at = now()
      if (existing) {
        const { reason: _reason, ...rest } = existing
        return put(index, { ...rest, state: "pending", updatedAt: at, ...(jobId ? { jobId } : {}), ...(marker ? { marker } : {}) })
      }
      const effect: StoredEffect = { id: `pre_${at.toString(36)}${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`, kind, key, state: "pending", createdAt: at, updatedAt: at, ...(jobId ? { jobId } : {}), ...(marker ? { marker } : {}) }
      return put(effects.length, effect)
    },
    /** The provider has it (sent now, or found by a reconciliation). Done twice is the same effect. */
    done(id, remote) {
      const index = indexOf(id)
      const effect = effects[index]!
      if (effect.state === "done") return copy(effect)
      const { reason: _reason, ...rest } = effect
      return put(index, { ...rest, state: "done", updatedAt: now(), ...(remote ? { remote } : {}) })
    },
    /** Dropped without sending (the head moved, the job was cancelled). A `done` effect happened and cannot be abandoned. */
    abandon(id, reason) {
      const index = indexOf(id)
      const effect = effects[index]!
      if (effect.state === "done") throw new RangeError(`[PR_REVIEW]: effect ${id} was already sent`)
      return put(index, { ...effect, state: "abandoned", updatedAt: now(), reason: reason.slice(0, 600) })
    },
    pending: () => effects.filter((effect) => effect.state === "pending").map(copy),
    byKey(key) {
      const effect = effects.find((item) => item.key === key)
      return effect && copy(effect)
    },
    get(id) {
      const effect = effects.find((item) => item.id === id)
      return effect && copy(effect)
    },
    ofJob: (jobId) => effects.filter((effect) => effect.jobId === jobId).map(copy),
  }
}
