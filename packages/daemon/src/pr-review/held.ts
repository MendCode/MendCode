import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { z } from "zod"
import type { ReviewInfo } from "./publish"
import type { PrReviewResult } from "@mendcode/protocol"

/** Finished reviews kept per daemon while posting is not allowed; the oldest go first. */
export const MAX_HELD_REVIEWS = 40

/** A finished review that was not posted for lack of consent: everything `publishReview` needs, so posting it later needs no model call. */
export type HeldReview = {
  sessionId: string
  directory: string
  repo: string
  number: number
  head: string
  result: PrReviewResult
  forge?: string | undefined
  jobId?: string | undefined
  configKey?: string | undefined
  info?: ReviewInfo | undefined
  template?: unknown
  sections?: Record<string, string> | undefined
  at: number
}

const Entry = z.object({
  sessionId: z.string().max(200), directory: z.string().max(4096), repo: z.string().max(300), number: z.number().int().positive(), head: z.string().max(100),
  result: z.custom<PrReviewResult>((value) => typeof value === "object" && value !== null),
  forge: z.string().max(40).optional(), jobId: z.string().max(200).optional(), configKey: z.string().max(200).optional(),
  info: z.custom<ReviewInfo>((value) => typeof value === "object" && value !== null).optional(),
  template: z.unknown().optional(), sections: z.record(z.string(), z.string()).optional(), at: z.number(),
})
const File = z.object({ version: z.literal(1), reviews: z.array(Entry).max(MAX_HELD_REVIEWS) })

/**
 * Reviews finished while the repository had no `/pr publish on` answer, kept in `<dataDir>/pr-review/held.json` so a daemon restart
 * does not lose them: `/pr publish on` takes the repository's entries and posts them as they were found (docs/pr-review.md).
 * One entry per pull request: a newer review of the same PR replaces the older one.
 */
export function createHeldStore(file: string) {
  let entries = load()
  function load(): HeldReview[] {
    try {
      const parsed = File.safeParse(JSON.parse(readFileSync(file, "utf8")))
      return parsed.success ? (parsed.data.reviews as HeldReview[]) : []
    } catch { return [] }
  }
  function save() {
    try {
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
      const temp = `${file}.${crypto.randomUUID()}.tmp`
      writeFileSync(temp, JSON.stringify({ version: 1, reviews: entries }), { mode: 0o600, flag: "wx" })
      renameSync(temp, file)
    } catch { /* kept in memory until the daemon stops */ }
  }
  return {
    add(entry: HeldReview) {
      entries = [...entries.filter((item) => !(item.directory === entry.directory && item.number === entry.number)), entry].slice(-MAX_HELD_REVIEWS)
      save()
    },
    /** Removes and returns the repository's held reviews, oldest first. */
    take(directory: string): HeldReview[] {
      const taken = entries.filter((item) => item.directory === directory)
      if (!taken.length) return []
      entries = entries.filter((item) => item.directory !== directory)
      save()
      return taken
    },
    count: (directory: string) => entries.filter((item) => item.directory === directory).length,
  }
}
export type HeldStore = ReturnType<typeof createHeldStore>
