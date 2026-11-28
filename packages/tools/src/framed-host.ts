/**
 * A helper process spoken to in frames over its stdin and stdout (the terminal's image host, apps/cli/src/ui/image-host.ts). The
 * process port lives here because the terminal app never starts processes itself (client boundaries, P4).
 *
 * Wire: each message is two little-endian u32 lengths (header, payload), the header as JSON, then the payload bytes. Every request
 * header carries a numeric `id`; the reply with the same `id` settles it.
 */

export function encodeFrame(header: object, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const head = Buffer.from(JSON.stringify(header))
  const out = new Uint8Array(8 + head.length + payload.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, head.length, true)
  view.setUint32(4, payload.length, true)
  out.set(head, 8)
  out.set(payload, 8 + head.length)
  return out
}

/** Splits a byte stream into frames; `push` returns the frames completed by that chunk. */
export function createFrameReader<H>() {
  let chunks: Uint8Array[] = []
  let buffered = 0
  let need: { head: number; payload: number } | undefined
  const take = (count: number) => {
    const out = new Uint8Array(count)
    let at = 0
    while (at < count) {
      const first = chunks[0]!
      const used = Math.min(first.length, count - at)
      out.set(first.subarray(0, used), at)
      at += used
      if (used === first.length) chunks.shift()
      else chunks[0] = first.subarray(used)
    }
    buffered -= count
    return out
  }
  return {
    push(chunk: Uint8Array): Array<{ header: H; payload: Uint8Array }> {
      if (chunk.length) {
        chunks.push(chunk)
        buffered += chunk.length
      }
      const frames: Array<{ header: H; payload: Uint8Array }> = []
      for (;;) {
        if (!need) {
          if (buffered < 8) break
          const prefix = take(8)
          const view = new DataView(prefix.buffer)
          need = { head: view.getUint32(0, true), payload: view.getUint32(4, true) }
        }
        if (buffered < need.head + need.payload) break
        const header = JSON.parse(Buffer.from(take(need.head)).toString("utf8")) as H
        frames.push({ header, payload: take(need.payload) })
        need = undefined
      }
      return frames
    },
    reset() {
      chunks = []
      buffered = 0
      need = undefined
    },
  }
}

/** A reply that says the request failed: `{ ok: false, error }`. Anything else settles the request. */
type ReplyHeader = { id: number; ok?: boolean; error?: string; [field: string]: unknown }
type Waiting = { resolve(reply: { header: ReplyHeader; payload: Uint8Array }): void; reject(error: Error): void }

/**
 * One helper process, started by the first request (or `warm`) and stopped after `idleMs` without one. A process that cannot start
 * or dies while it holds requests rejects them and is not started again (`broken`): the caller then does the work itself.
 */
export function createFramedHost({ command, idleMs }: { command: string[]; idleMs: number }) {
  let child: ReturnType<typeof Bun.spawn<"pipe", "pipe", "ignore">> | undefined
  let broken = false
  let nextId = 1
  let idle: ReturnType<typeof setTimeout> | undefined
  const waiting = new Map<number, Waiting>()

  function spawnHost() {
    const proc = Bun.spawn(command, { stdin: "pipe", stdout: "pipe", stderr: "ignore", env: process.env })
    const reader = createFrameReader<ReplyHeader>()
    void (async () => {
      try {
        for await (const chunk of proc.stdout) {
          for (const frame of reader.push(chunk)) {
            const job = waiting.get(frame.header.id)
            if (!job) continue
            waiting.delete(frame.header.id)
            if (frame.header.ok === false) job.reject(new Error(frame.header.error ?? "[HOST]: request failed"))
            else job.resolve(frame)
          }
          if (!waiting.size) arm()
        }
      } catch {
        // The pipe broke: handled below like an exit.
      }
      gone(proc)
    })()
    return proc
  }

  /** The process ended. While work was asked of it, that is a failure: the rest of this run works without it. */
  function gone(proc: NonNullable<typeof child>) {
    if (child !== proc) return
    child = undefined
    if (waiting.size) broken = true
    for (const job of waiting.values()) job.reject(new Error("[HOST]: the helper process ended"))
    waiting.clear()
  }

  function arm() {
    if (idle) clearTimeout(idle)
    idle = setTimeout(stop, idleMs)
    idle.unref?.()
  }

  function stop() {
    if (idle) clearTimeout(idle)
    idle = undefined
    const running = child
    if (!running || waiting.size) return
    child = undefined
    try { void running.stdin.end() } catch { /* already closed */ }
    running.kill()
  }

  return {
    /** Sends `header` (its `id` is set here) and `payload`; resolves with the reply frame. */
    request(header: object, payload: Uint8Array): Promise<{ header: ReplyHeader; payload: Uint8Array }> {
      if (broken) return Promise.reject(new Error("[HOST]: the helper process is not available"))
      if (idle) clearTimeout(idle)
      idle = undefined
      try {
        child ??= spawnHost()
      } catch (error) {
        broken = true
        return Promise.reject(error instanceof Error ? error : new Error(String(error)))
      }
      const running = child
      const id = nextId++
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject })
        try {
          const written = running.stdin.write(encodeFrame({ ...header, id }, payload))
          if (written instanceof Promise) written.catch(() => gone(running))
          const flushed = running.stdin.flush()
          if (flushed instanceof Promise) flushed.catch(() => gone(running))
        } catch {
          broken = true
          gone(running)
        }
      })
    },
    /** Starts the process ahead of its first request; it stops again if nothing comes. */
    warm() {
      if (broken || child) return
      try {
        child = spawnHost()
        arm()
      } catch {
        broken = true
      }
    },
    get broken() {
      return broken
    },
    get running() {
      return child !== undefined
    },
    close() {
      broken = true
      if (idle) clearTimeout(idle)
      idle = undefined
      const running = child
      child = undefined
      for (const job of waiting.values()) job.reject(new Error("[HOST]: the helper process was closed"))
      waiting.clear()
      running?.kill()
    },
  }
}

export type FramedHost = ReturnType<typeof createFramedHost>
