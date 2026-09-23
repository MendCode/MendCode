import { afterEach, expect, spyOn, test } from "bun:test"
import { SharedServer } from "../../../src/cli/cmd/tui/shared-server"
import { ensureLocalSharedServer } from "../../../src/cli/cmd/tui/thread"

const restores: Array<() => void> = []
afterEach(() => { for (const restore of restores.splice(0).reverse()) restore() })
for (const lockAvailable of [true, false]) {
  test(`attaches a healthy older desktop runtime with active clients (lock ${lockAvailable})`, async () => {
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => {
      expect(request.headers.get("authorization")).toBe(`Basic ${btoa("test:secret")}`)
      return Response.json({ healthy: true, version: "0.1.44-beta.9" })
    } })
    restores.push(() => { server.stop(true) })
    const state = { version: 1 as const, pid: process.pid, url: server.url.toString(), username: "test", password: "secret", runtimeID: "older-installed-runtime", startedAt: new Date().toISOString() }
    const released = async () => {}
    const lease = { serverPID: process.pid, release: released }
    const read = spyOn(SharedServer, "readState").mockResolvedValue(state)
    const lock = spyOn(SharedServer, "acquireLock").mockResolvedValue(lockAvailable ? released : undefined)
    const count = spyOn(SharedServer, "activeClientLeaseCountForServer").mockResolvedValue(1)
    const acquire = spyOn(SharedServer, "acquireClientLease").mockResolvedValue(lease)
    const clear = spyOn(SharedServer, "clearState").mockResolvedValue()
    for (const mock of [read, lock, count, acquire, clear]) restores.push(() => mock.mockRestore())
    const result = await ensureLocalSharedServer({ directory: process.cwd(), runtimeCwd: process.cwd() })
    expect(result?.pid).toBe(process.pid)
    expect(result?.url).toBe(state.url)
    expect(acquire).toHaveBeenCalledTimes(1)
    expect(clear).not.toHaveBeenCalled()
  })
}
