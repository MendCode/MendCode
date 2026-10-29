import { describe, expect, test } from "bun:test"
import { realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { extensionExec } from "../src/extensions/exec"

describe("api.exec runs one program without a shell and always answers", () => {
  test("output, exit code, input on stdin and cwd", async () => {
    expect(await extensionExec("cat", [], { input: "hello\n" })).toEqual({ stdout: "hello\n", stderr: "", code: 0 })
    expect(await extensionExec("sh", ["-c", "echo oops >&2; exit 3"])).toEqual({ stdout: "", stderr: "oops\n", code: 3 })
    const dir = realpathSync(tmpdir())
    expect((await extensionExec("pwd", [], { cwd: dir })).stdout.trim()).toBe(dir)
  })

  test("arguments are never a shell line", async () => {
    expect((await extensionExec("echo", ["$HOME; rm -rf /"])).stdout).toBe("$HOME; rm -rf /\n")
  })

  test("a missing program, a timeout and bad arguments resolve with code null and an error instead of rejecting", async () => {
    const missing = await extensionExec("no-such-program-mendcode-test")
    expect(missing.code).toBeNull()
    expect(missing.error).toBeString()
    const started = Date.now()
    const slow = await extensionExec("sleep", ["5"], { timeoutMs: 100 })
    expect(slow.code).toBeNull()
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(await extensionExec("", [])).toMatchObject({ code: null, error: "exec needs a program name" })
    expect(await extensionExec("echo", [1 as never])).toMatchObject({ code: null, error: "exec arguments are strings" })
  })
})
