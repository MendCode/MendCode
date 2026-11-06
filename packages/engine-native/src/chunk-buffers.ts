/**
 * Bun hands each chunk a fetch body yields in a backing buffer of its own of 256 KB, however few bytes it carries, and frees
 * that buffer only when the collector runs. A streamed answer arrives as many tiny chunks: 70 deltas of an ordinary reply held
 * about 32 MB until the next collection, and the process kept those pages resident after it. A reader that copies each chunk
 * out as it arrives (decodes it) releases the buffers it is done with here, which frees them at once.
 */
export type ChunkBuffers = {
  /** The chunk just read. The buffer of the chunk before it is released when this one lives in a different buffer. */
  read(chunk: Uint8Array): void
  /** Releases the buffer of the last chunk read; call once the reader is done with it. */
  done(): void
}

type Detachable = ArrayBuffer & { transfer?: (length: number) => ArrayBuffer; detached?: boolean }

/**
 * Only a runtime read buffer is released: one of at least 64 KB that the chunk fills less than a quarter of. A body built from
 * bytes its maker still holds (a stream that enqueues a caller's array) hands over those very bytes, sized to them.
 */
const READ_BUFFER_BYTES = 64 * 1024
const readBuffer = (chunk: Uint8Array) => chunk.buffer instanceof ArrayBuffer && chunk.buffer.byteLength >= READ_BUFFER_BYTES && chunk.byteLength * 4 <= chunk.buffer.byteLength

/** Detaching the buffer frees its storage now; a view that is already empty or detached, or a shared buffer, is left as it is. */
function release(buffer: Detachable) {
  if (typeof buffer.transfer !== "function" || buffer.detached || buffer.byteLength === 0) return
  try { buffer.transfer(0) } catch { /* A buffer the runtime will not detach is freed by the collector, as before. */ }
}

export function chunkBuffers(): ChunkBuffers {
  let held: Detachable | undefined
  return {
    read(chunk) {
      const buffer = readBuffer(chunk) ? chunk.buffer as Detachable : undefined
      if (held && held !== buffer) release(held)
      held = buffer
    },
    done() {
      if (held) release(held)
      held = undefined
    },
  }
}
