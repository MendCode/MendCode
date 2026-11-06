import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const preload = path.join(import.meta.dir, "test-tmpdir.ts")
const root = path.join(import.meta.dir, "..")

/** Runs `code` in a bun process with the test preload and the given TMPDIR; what is left in that TMPDIR afterwards. */
function leftAfter(code: string, home: string) {
  const result = Bun.spawnSync([process.execPath, "--preload", preload, "-e", code], { cwd: root, env: { ...process.env, TMPDIR: home, MENDCODE_TEST_TMP_BASE: home }, stderr: "pipe" })
  expect(result.exitCode).toBe(0)
  return readdirSync(home)
}

test("a test process that makes temporary directories and never removes them leaves nothing in the real one", () => {
  const home = mkdtempSync(path.join(tmpdir(), "tmpdir-preload-"))
  try {
    const left = leftAfter(`const fs = require("node:fs"), os = require("node:os"), p = require("node:path")
      for (const prefix of ["mendcode-session-ui-", "mendcode-mcp-", "mendcode-nightly-"]) fs.writeFileSync(p.join(fs.mkdtempSync(p.join(os.tmpdir(), prefix)), "x"), "x")`, home)
    expect(left).toEqual([])
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test("the shared test helpers remove what they made when the process ends", () => {
  const home = mkdtempSync(path.join(tmpdir(), "tmpdir-helpers-"))
  try {
    // MENDCODE_TEST_KEEP_TMPDIR turns the preload off, so only the helpers' own cleanup is measured.
    const code = `const ui = require(${JSON.stringify(path.join(root, "apps/cli/test/session-ui-harness.ts"))}); ui.tempDir()
      const mcp = require(${JSON.stringify(path.join(root, "packages/mcp/test/helpers.ts"))}); mcp.tempDir()`
    const result = Bun.spawnSync([process.execPath, "-e", code], { cwd: root, env: { ...process.env, TMPDIR: home, MENDCODE_TEST_KEEP_TMPDIR: "1" }, stderr: "pipe" })
    expect(result.exitCode).toBe(0)
    expect(readdirSync(home)).toEqual([])
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test("the directory of a test process that was killed is removed by the next one", () => {
  const home = mkdtempSync(path.join(tmpdir(), "tmpdir-orphan-"))
  try {
    const dead = Bun.spawnSync([process.execPath, "-e", "1"]) as unknown as { pid?: number }
    const stale = path.join(home, `mendtest-${dead.pid ?? 2_147_000_000}`)
    mkdirSync(stale)
    writeFileSync(path.join(stale, "x"), "x")
    for (const keep of ["mendtest-keep", "mendtest-1-x"]) mkdirSync(path.join(home, keep))
    expect(leftAfter("1", home).sort()).toEqual(["mendtest-1-x", "mendtest-keep"])
  } finally { rmSync(home, { recursive: true, force: true }) }
})
