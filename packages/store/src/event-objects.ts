import type { Database } from "bun:sqlite"

/** Packed tool output (base64 of its zstd bytes) shorter than this stays inside its event row. */
export const SHARE_MIN_CHARS = 512

// Fixed binary hash in the shared-message envelope. Undo stashes are readers too.
const modelHashes = `SELECT lower(hex(substr(payload, 10, 32))) FROM engine_messages WHERE substr(payload, 1, 5) = X'004D5A3145'
  UNION SELECT lower(hex(substr(payload, 10, 32))) FROM undone_messages WHERE substr(payload, 1, 5) = X'004D5A3145'`
const orphan = `NOT EXISTS (SELECT 1 FROM event_object_refs r WHERE r.sha256 = event_objects.sha256)
  AND sha256 NOT IN (${modelHashes})`

/**
 * Large tool output shared between a session and its forks. A packed event (`text` = base64 zstd, `z` = original
 * length) keeps its JSON shape and swaps `text` for `""` plus `zref`, the sha256 of the zstd bytes; the bytes live once in
 * `event_objects`. Each session whose events point at an object holds a row in `event_object_refs`, so the object goes
 * with its last reader (a delete cascades the reference; `sweep` removes what nothing references).
 */
export function createEventObjects(db: Database) {
  const put = db.query("INSERT OR IGNORE INTO event_objects(sha256, bytes, data) VALUES (?, ?, ?)")
  const refer = db.query("INSERT OR IGNORE INTO event_object_refs(sha256, session_id) VALUES (?, ?)")
  const get = db.query<{ data: Uint8Array }, [string]>("SELECT data FROM event_objects WHERE sha256 = ?")
  const sessionRefs = db.query<{ sha256: string }, [string]>(`SELECT sha256 FROM event_object_refs WHERE session_id = ?1
    UNION SELECT lower(hex(substr(payload, 10, 32))) FROM engine_messages WHERE session_id = ?1 AND substr(payload, 1, 5) = X'004D5A3145'
    UNION SELECT lower(hex(substr(payload, 10, 32))) FROM undone_messages WHERE session_id = ?1 AND substr(payload, 1, 5) = X'004D5A3145'`)
  const dropOrphan = db.query(`DELETE FROM event_objects WHERE sha256 = ? AND ${orphan}`)
  const stats = db.query<{ n: number; bytes: number | null; refs: number }, []>("SELECT COUNT(*) AS n, SUM(length(data)) AS bytes, (SELECT COUNT(*) FROM event_object_refs) AS refs FROM event_objects")

  return {
    preview(text: string): string {
      return new Bun.CryptoHasher("sha256").update(Bun.zstdCompressSync(Buffer.from(text), { level: 3 })).digest("hex")
    },
    /** Transcript output and model content use the same zstd frame, so exact repeats have one object. */
    put(text: string): string {
      const bytes = Bun.zstdCompressSync(Buffer.from(text), { level: 3 })
      const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
      put.run(hash, Buffer.byteLength(text), bytes)
      return hash
    },
    /** The base64 zstd text of an object; undefined when it is gone (a reference keeps it from going). */
    load(sha256: string): string | undefined {
      const row = get.get(sha256)
      return row ? Buffer.from(row.data).toString("base64") : undefined
    },
    /**
     * Moves the packed output of `event` (parsed, still packed) into an object and leaves the reference in its place,
     * registered for each of `owners`. False when the event has no packed output worth sharing or already shares it.
     */
    share(event: Record<string, unknown>, owners: readonly string[]): boolean {
      if (typeof event.z !== "number" || typeof event.text !== "string" || event.text.length < SHARE_MIN_CHARS) return false
      const bytes = Buffer.from(event.text, "base64")
      const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
      put.run(sha256, event.z, bytes)
      for (const owner of owners) refer.run(sha256, owner)
      event.text = ""
      event.zref = sha256
      return true
    },
    /** A session whose events were copied from one that already points at `sha256`. */
    refer(sha256: string, sessionId: string) {
      refer.run(sha256, sessionId)
    },
    /** What the session references: collect before deleting it, then `drop` them. */
    referencedBy(sessionId: string): string[] {
      return sessionRefs.all(sessionId).map((row) => row.sha256)
    },
    /** Removes the given objects that no session references any more. */
    drop(sha256s: readonly string[]) {
      for (const sha256 of sha256s) dropOrphan.run(sha256)
    },
    /** Removes every object nothing references; returns how many. */
    sweep(): number {
      return db.query(`DELETE FROM event_objects WHERE ${orphan}`).run().changes
    },
    stats(): { objects: number; objectBytes: number; refs: number } {
      const row = stats.get()
      return { objects: row?.n ?? 0, objectBytes: Number(row?.bytes ?? 0), refs: row?.refs ?? 0 }
    },
  }
}
export type EventObjects = ReturnType<typeof createEventObjects>
