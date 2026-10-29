import { afterAll, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { binaryStamp, relaunchArgs } from "../src/relaunch"

const dirs: string[] = []
const tempDir = () => { const dir = mkdtempSync(path.join(tmpdir(), "mc-relaunch-")); dirs.push(dir); return dir }
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }) })

describe("a terminal restarting into a new build", () => {
  test("the stamp changes when an install replaces the binary, and is undefined for a missing, empty or non-executable file", () => {
    const dir = tempDir()
    const file = path.join(dir, "mendcode")
    expect(binaryStamp(file)).toBeUndefined()
    writeFileSync(file, "")
    chmodSync(file, 0o755)
    expect(binaryStamp(file)).toBeUndefined()
    writeFileSync(file, "one")
    const first = binaryStamp(file)
    expect(first).toBeDefined()
    expect(binaryStamp(file)).toBe(first!)
    // The installer writes beside the binary and renames over it.
    writeFileSync(path.join(dir, "next"), "two")
    chmodSync(path.join(dir, "next"), 0o755)
    renameSync(path.join(dir, "next"), file)
    expect(binaryStamp(file)).toBeDefined()
    expect(binaryStamp(file)).not.toBe(first!)
    chmodSync(file, 0o644)
    expect(binaryStamp(file)).toBeUndefined()
  })

  test("the same session is reopened with the terminal's own options; what chose or started a session is not repeated", () => {
    const target = { project: "/work/app", sessionId: "ses_1" }
    expect(relaunchArgs([], target)).toEqual(["/work/app", "--session", "ses_1"])
    expect(relaunchArgs(["old/project", "--continue", "--model", "p/m", "--dir", "/tmp/d", "--no-alt-screen", "--prompt", "hi", "--process=auto", "--fork"], target))
      .toEqual(["--dir", "/tmp/d", "--no-alt-screen", "--process=auto", "/work/app", "--session", "ses_1"])
    expect(relaunchArgs(["--session", "ses_0", "--accessible", "--", "--offline"], target)).toEqual(["--accessible", "/work/app", "--session", "ses_1"])
    expect(relaunchArgs(["--log-level"], target)).toEqual(["--log-level", "/work/app", "--session", "ses_1"])
  })

  test.skipIf(process.platform === "win32")("the process is replaced in place: same pid, the given arguments and environment", async () => {
    const dir = tempDir()
    const script = path.join(dir, "exec.ts")
    writeFileSync(script, `import { selfExec } from ${JSON.stringify(path.join(import.meta.dir, "../src/relaunch"))}
const exec = await selfExec()
if (!exec) { console.log("unsupported"); process.exit(0) }
console.log("before " + process.pid)
exec("/bin/sh", ["-c", "echo after $$ $MARK $0 $1", "zero", "one"], { PATH: process.env.PATH, MARK: "kept" })
console.log("refused")
`)
    const child = Bun.spawn([process.execPath, script], { stdout: "pipe", stderr: "pipe" })
    const out = (await new Response(child.stdout).text()).trim().split("\n")
    expect(await child.exited).toBe(0)
    if (out[0] === "unsupported") return
    const pid = out[0]!.replace("before ", "")
    expect(out[1]).toBe(`after ${pid} kept zero one`)
  })
})
