/**
 * A timeout that can stand still: while the person answers an elicitation the request it belongs to must not run out.
 * `signal` aborts with a `TimeoutError` after `ms` of un-paused time, the same reason `AbortSignal.timeout` gives.
 */
export class Deadline {
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly controller = new AbortController()

  constructor(private readonly ms: number, paused = false) {
    if (!paused) this.arm()
  }

  get signal(): AbortSignal {
    return this.controller.signal
  }

  private arm(): void {
    this.timer = setTimeout(() => this.controller.abort(new DOMException("The operation timed out.", "TimeoutError")), this.ms)
  }

  pause(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
  }

  /** Starts the full time again. */
  resume(): void {
    if (this.timer === undefined && !this.controller.signal.aborted) this.arm()
  }

  dispose(): void {
    this.pause()
  }
}

/** Counts the elicitations in progress and holds every registered deadline while any is. */
export class DeadlineGroup {
  private readonly deadlines = new Set<Deadline>()
  private holds = 0

  get held(): boolean {
    return this.holds > 0
  }

  /** A deadline of `ms`, paused when a hold is active; `done` releases it. */
  start(ms: number): { deadline: Deadline; done(): void } {
    const deadline = new Deadline(ms, this.held)
    this.deadlines.add(deadline)
    return { deadline, done: () => { deadline.dispose(); this.deadlines.delete(deadline) } }
  }

  hold(): void {
    if (this.holds++ === 0) for (const deadline of this.deadlines) deadline.pause()
  }

  release(): void {
    if (this.holds > 0 && --this.holds === 0) for (const deadline of this.deadlines) deadline.resume()
  }
}
