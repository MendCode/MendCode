export type AsyncQueueOptions<T> = {
  maxItems?: number
  maxBytes?: number
  sizeOf?: (item: T) => number
}

export class AsyncQueue<T> implements AsyncIterable<T> {
  private queue: T[] = []
  private resolvers: ((value: T) => void)[] = []
  private queuedBytes = 0
  private closed = false
  private closedValue!: T
  private readonly maxItems: number
  private readonly maxBytes: number
  private readonly sizeOf: (item: T) => number

  constructor(options: AsyncQueueOptions<T> = {}) {
    this.maxItems = options.maxItems ?? Number.POSITIVE_INFINITY
    this.maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY
    this.sizeOf = options.sizeOf ?? (() => 1)
  }

  push(item: T) {
    if (this.closed) return false
    const resolve = this.resolvers.shift()
    if (resolve) {
      resolve(item)
      return true
    }

    const size = Math.max(0, this.sizeOf(item) || 0)
    if (this.queue.length >= this.maxItems || this.queuedBytes + size > this.maxBytes) return false
    this.queue.push(item)
    this.queuedBytes += size
    return true
  }

  close(item: T) {
    if (this.closed) return
    this.closed = true
    this.queue = []
    this.queuedBytes = 0
    this.closedValue = item
    for (const resolve of this.resolvers.splice(0)) resolve(item)
  }

  async next(): Promise<T> {
    if (this.queue.length > 0) {
      const item = this.queue.shift()!
      this.queuedBytes = Math.max(0, this.queuedBytes - Math.max(0, this.sizeOf(item) || 0))
      return item
    }
    if (this.closed) return this.closedValue
    return new Promise((resolve) => this.resolvers.push(resolve))
  }

  async *[Symbol.asyncIterator]() {
    while (true) yield await this.next()
  }
}

export async function work<T>(concurrency: number, items: T[], fn: (item: T) => Promise<void>) {
  const pending = [...items]
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (true) {
        const item = pending.pop()
        if (item === undefined) return
        await fn(item)
      }
    }),
  )
}
