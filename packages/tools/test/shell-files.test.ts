import { expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { shell } from "../src"
import { makeContext, useTempDir } from "./helpers"

const tmp = useTempDir()
const leftovers = () => readdirSync(tmpdir()).filter((name) => name.startsWith(`mendcode-capture-${process.pid}-`))

test("shell shows output while the command is still running", async () => {
  const seen: { text: string; at: number }[] = []
  const started = Date.now()
  const result = await shell.execute({ command: "echo first; sleep 0.5; echo second" }, makeContext({ cwd: tmp(), onOutput: (text) => seen.push({ text, at: Date.now() - started }) }))
  expect(seen.map((entry) => entry.text).join("")).toBe("first\nsecond\n")
  expect(seen[0]?.text).toBe("first\n")
  expect(seen[0]!.at).toBeLessThan(400)
  expect(result.meta?.durationMs).toBeGreaterThanOrEqual(450)
})

test("shell keeps standard error apart from standard output and counts it", async () => {
  const result = await shell.execute({ command: "echo out; echo problem >&2; exit 1" }, makeContext({ cwd: tmp() }))
  expect(result.output).toContain("out\n")
  expect(result.output).toContain("problem\n")
  // stderr was written, so exit 1 is not explained away as an expected search result
  expect(result.meta?.expectedExit).toBeUndefined()
  const quiet = await shell.execute({ command: "grep -q zzz /dev/null" }, makeContext({ cwd: tmp() }))
  expect(quiet.meta?.expectedExit).toBeDefined()
})

test("shell leaves no temporary file after success, failure, abort or timeout", async () => {
  await shell.execute({ command: "echo ok" }, makeContext({ cwd: tmp() }))
  await shell.execute({ command: "echo bad >&2; exit 4" }, makeContext({ cwd: tmp() }))
  await shell.execute({ command: "sleep 5", timeoutMs: 100 }, makeContext({ cwd: tmp() }))
  const controller = new AbortController()
  const pending = shell.execute({ command: "echo going; sleep 5" }, makeContext({ cwd: tmp(), signal: controller.signal }))
  await Bun.sleep(150)
  expect(leftovers()).toEqual([])
  controller.abort()
  const aborted = await pending
  expect(aborted.output).toContain("[cancelled]")
  expect(leftovers()).toEqual([])
})

test("shell still keeps the head and tail of output past the retention caps", async () => {
  const result = await shell.execute({ command: "yes 0123456789 | head -c 6000000; echo; echo THE-END" }, makeContext({ cwd: tmp() }))
  expect(result.truncated).toBe(true)
  expect(result.output).toContain("THE-END")
  expect(result.output.startsWith("0123456789")).toBe(true)
  expect(leftovers()).toEqual([])
})
