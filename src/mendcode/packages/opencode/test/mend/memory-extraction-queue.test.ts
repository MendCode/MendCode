import { describe, expect, test } from "bun:test"
import { MemoryExtractionQueue } from "../../src/mend/memory/extraction-queue"
import { tmpdir } from "../fixture/fixture"
import { defaultEvolutionConfig, writeEvolutionConsent } from "../../src/mend/evolution/config"

const input = (root: string, turnID: string) => ({
  projectRoot: root,
  sessionID: "session-1",
  turnID,
  messageID: turnID,
  cwd: root,
  text: `turn ${turnID}`,
  evidence: `session:session-1:message:${turnID}`,
})

async function eventually(check: () => boolean | Promise<boolean>, timeout = 2_000) {
  const started = Date.now()
  while (!(await check())) {
    if (Date.now() - started > timeout) throw new Error("condition was not reached")
    await Bun.sleep(10)
  }
}

describe("memory extraction queue", () => {
  test("Evolution adoption discards legacy backlog and forbids new legacy work", async () => {
    await using tmp = await tmpdir()
    const queue = new MemoryExtractionQueue()
    await queue.enqueue(input(tmp.path, "legacy"))
    await writeEvolutionConsent(tmp.path, defaultEvolutionConfig)
    let calls = 0
    await queue.start(tmp.path, async () => { calls++; return {} })
    await eventually(async () => (await queue.list(tmp.path))[0]?.state === "skipped")
    expect(calls).toBe(0)
    expect((await queue.list(tmp.path))[0]?.text).toBe("")
    await expect(queue.enqueue(input(tmp.path, "new"))).rejects.toThrow("replaced by Evolution")
    await queue.stop(tmp.path)
    await writeEvolutionConsent(tmp.path, { ...defaultEvolutionConfig, mode: "suggest" })
    const restarted = new MemoryExtractionQueue()
    await restarted.start(tmp.path, async () => { calls++; return {} })
    expect((await restarted.list(tmp.path))[0]?.state).toBe("skipped")
    expect(calls).toBe(0)
    await restarted.stop(tmp.path)
  })
  test("applies backpressure without rejecting an idempotent duplicate", async () => {
    await using tmp = await tmpdir()
    const queue = new MemoryExtractionQueue({ maxPendingJobs: 1 })
    const first = await queue.enqueue(input(tmp.path, "one"))
    expect((await queue.enqueue(input(tmp.path, "one"))).id).toBe(first.id)
    await expect(queue.enqueue(input(tmp.path, "two"))).rejects.toThrow("queue full")
    expect(await queue.list(tmp.path)).toHaveLength(1)
  })

  test("bounds text in bytes and retains only bounded terminal receipts", async () => {
    await using tmp = await tmpdir()
    const queue = new MemoryExtractionQueue({ maxRetainedJobs: 2 })
    await expect(queue.enqueue({ ...input(tmp.path, "oversized"), text: "é".repeat(32769) })).rejects.toThrow("input exceeds")
    await queue.start(tmp.path, async () => ({}))
    for (const turn of ["one", "two", "three"]) {
      await queue.enqueue(input(tmp.path, turn))
      await eventually(async () => (await queue.list(tmp.path)).some((job) => job.turnID === turn && job.state === "completed"))
    }
    expect((await queue.list(tmp.path)).map((job) => job.turnID)).toEqual(["two", "three"])
    await queue.stop(tmp.path)
  })
  test("shutdown releases an active extraction and resumes it without another enqueue", async () => {
    await using tmp = await tmpdir()
    const first = new MemoryExtractionQueue()
    let oldSignal: AbortSignal | undefined
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    await first.start(tmp.path, async (_job, signal) => { oldSignal = signal; await blocked; return {} })
    await first.enqueue(input(tmp.path, "shutdown"))
    await eventually(() => oldSignal !== undefined)
    await first.stop(tmp.path)
    expect(oldSignal?.aborted).toBe(true)
    const stopped = (await first.list(tmp.path))[0]!
    expect(stopped.state).toBe("queued")
    expect(stopped.ownerPID).toBeUndefined()
    expect(stopped.attempts).toBe(0)
    const restarted = new MemoryExtractionQueue()
    let calls = 0
    await restarted.start(tmp.path, async () => { calls++; return { result: "resumed" } })
    await eventually(async () => (await restarted.list(tmp.path))[0]?.state === "completed")
    release()
    expect(calls).toBe(1)
    expect((await restarted.list(tmp.path))[0]?.result).toBe("resumed")
    await restarted.stop(tmp.path)
  })

  test("shutdown cancels retry alarms without discarding queued work", async () => {
    await using tmp = await tmpdir()
    const queue = new MemoryExtractionQueue({ maxRetries: 1 })
    let calls = 0
    await queue.start(tmp.path, async () => { calls++; throw new Error("controlled retry") })
    await queue.enqueue(input(tmp.path, "stop-retry"))
    await eventually(async () => Boolean((await queue.list(tmp.path))[0]?.nextAttemptAt))
    await queue.stop(tmp.path)
    await Bun.sleep(1100)
    expect(calls).toBe(1)
    expect((await queue.list(tmp.path))[0]?.state).toBe("queued")
  })
  test("independent queue instances serialize enqueue and preserve idempotency", async () => {
    await using tmp = await tmpdir()
    const first = new MemoryExtractionQueue()
    const second = new MemoryExtractionQueue()
    const jobs = await Promise.all([
      first.enqueue(input(tmp.path, "same")),
      second.enqueue(input(tmp.path, "same")),
      first.enqueue(input(tmp.path, "other")),
    ])
    expect(jobs[0]!.id).toBe(jobs[1]!.id)
    expect((await second.list(tmp.path)).map((job) => job.turnID).sort()).toEqual(["other", "same"])
  })

  test("persists identity and lets a newer turn run while an older extraction is pending", async () => {
    await using tmp = await tmpdir()
    const queue = new MemoryExtractionQueue({ concurrency: 2 })
    let releaseA!: () => void
    const aDone = new Promise<void>((resolve) => (releaseA = resolve))
    const started: string[] = []
    await queue.start(tmp.path, async (job) => {
      started.push(job.turnID)
      if (job.turnID === "a") await aDone
      return { result: { turnID: job.turnID } }
    })
    const first = await queue.enqueue(input(tmp.path, "a"))
    const duplicate = await queue.enqueue(input(tmp.path, "a"))
    await queue.enqueue(input(tmp.path, "b"))
    await eventually(() => started.includes("b"))
    expect(duplicate.id).toBe(first.id)
    expect(started).toEqual(["a", "b"])
    releaseA()
    await eventually(async () => (await queue.list(tmp.path)).every((job) => job.state === "completed"))
  })

  test("starting another turn does not recover an extraction that is still running", async () => {
    await using tmp = await tmpdir()
    const queue = new MemoryExtractionQueue({ concurrency: 2 })
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    let calls = 0
    const runner = async () => { calls++; await blocked; return {} }
    await queue.start(tmp.path, runner)
    await queue.enqueue(input(tmp.path, "active"))
    await eventually(() => calls === 1)
    await queue.start(tmp.path, runner)
    expect((await queue.list(tmp.path))[0]?.state).toBe("running")
    release()
    await eventually(async () => (await queue.list(tmp.path))[0]?.state === "completed")
    expect(calls).toBe(1)
  })

  test("another queue instance does not recover a live owner's extraction", async () => {
    await using tmp = await tmpdir()
    const first = new MemoryExtractionQueue()
    const second = new MemoryExtractionQueue()
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    let calls = 0
    const runner = async () => { calls++; await blocked; return {} }
    try {
      await first.start(tmp.path, runner)
      await first.enqueue(input(tmp.path, "owned"))
      await eventually(() => calls === 1)
      await second.start(tmp.path, runner)
      await second.enqueue(input(tmp.path, "owned"))
      expect((await second.list(tmp.path))[0]?.ownerPID).toBe(process.pid)
      expect((await second.list(tmp.path))[0]?.attempts).toBe(1)
    } finally {
      release()
    }
    await eventually(async () => (await first.list(tmp.path))[0]?.state === "completed")
    expect(calls).toBe(1)
  })

  test("active cancellation keeps its custom reason after the runner settles", async () => {
    await using tmp = await tmpdir()
    const queue = new MemoryExtractionQueue({ maxRetries: 0 })
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    await queue.start(tmp.path, async () => { await blocked; return {} })
    const job = await queue.enqueue(input(tmp.path, "cancel-active"))
    await eventually(async () => (await queue.list(tmp.path))[0]?.state === "running")
    await queue.cancel(tmp.path, job.id, "output disabled")
    release()
    await eventually(async () => (await queue.list(tmp.path))[0]?.state === "skipped")
    expect((await queue.list(tmp.path))[0]?.reason).toBe("output disabled")
  })

  test("recovers running jobs and records terminal failures after bounded retries", async () => {
    await using tmp = await tmpdir()
    const queue = new MemoryExtractionQueue({ concurrency: 1, maxRetries: 1, timeoutMs: 20 })
    const job = await queue.enqueue(input(tmp.path, "restart"))
    const stored = await queue.list(tmp.path)
    stored[0]!.state = "running"
    await Bun.write(`${tmp.path}/.mendcode/memory/extraction-queue.json`, JSON.stringify({ version: 1, jobs: stored }))
    let attempts = 0
    await queue.start(tmp.path, async () => {
      attempts++
      throw new Error("controlled failure")
    })
    await eventually(async () => (await queue.list(tmp.path)).find((item) => item.id === job.id)?.state === "failed", 3_000)
    expect(attempts).toBe(2)
    expect((await queue.list(tmp.path))[0]?.reason).toBe("controlled failure")
  })

  test("restart schedules a persisted retry without another chat turn", async () => {
    await using tmp = await tmpdir()
    const original = new MemoryExtractionQueue()
    await original.enqueue(input(tmp.path, "delayed"))
    const stored = await original.list(tmp.path)
    stored[0]!.nextAttemptAt = new Date(Date.now() + 200).toISOString()
    await Bun.write(`${tmp.path}/.mendcode/memory/extraction-queue.json`, JSON.stringify({ version: 1, jobs: stored }))
    const restarted = new MemoryExtractionQueue()
    let calls = 0
    await restarted.start(tmp.path, async () => { calls++; return {} })
    await eventually(async () => (await restarted.list(tmp.path))[0]?.state === "completed")
    expect(calls).toBe(1)
  })

  test("cancels queued work without invoking its provider runner", async () => {
    await using tmp = await tmpdir()
    const queue = new MemoryExtractionQueue({ concurrency: 1 })
    let release!: () => void
    const blocked = new Promise<void>((resolve) => (release = resolve))
    let calls = 0
    await queue.start(tmp.path, async () => {
      calls++
      await blocked
      return {}
    })
    const first = await queue.enqueue(input(tmp.path, "first"))
    const second = await queue.enqueue(input(tmp.path, "second"))
    await eventually(async () => (await queue.list(tmp.path)).some((job) => job.id === first.id && job.state === "running"))
    await queue.cancel(tmp.path, second.id, "user cancelled")
    release()
    await eventually(async () => (await queue.list(tmp.path)).every((job) => ["completed", "skipped"].includes(job.state)))
    expect(calls).toBe(1)
    expect((await queue.list(tmp.path)).find((job) => job.id === second.id)?.reason).toBe("user cancelled")
  })
})
