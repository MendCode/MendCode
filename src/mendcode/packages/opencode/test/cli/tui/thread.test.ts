import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../../fixture/fixture"
import {
  resolveRuntimeEntrypoint,
  resolveSharedServerURL,
  resolveThreadDirectory,
  SHARED_SERVER_RECONNECT_MAX_ATTEMPTS,
  sharedServerEnvironment,
  requireLocalSharedServer,
} from "../../../src/cli/cmd/tui/thread"
import { SharedServer } from "../../../src/cli/cmd/tui/shared-server"

describe("tui thread", () => {
  test("refuses a private fallback while another runtime owns active clients", async () => {
    await using tmp = await tmpdir()
    const previous = process.env.MENDCODE_SHARED_SERVER_STATE_FILE
    process.env.MENDCODE_SHARED_SERVER_STATE_FILE = path.join(tmp.path, "server.json")
    let lease: Awaited<ReturnType<typeof SharedServer.acquireClientLease>> | undefined
    try {
      await SharedServer.writeState({
        version: 1, pid: process.pid, url: "http://127.0.0.1:1/", username: "test", password: "test",
        startedAt: new Date().toISOString(), runtimeID: "previous-installed-runtime",
      })
      lease = await SharedServer.acquireClientLease(process.pid)
      await expect(requireLocalSharedServer({ directory: tmp.path, runtimeCwd: tmp.path }))
        .rejects.toThrow("no separate database writer was started")
      expect((await SharedServer.readState())?.runtimeID).toBe("previous-installed-runtime")
      expect(SharedServer.isProcessAlive(process.pid)).toBe(true)
    } finally {
      await lease?.release()
      if (previous === undefined) delete process.env.MENDCODE_SHARED_SERVER_STATE_FILE
      else process.env.MENDCODE_SHARED_SERVER_STATE_FILE = previous
    }
  })

  test("forwards an explicit database to the shared child with primary alias precedence", () => {
    const original = { primary: process.env.MENDCODE_DB, legacy: process.env.OPENCODE_DB }
    try {
      process.env.MENDCODE_DB = ":memory:"
      process.env.OPENCODE_DB = "ignored.db"
      const env = sharedServerEnvironment({ username: "test", password: "test" }, "test-runtime")
      expect(env.MENDCODE_DB).toBe(":memory:")
      expect(env.OPENCODE_DB).toBe(":memory:")
      expect(env.MENDCODE_SHARED_SERVER_STATE_FILE).toEndWith("server.json")
    } finally {
      if (original.primary === undefined) delete process.env.MENDCODE_DB
      else process.env.MENDCODE_DB = original.primary
      if (original.legacy === undefined) delete process.env.OPENCODE_DB
      else process.env.OPENCODE_DB = original.legacy
    }
  })

  async function check(project?: string) {
    await using tmp = await tmpdir({ git: true })
    const link = path.join(path.dirname(tmp.path), path.basename(tmp.path) + "-link")
    const type = process.platform === "win32" ? "junction" : "dir"

    try {
      await fs.symlink(tmp.path, link, type)
      expect(resolveThreadDirectory(project, link, tmp.path)).toBe(tmp.path)
    } finally {
      await fs.rm(link, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  test("uses the real cwd when PWD points at a symlink", async () => {
    await check()
  })

  test("uses the real cwd after resolving a relative project from PWD", async () => {
    await check(".")
  })

  test("resolves an explicit shared server URL", () => {
    expect(resolveSharedServerURL("http://127.0.0.1:4096")).toBe("http://127.0.0.1:4096/")
  })

  test("falls back to the environment for the shared server URL", () => {
    expect(resolveSharedServerURL(undefined, "https://mendcode.example.test")).toBe("https://mendcode.example.test/")
  })

  test("rejects credentials and unsupported shared server URLs", () => {
    expect(() => resolveSharedServerURL("ftp://127.0.0.1:4096")).toThrow("http or https")
    expect(() => resolveSharedServerURL("http://user:password@127.0.0.1:4096")).toThrow("credentials")
  })

  test("does not use virtual BunFS paths for the shared server child", () => {
    expect(resolveRuntimeEntrypoint("/$bunfs/root/src/index.js", process.cwd())).toBeUndefined()
    expect(resolveRuntimeEntrypoint("B:/~BUN/root/src/index.js", process.cwd())).toBeUndefined()
    expect(resolveRuntimeEntrypoint("src/index.ts", process.cwd())).toBe(path.resolve(process.cwd(), "src/index.ts"))
  })

  test("keeps retrying a managed local server until it recovers", () => {
    expect(SHARED_SERVER_RECONNECT_MAX_ATTEMPTS).toBe(Number.POSITIVE_INFINITY)
  })
})
