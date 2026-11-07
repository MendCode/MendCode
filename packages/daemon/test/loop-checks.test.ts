import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { FULL_OUTPUT_BYTES, runChecks } from "@mendcode/loops"
import { RUNNER_FULL_OUTPUT_BYTES, runLoopCheck } from "../src/loop-checks"

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

describe("loop check stdin", () => {
  const withStdin = (argv: string[], stdin?: string) => runLoopCheck({ argv, cwd: process.cwd(), signal: new AbortController().signal, timeoutSeconds: 20, ...(stdin === undefined ? {} : { stdin }) })
  const echoStdin = [process.execPath, "-e", "const text = await Bun.stdin.text(); process.stdout.write(`len=${Buffer.byteLength(text)} text=${text}`)"]

  test("the given text reaches the command's stdin exactly, and stdin is closed after it", async () => {
    const result = await withStdin(echoStdin, "héllo\nworld")
    expect(result.exitCode).toBe(0)
    expect(result.output).toBe("len=12 text=héllo\nworld")
  })

  test("without stdin the command reads an empty, closed stdin as before", async () => {
    const result = await withStdin(echoStdin)
    expect(result.exitCode).toBe(0)
    expect(result.output).toBe("len=0 text=")
  })
})

describe("loop check whole output", () => {
  const print = (code: string, fullOutput?: boolean) => runLoopCheck({ argv: [process.execPath, "-e", code], cwd: process.cwd(), signal: new AbortController().signal, timeoutSeconds: 20, ...(fullOutput === undefined ? {} : { fullOutput }) })

  test("the runner's bound is the one @mendcode/loops declares", () => {
    expect(RUNNER_FULL_OUTPUT_BYTES).toBe(FULL_OUTPUT_BYTES)
  })

  test("with fullOutput the output's start comes back whole in full while output stays the tail", async () => {
    const result = await print(`process.stdout.write("START" + "x".repeat(200_000) + "END")`, true)
    expect(result.exitCode).toBe(0)
    expect(result.full).toBe(`START${"x".repeat(200_000)}END`)
    expect(result.output.length).toBe(64_000)
    expect(result.output.endsWith("END")).toBe(true)
  })

  test("past FULL_OUTPUT_BYTES full stops growing (the caller cuts it) while the tail still ends with the last line", async () => {
    const result = await print(`for (let i = 0; i < 64; i++) process.stdout.write("y".repeat(65_536)); process.stdout.write("LAST")`, true)
    expect(result.full!.startsWith("yyyy")).toBe(true)
    expect(result.full!.length).toBeGreaterThan(1_048_576)
    expect(result.full!.length).toBeLessThan(2 * 1_048_576)
    expect(result.output.endsWith("LAST")).toBe(true)
  })

  test("a whitespace-heavy captured prefix retains overflow evidence when the final line is discarded", async () => {
    const result = await print(`process.stdout.write("HEADER\\n"); for (let i = 0; i < 64; i++) process.stdout.write(" ".repeat(65_536)); process.stdout.write("LAST")`, true)
    expect(result.exitCode).toBe(0)
    expect(Buffer.byteLength(result.full!, "utf8")).toBeGreaterThan(FULL_OUTPUT_BYTES)
    expect(result.full!.trimEnd()).toBe("HEADER")
    expect(result.output.endsWith("LAST")).toBe(true)
  })

  test("without fullOutput a long output keeps only today's 64K tail and no start", async () => {
    const result = await print(`process.stdout.write("START" + "z".repeat(1_200_000) + "END")`)
    expect(result.full).toBeUndefined()
    expect(result.output.length).toBe(64_000)
    expect(result.output.endsWith("END")).toBe(true)
  })

  test("runChecks (loops, verifier, contract checks) never asks for the full output, even keeping output or with stdin", async () => {
    const seen: Array<Record<string, unknown>> = []
    await runChecks({ checks: ["bun test", "bun run lint"], cwd: process.cwd(), signal: new AbortController().signal, keepOutput: true, stdin: "x", run: async (input) => (seen.push(input), { exitCode: 0, output: "ok" }) })
    expect(seen).toHaveLength(2)
    for (const input of seen) expect("fullOutput" in input).toBe(false)
  })

  test("only the workflow-script check path asks the runner for the full output", async () => {
    const root = join(import.meta.dir, "..", "..", "..")
    const askers: string[] = []
    for (const dir of ["packages", "apps"])
      for await (const file of new Bun.Glob("*/src/**/*.{ts,tsx}").scan({ cwd: join(root, dir) }))
        if (/fullOutput\s*:\s*(?!boolean)/.test((await Bun.file(join(root, dir, file)).text()).replace(/^\s*(\/\/|\*).*$/gm, ""))) askers.push(`${dir}/${file}`)
    expect(askers).toEqual(["packages/workflows/src/service.ts"])
  })
})
