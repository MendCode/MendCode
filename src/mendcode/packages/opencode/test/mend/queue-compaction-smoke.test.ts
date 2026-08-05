import { describe, expect, test } from "bun:test"
import path from "node:path"
import { acquireQueueCompactionSmokeLock } from "../../script/queue-compaction-smoke"
import { tmpdir } from "../fixture/fixture"

describe("queue compaction manual smoke", () => {
  test("allows only one active run and releases the lock", async () => {
    await using tmp = await tmpdir()
    const lockPath = path.join(tmp.path, "queue-smoke.lock")
    const first = await acquireQueueCompactionSmokeLock(lockPath)

    try {
      await expect(acquireQueueCompactionSmokeLock(lockPath)).rejects.toThrow(
        `the queue/compaction smoke is already running (PID ${process.pid})`,
      )
    } finally {
      await first.release()
    }

    const second = await acquireQueueCompactionSmokeLock(lockPath)
    await second.release()
    expect(await Bun.file(lockPath).exists()).toBe(false)
  })

  test("releases the lock during synchronous process cleanup", async () => {
    await using tmp = await tmpdir()
    const lockPath = path.join(tmp.path, "queue-smoke.lock")
    const lock = await acquireQueueCompactionSmokeLock(lockPath)

    lock.releaseSync()
    expect(await Bun.file(lockPath).exists()).toBe(false)
  })

  test("reclaims a stale lock", async () => {
    await using tmp = await tmpdir()
    const lockPath = path.join(tmp.path, "queue-smoke.lock")
    await Bun.write(
      lockPath,
      JSON.stringify({ pid: 999_999_999, token: "stale", startedAt: "2026-01-01T00:00:00.000Z" }) + "\n",
    )

    const lock = await acquireQueueCompactionSmokeLock(lockPath)
    await lock.release()
    expect(await Bun.file(lockPath).exists()).toBe(false)
  })
})
