/**
 * The blobs `attachment.read` is serving chunk by chunk, held between chunks: a 4 MB screenshot is about 40 chunks, and reading
 * (and, with privacy on, unsealing) the whole file again for each one cost more than sending it. A blob leaves when its last chunk
 * is served, when more than `keep` are being read at once, or `ttlMs` after its last chunk was asked for.
 */
export function createBlobReads({ read, keep = 3, ttlMs = 3_000 }: { read(sha256: string): Buffer; keep?: number; ttlMs?: number }) {
  const held = new Map<string, { bytes: Buffer; timer: ReturnType<typeof setTimeout> }>()

  function drop(sha256: string) {
    const entry = held.get(sha256)
    if (!entry) return
    clearTimeout(entry.timer)
    held.delete(sha256)
  }

  return {
    /** `length` bytes of the blob from `offset`; the chunk that reaches its end lets the blob go. */
    chunk(sha256: string, offset: number, length: number): Buffer {
      let entry = held.get(sha256)
      if (entry) {
        clearTimeout(entry.timer)
        held.delete(sha256)
      } else {
        const bytes = read(sha256)
        if (offset + length >= bytes.length) return bytes.subarray(offset, offset + length)
        entry = { bytes, timer: undefined as never }
      }
      const part = entry.bytes.subarray(offset, offset + length)
      if (offset + length >= entry.bytes.length) return part
      entry.timer = setTimeout(() => drop(sha256), ttlMs)
      entry.timer.unref?.()
      held.set(sha256, entry)
      while (held.size > keep) drop(held.keys().next().value!)
      return part
    },
    get size() {
      return held.size
    },
  }
}

export type BlobReads = ReturnType<typeof createBlobReads>
