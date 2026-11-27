import { mkdirSync, rmSync, statSync } from "node:fs"
import { open, rename } from "node:fs/promises"
import { createHash } from "node:crypto"
import path from "node:path"
import { MAX_SYNC_BLOB_CHUNK_BYTES, type SyncPeerInput } from "@mendcode/protocol"
import { SyncRefusal } from "./ingest"

type Put = Extract<SyncPeerInput, { op: "file-put" }>

/** The folder of the files a chat's prompts attached: `<data dir>/uploads/<session>/`. */
export const uploadsDir = (dir: string, sessionId: string) => path.join(dir, "uploads", sessionId)

/** Removes what a deleted chat's prompts attached (best effort). */
export function dropUploads(dir: string, sessionId: string) {
  try { rmSync(uploadsDir(dir, sessionId), { recursive: true, force: true }) } catch {}
}

/** A name that stays inside the folder: no separators or control characters, never hidden, at most 200 characters. */
export function uploadName(name: string): string {
  const clean = path.basename(name.replace(/\\/g, "/")).replace(/[\x00-\x1f\x7f]/g, " ").trim().replace(/^\.+/, "").slice(-200)
  return clean || "file"
}

/**
 * Files a device copies into the uploads folder of a hub chat, in chunks written straight to disk (a file of the size limit is never
 * held in memory). The chunks of one file come in order from offset 0; the last one moves it to its name, one that is not taken yet.
 */
export function createUploads(dir: string) {
  return {
    async put(holder: string, input: Put): Promise<{ received: number; stored: boolean; path?: string }> {
      const chunk = Buffer.from(input.data, "base64")
      if (!chunk.byteLength || chunk.byteLength > MAX_SYNC_BLOB_CHUNK_BYTES || chunk.toString("base64") !== input.data) throw new SyncRefusal("invalid", "file chunk is not valid base64 of at most 128 KiB")
      const folder = uploadsDir(dir, input.sessionId)
      const name = uploadName(input.name)
      // One partial file per device: two devices sending the same name never write into each other's.
      const part = path.join(folder, `.${name}.${createHash("sha256").update(holder).digest("hex").slice(0, 12)}.part`)
      if (input.offset === 0) mkdirSync(folder, { recursive: true })
      else {
        let have = -1
        try { have = statSync(part).size } catch {}
        if (have !== input.offset) throw new SyncRefusal("busy", `file chunk out of order; expected offset ${Math.max(have, 0)}`)
      }
      if (input.offset + chunk.byteLength > input.size) throw new SyncRefusal("invalid", "file chunk exceeds the declared size")
      const handle = await open(part, input.offset === 0 ? "w" : "a")
      try { await handle.write(chunk) } finally { await handle.close() }
      const received = input.offset + chunk.byteLength
      if (received < input.size) return { received, stored: false }
      const final = free(folder, name)
      await rename(part, final)
      return { received, stored: true, path: final }
    },
  }
}

/** `name`, or `stem-2.ext`, `stem-3.ext`… when the folder already has it: an earlier message keeps pointing at its own file. */
function free(folder: string, name: string): string {
  const ext = path.extname(name)
  const stem = name.slice(0, name.length - ext.length)
  for (let n = 1; ; n++) {
    const candidate = path.join(folder, n === 1 ? name : `${stem}-${n}${ext}`)
    try { statSync(candidate) } catch { return candidate }
  }
}
