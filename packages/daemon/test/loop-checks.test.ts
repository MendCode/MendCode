import { describe, expect, test } from "bun:test"
import { runLoopCheck } from "../src/loop-checks"

const run = (argv: string[], timeoutSeconds?: number) =>
  runLoopCheck({ argv, cwd: process.cwd(), signal: new AbortController().signal, ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }) })

describe("loop check timeout", () => {
  test("a check that outlives timeoutSeconds is killed and reported with the reason", async () => {
    const started = Date.now()
    const result = await run(["sleep", "5"], 1)
    expect(Date.now() - started).toBeLessThan(4_000)
    expect(result.exitCode).not.toBe(0)
    expect(result.output).toContain("timed out after 1 s")
  })

  test("the output collected before the timeout is kept, and the whole process group is killed", async () => {
    const started = Date.now()
    const result = await run(["sh", "-c", "echo partial-output; sleep 5; echo never"], 1)
    expect(Date.now() - started).toBeLessThan(4_000)
    expect(result.output).toContain("partial-output")
    expect(result.output).toContain("timed out after 1 s")
    expect(result.output).not.toContain("never")
  })

  test("a fast check is unaffected by its timeout", async () => {
    const result = await run(["echo", "fast"], 1)
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain("fast")
    expect(result.output).not.toContain("timed out")
  })

  test("a fast failing check keeps its own exit code and is not reported as a timeout", async () => {
    const result = await run(["sh", "-c", "echo boom; exit 3"], 1)
    expect(result.exitCode).toBe(3)
    expect(result.output).not.toContain("timed out")
  })

  test("without timeoutSeconds the default applies and a fast check passes", async () => {
    const result = await run(["echo", "default"])
    expect(result.exitCode).toBe(0)
    expect(result.output).not.toContain("timed out")
  })
})
