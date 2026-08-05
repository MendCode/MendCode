import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../../fixture/fixture"
import {
  resolveRuntimeEntrypoint,
  resolveSharedServerURL,
  resolveThreadDirectory,
  SHARED_SERVER_RECONNECT_MAX_ATTEMPTS,
} from "../../../src/cli/cmd/tui/thread"

describe("tui thread", () => {
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
