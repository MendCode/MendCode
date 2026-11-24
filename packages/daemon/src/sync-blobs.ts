import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { MAX_SYNC_BLOB_CHUNK_BYTES, type SyncBlobPutInput } from "@mendcode/protocol"
import type { Store } from "@mendcode/store"
import { ProjectRestError } from "./project-git"

/** Blobs mid-upload, at most this many at once (the oldest is dropped). */
const MAX_STAGED_BLOBS = 4
type Put = import("zod").infer<typeof SyncBlobPutInput>

/**
 * Chunked blob upload for sync (REST replay and daemon-to-daemon sync): chunks of at most 128 KiB arrive in order, staged in
 * memory and bounded, and the last one checks the hash before the blob is stored. Callers are serialized, so no locking.
 */
export function createBlobStaging(store: Pick<Store, "blobPath" | "readBlob" | "putBlob">) {
  const staging = new Map<string, { bytes: number; mime: string; chunks: Buffer[]; received: number }>()
  const fail = (code: ConstructorParameters<typeof ProjectRestError>[0], message: string): never => { throw new ProjectRestError(code, message) }
  const stored = (sha256: string, bytes: number) => existsSync(store.blobPath(sha256)) && store.readBlob(sha256).length === bytes
  return {
    stored,
    put(request: Put) {
      const chunk = Buffer.from(request.data, "base64")
      if (!chunk.byteLength || chunk.byteLength > MAX_SYNC_BLOB_CHUNK_BYTES || chunk.toString("base64") !== request.data) fail("invalid_command", "Blob chunk is not valid base64 of at most 128 KiB")
      if (stored(request.sha256, request.bytes)) { staging.delete(request.sha256); return { sha256: request.sha256, bytes: request.bytes, received: request.bytes, stored: true } }
      let entry = staging.get(request.sha256)
      if (request.offset === 0) {
        staging.delete(request.sha256)
        while (staging.size >= MAX_STAGED_BLOBS) staging.delete(staging.keys().next().value!)
        entry = { bytes: request.bytes, mime: request.mime, chunks: [], received: 0 }
        staging.set(request.sha256, entry)
      }
      if (!entry || entry.received !== request.offset || entry.bytes !== request.bytes) fail("busy", `Blob chunk out of order; expected offset ${entry?.received ?? 0}`)
      if (entry!.received + chunk.byteLength > entry!.bytes) fail("invalid_command", "Blob chunk exceeds the declared size")
      entry!.chunks.push(chunk)
      entry!.received += chunk.byteLength
      if (entry!.received < entry!.bytes) return { sha256: request.sha256, bytes: entry!.bytes, received: entry!.received, stored: false }
      staging.delete(request.sha256)
      const bytes = Buffer.concat(entry!.chunks)
      if (createHash("sha256").update(bytes).digest("hex") !== request.sha256) fail("invalid_command", "Blob content does not match its hash")
      store.putBlob(bytes, entry!.mime)
      return { sha256: request.sha256, bytes: entry!.bytes, received: entry!.received, stored: true }
    },
  }
}
