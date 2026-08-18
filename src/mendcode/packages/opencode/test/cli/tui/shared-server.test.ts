import { describe, expect, test } from "bun:test"
import {
  parseState,
  acquireClientLease,
  activeClientLeaseCount,
  activeClientLeaseCountForServer,
  shouldReplaceSharedServer,
  shouldAttachExistingSharedServer,
  shouldReplaceLiveServer,
  shouldUseSharedServer,
  waitForClientLeases,
} from "../../../src/cli/cmd/tui/shared-server"
import { tmpdir } from "../../fixture/fixture"
import fs from "fs/promises"
import path from "path"

const valid = {
  version: 1 as const,
  pid: 123,
  url: "http://127.0.0.1:4096/",
  username: "mendcode",
  password: "local-secret",
  startedAt: "2026-07-19T00:00:00.000Z",
  runtimeID: "mendcode-test-runtime",
}

describe("shared server state", () => {
  test("accepts a valid loopback server state", () => {
    expect(parseState(valid)).toEqual(valid)
  })

  test("rejects malformed or non-loopback state", () => {
    expect(parseState({ ...valid, pid: 0 })).toBeUndefined()
    expect(parseState({ ...valid, url: "http://user:password@127.0.0.1:4096/" })).toBeUndefined()
    expect(parseState({ ...valid, url: "http://0.0.0.0:4096/" })).toBeUndefined()
  })

  test("does not replace a live server while another TUI client is active", () => {
    expect(shouldReplaceLiveServer({ pid: 456, currentPid: 123, activeClients: 1 })).toBe(true)
    expect(shouldReplaceLiveServer({ pid: 456, currentPid: 123, activeClients: 2 })).toBe(false)
    expect(shouldReplaceLiveServer({ pid: 123, currentPid: 123, activeClients: 1 })).toBe(false)
    expect(
      shouldReplaceLiveServer({ pid: 456, currentPid: 123, activeClients: 1, allowLiveServerReplacement: false }),
    ).toBe(false)
  })

  test("uses the shared server by default and keeps private mode opt-in", () => {
    expect(shouldUseSharedServer({ networkOptionSet: false })).toBe(true)
    expect(shouldUseSharedServer({ networkOptionSet: false, isolated: true })).toBe(false)
    expect(shouldUseSharedServer({ networkOptionSet: true })).toBe(false)
    expect(shouldUseSharedServer({ networkOptionSet: false, serverURL: "http://127.0.0.1:4096" })).toBe(false)
    expect(shouldUseSharedServer({ networkOptionSet: false, disabledByEnvironment: true })).toBe(false)
  })

  test("does not replace a reachable live server during a transient probe failure", () => {
    expect(shouldReplaceSharedServer({ live: true, runtimeMatches: true, activeClients: 1 })).toBe(false)
    expect(shouldReplaceSharedServer({ live: true, runtimeMatches: true, activeClients: 0 })).toBe(false)
    expect(shouldReplaceSharedServer({ live: true, runtimeMatches: false, activeClients: 1 })).toBe(false)
    expect(shouldReplaceSharedServer({ live: true, runtimeMatches: false, activeClients: 0 })).toBe(true)
    expect(shouldReplaceSharedServer({ live: false, runtimeMatches: true, activeClients: 1 })).toBe(true)
  })

  test("replaces an unreachable live PID only when no client owns it", () => {
    expect(shouldReplaceSharedServer({ live: true, runtimeMatches: true, activeClients: 0, reachable: false })).toBe(true)
    expect(shouldReplaceSharedServer({ live: true, runtimeMatches: true, activeClients: 1, reachable: false })).toBe(false)
    expect(shouldAttachExistingSharedServer({ live: true, runtimeMatches: false, activeClients: 1, reachable: false })).toBe(false)
  })

  test("attaches to a live older runtime while another client still owns it", () => {
    expect(shouldAttachExistingSharedServer({ live: true, runtimeMatches: false, activeClients: 1 })).toBe(true)
    expect(shouldAttachExistingSharedServer({ live: true, runtimeMatches: false, activeClients: 0 })).toBe(false)
    expect(shouldAttachExistingSharedServer({ live: false, runtimeMatches: false, activeClients: 1 })).toBe(false)
    expect(shouldAttachExistingSharedServer({ live: true, runtimeMatches: true, activeClients: 3 })).toBe(false)
  })

  test("counts and releases client leases", async () => {
    await using tmp = await tmpdir()
    expect(await activeClientLeaseCount(tmp.path)).toBe(0)
    const lease = await acquireClientLease(process.pid, tmp.path)
    expect(await activeClientLeaseCount(tmp.path)).toBe(1)
    expect(lease.serverPID).toBe(process.pid)
    await lease.release()
    expect(await activeClientLeaseCount(tmp.path)).toBe(0)
  })

  test("keeps a live lease active across stale timestamps and recreates it after removal", async () => {
    await using tmp = await tmpdir()
    const lease = await acquireClientLease(process.pid, tmp.path, 5)
    const leaseName = (await fs.readdir(tmp.path))[0]
    if (!leaseName) throw new Error("lease file was not created")
    const leasePath = path.join(tmp.path, leaseName)
    const stale = new Date(Date.now() - 10_000)

    await fs.utimes(leasePath, stale, stale)
    expect(await activeClientLeaseCount(tmp.path, 1)).toBe(1)

    await fs.rm(leasePath)
    await Bun.sleep(30)
    expect(await activeClientLeaseCount(tmp.path, 1)).toBe(1)

    await lease.release()
  })

  test("isolates leases owned by different backend pids", async () => {
    await using tmp = await tmpdir()
    const first = path.join(tmp.path, "101")
    const second = path.join(tmp.path, "202")
    const firstLease = await acquireClientLease(101, first)
    const secondLease = await acquireClientLease(202, second)

    expect(await activeClientLeaseCount(first)).toBe(1)
    expect(await activeClientLeaseCount(second)).toBe(1)

    await firstLease.release()
    expect(await activeClientLeaseCount(first)).toBe(0)
    expect(await activeClientLeaseCount(second)).toBe(1)
    await secondLease.release()
  })

  test("keeps one shared runtime lease when the parent TUI closes before its sibling reconnects", async () => {
    await using tmp = await tmpdir()
    const first = await acquireClientLease(303, tmp.path)
    const second = await acquireClientLease(303, tmp.path)

    await first.release()
    expect(await activeClientLeaseCount(tmp.path)).toBe(1)
    expect(shouldReplaceSharedServer({ live: true, runtimeMatches: true, activeClients: 1, reachable: false })).toBe(false)

    await second.release()
    expect(await activeClientLeaseCount(tmp.path)).toBe(0)
  })

  test("counts legacy global leases during the scoped lease rollout", async () => {
    await using tmp = await tmpdir()
    const scoped = path.join(tmp.path, "101")
    const legacy = await acquireClientLease(999, tmp.path)

    expect(await activeClientLeaseCount(scoped)).toBe(0)
    expect(await activeClientLeaseCountForServer(101, undefined, tmp.path)).toBe(1)

    await legacy.release()
  })

  test("a backend stops while another backend still has a lease", async () => {
    await using tmp = await tmpdir()
    const first = path.join(tmp.path, "101")
    const second = path.join(tmp.path, "202")
    const secondLease = await acquireClientLease(202, second)
    let stopped = 0

    await waitForClientLeases({
      directory: first,
      pollMs: 1,
      idleGraceMs: 4,
      stop: async () => {
        stopped++
      },
    })

    expect(stopped).toBe(1)
    expect(await activeClientLeaseCount(second)).toBe(1)
    await secondLease.release()
  })

  test("keeps the backend alive while background work remains active", async () => {
    await using tmp = await tmpdir()
    let activeChecks = 0
    let stopped = 0

    await waitForClientLeases({
      directory: tmp.path,
      pollMs: 1,
      idleGraceMs: 4,
      hasActiveWork: async () => ++activeChecks < 4,
      stop: async () => {
        stopped++
      },
    })

    expect(activeChecks).toBeGreaterThanOrEqual(4)
    expect(stopped).toBe(1)
  })

  test("stops after the lease directory stays idle", async () => {
    await using tmp = await tmpdir()
    let stopped = 0
    await waitForClientLeases({
      directory: tmp.path,
      pollMs: 1,
      idleGraceMs: 4,
      stop: async () => {
        stopped++
      },
    })
    expect(stopped).toBe(1)
  })

  test("aborts an idle wait without stopping the backend", async () => {
    await using tmp = await tmpdir()
    const controller = new AbortController()
    let stopped = 0
    const waiting = waitForClientLeases({
      directory: tmp.path,
      pollMs: 10_000,
      idleGraceMs: 20_000,
      signal: controller.signal,
      stop: async () => {
        stopped++
      },
    })

    controller.abort()
    await waiting
    expect(stopped).toBe(0)
  })
})
