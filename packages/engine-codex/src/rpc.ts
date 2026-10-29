/** Minimal JSON-RPC 2.0 over JSONL stdio for `codex app-server` (bidirectional: the server can send requests). */
export type RpcMessage = { jsonrpc?: "2.0"; id?: number | string; method?: string; params?: any; result?: any; error?: { code: number; message: string } }

export type Transport = {
  write(line: string): void
  lines: AsyncIterable<string>
  close(): void
  exited: Promise<number>
}

export function spawnCodex(options: { bin: string; args: string[]; cwd?: string; env?: Record<string, string> }): Transport {
  const proc = Bun.spawn([options.bin, ...options.args], { stdin: "pipe", stdout: "pipe", stderr: "ignore", ...(options.cwd ? { cwd: options.cwd } : {}), ...(options.env ? { env: { ...process.env, ...options.env } } : {}) })
  // An unfinished line is kept as chunks and joined once: appending and searching one string copied a long line at every read.
  async function* lines() {
    const decoder = new TextDecoder()
    let pending: string[] = []
    for await (const chunk of proc.stdout) {
      let text = decoder.decode(chunk, { stream: true })
      let newline = text.indexOf("\n")
      while (newline >= 0) {
        const line = pending.length ? pending.join("") + text.slice(0, newline) : text.slice(0, newline)
        pending = []
        text = text.slice(newline + 1)
        if (line.trim()) yield line
        newline = text.indexOf("\n")
      }
      if (text) pending.push(text)
    }
  }
  return {
    write: (line) => void proc.stdin.write(line),
    lines: lines(),
    close: () => proc.kill(),
    exited: proc.exited,
  }
}

export function createRpc(
  transport: Transport,
  handlers: { notification(method: string, params: any): void; request(method: string, params: any): Promise<unknown> },
  trace?: (direction: "in" | "out", line: string) => void,
) {
  if (trace) {
    const write = transport.write
    transport = { ...transport, write: (line) => (trace("out", line), write(line)) }
  }
  let nextId = 1
  const pending = new Map<number | string, { resolve(value: any): void; reject(error: Error): void }>()
  let closed = false

  void (async () => {
    try {
      for await (const line of transport.lines) {
        trace?.("in", line)
        let message: RpcMessage
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        // Valid JSON that is not a message (`null`, a number) is skipped like a line that does not parse.
        if (!message || typeof message !== "object") continue
        if (message.method && message.id !== undefined) {
          const id = message.id
          handlers.request(message.method, message.params).then(
            (result) => transport.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`),
            (error: unknown) => transport.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message: String(error) } })}\n`),
          )
        } else if (message.method) {
          try {
            handlers.notification(message.method, message.params)
          } catch {
            // One notification the engine cannot map must not end the reader, and with it every later answer.
          }
        } else if (message.id !== undefined) {
          const waiter = pending.get(message.id)
          pending.delete(message.id)
          if (message.error) waiter?.reject(new Error(`[CODEX]: ${message.error.message}`))
          else waiter?.resolve(message.result)
        }
      }
    } finally {
      closed = true
      for (const waiter of pending.values()) waiter.reject(new Error("[CODEX]: app-server exited"))
      pending.clear()
      // Without its output the process can answer nothing more: it is stopped, so its exit ends the turns that wait on it.
      transport.close()
    }
  })().catch(() => {})

  return {
    request<T = any>(method: string, params?: unknown): Promise<T> {
      if (closed) return Promise.reject(new Error("[CODEX]: app-server is not running"))
      const id = nextId++
      return new Promise<T>((resolve, reject) => {
        pending.set(id, { resolve, reject })
        transport.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) })}\n`)
      })
    },
    notify(method: string, params?: unknown) {
      transport.write(`${JSON.stringify({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) })}\n`)
    },
    get closed() {
      return closed
    },
  }
}
