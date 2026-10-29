import { describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { jgEnvironment, parseJgOutput } from "../src"
import { harness, project, useTempDirs } from "./helpers"

const tmp = useTempDirs()

const SOURCE = {
  "src/upload.ts": ["export function retryUpload(file: string) {", "  // retries failed uploads with exponential backoff", "  return file", "}", ""].join("\n"),
  "src/other.ts": "export function unrelated() {}\n",
}

function fakeJg(body: string): string {
  const dir = tmp()
  const path = join(dir, "jg")
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

function setup({ jgBin, jgTimeoutMs }: { jgBin?: string; jgTimeoutMs?: number } = {}) {
  const root = project({ root: tmp(), files: SOURCE })
  return harness({ root, cacheDir: tmp(), options: { jgBin, jgTimeoutMs } })
}

async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    try {
      process.kill(pid, 0)
    } catch {
      return true
    }
    await Bun.sleep(50)
  }
  return false
}

describe("code_search with jg", () => {
  test("runs jg <query> <path>, parses summary and file:line hits, and passes a minimal environment", async () => {
    const before = { secret: process.env.SECRET_TOKEN, key: process.env.OPENROUTER_API_KEY }
    process.env.SECRET_TOKEN = "must-not-leak"
    process.env.OPENROUTER_API_KEY = "k-test"
    try {
      const jg = fakeJg(
        [
          'echo "Uploads are retried in the uploader."',
          'echo "args: [$1] [$2]"',
          'echo "env: secret=[$SECRET_TOKEN] key=[$OPENROUTER_API_KEY]"',
          'echo "src/upload.ts:1: export function retryUpload"',
          'echo "$2/src/upload.ts:2:5 - retries failed uploads"',
        ].join("\n"),
      )
      const h = setup({ jgBin: jg })
      const result = await h.call("code_search", { query: "where do uploads retry" })
      expect(result.isError).toBe(false)
      expect(result.meta).toMatchObject({ engine: "jg", hits: 2 })
      expect(result.output).toContain("Uploads are retried in the uploader.")
      expect(result.output).toContain(`args: [where do uploads retry] [${h.root}]`)
      expect(result.output).toContain("env: secret=[] key=[k-test]")
      expect(result.output).toContain("src/upload.ts:1  export function retryUpload")
      expect(result.output).toContain("src/upload.ts:2  - retries failed uploads")
      expect(h.scans).toEqual([])
    } finally {
      if (before.secret === undefined) delete process.env.SECRET_TOKEN
      else process.env.SECRET_TOKEN = before.secret
      if (before.key === undefined) delete process.env.OPENROUTER_API_KEY
      else process.env.OPENROUTER_API_KEY = before.key
    }
  })

  test("a path argument is resolved inside the project and handed to jg; outside paths are refused", async () => {
    const h = setup({ jgBin: fakeJg('echo "scope: $2"\necho "src/upload.ts:1: hit"') })
    const scoped = await h.call("code_search", { query: "x", path: "src" })
    expect(scoped.output).toContain(`scope: ${join(h.root, "src")}`)
    expect((await h.call("code_search", { query: "x", path: "../elsewhere" })).isError).toBe(true)
  })

  test("output is bounded to 50 hits", async () => {
    const h = setup({ jgBin: fakeJg('i=1\nwhile [ $i -le 200 ]; do echo "src/upload.ts:$i: line $i"; i=$((i+1)); done') })
    const result = await h.call("code_search", { query: "lots" })
    expect(result.meta).toMatchObject({ engine: "jg", hits: 50 })
    expect(result.truncated).toBe(true)
    expect(result.output.split("\n").filter((line) => line.startsWith("src/upload.ts:")).length).toBe(50)
    expect(result.output).toContain("Hits (50 of 200)")
  })

  test("a timeout kills jg's whole process group and falls back to the graph", async () => {
    const dir = tmp()
    const pidfile = join(dir, "pid")
    const h = setup({ jgBin: fakeJg(`sh -c 'sleep 30' &\necho $! > ${pidfile}\nwait`), jgTimeoutMs: 2_000 })
    const started = Date.now()
    const result = await h.call("code_search", { query: "retry upload" })
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(result.isError).toBe(false)
    expect(result.meta).toMatchObject({ engine: "graph" })
    expect(result.meta?.fallback).toBe("jg timed out after 0 s".replace("0 s", `${Math.round(2_000 / 1000)} s`))
    expect(result.output).toContain("src/upload.ts:1  function retryUpload")
    expect(existsSync(pidfile)).toBe(true)
    expect(await gone(Number(readFileSync(pidfile, "utf8").trim()))).toBe(true)
  })

  test("aborting the turn kills jg and returns cancelled", async () => {
    const dir = tmp()
    const pidfile = join(dir, "pid")
    const h = setup({ jgBin: fakeJg(`sh -c 'sleep 30' &\necho $! > ${pidfile}\nwait`) })
    const controller = new AbortController()
    // Abort only once the fake jg has started its child, or there is nothing left to kill under a loaded run.
    void (async () => {
      while (!existsSync(pidfile) || readFileSync(pidfile, "utf8").trim() === "") await Bun.sleep(20)
      controller.abort()
    })()
    const started = Date.now()
    const result = await h.call("code_search", { query: "retry upload" }, controller.signal)
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(result).toMatchObject({ isError: true, output: "cancelled" })
    expect(await gone(Number(readFileSync(pidfile, "utf8").trim()))).toBe(true)
  })

  test("a failing or silent jg falls back and says why", async () => {
    const failing = await setup({ jgBin: fakeJg('echo boom >&2\nexit 3') }).call("code_search", { query: "retry upload" })
    expect(failing.meta).toMatchObject({ engine: "graph", fallback: "jg exited with code 3: boom" })
    expect(failing.output).toContain("[graph search: jg exited with code 3: boom]")
    const silent = await setup({ jgBin: fakeJg("exit 0") }).call("code_search", { query: "retry upload" })
    expect(silent.meta).toMatchObject({ engine: "graph", fallback: "jg returned no output" })
  })
})

describe("code_search without jg", () => {
  test("a missing jg binary falls back to ranked symbols plus a literal text search", async () => {
    const h = setup({ jgBin: "/nonexistent/jg" })
    const result = await h.call("code_search", { query: "failed uploads" })
    expect(result.isError).toBe(false)
    expect(result.meta).toMatchObject({ engine: "graph", fallback: "jg is not installed" })
    expect(result.output).toContain("[graph search: jg is not installed]")
    expect(result.output).toContain("Symbols:")
    expect(result.output).toContain("src/upload.ts:1  function retryUpload")
    expect(result.output).toContain("Text matches:")
    expect(result.output).toContain("src/upload.ts:2  // retries failed uploads with exponential backoff")
  })

  test("with no jgBin option, jg is looked up on PATH and its absence falls back", async () => {
    const before = process.env.PATH
    process.env.PATH = tmp()
    try {
      const result = await setup().call("code_search", { query: "retryUpload" })
      expect(result.meta).toMatchObject({ engine: "graph" })
      expect(result.output).toContain("src/upload.ts:1  function retryUpload")
    } finally {
      process.env.PATH = before
    }
  })

  test("a jg on PATH is used", async () => {
    const dir = tmp()
    mkdirSync(dir, { recursive: true })
    const jg = join(dir, "jg")
    writeFileSync(jg, '#!/bin/sh\necho "src/upload.ts:1: from PATH"\n')
    chmodSync(jg, 0o755)
    const before = process.env.PATH
    process.env.PATH = `${dir}:${before}`
    try {
      const result = await setup().call("code_search", { query: "anything" })
      expect(result.meta).toMatchObject({ engine: "jg", hits: 1 })
    } finally {
      process.env.PATH = before
    }
  })

  test("the fallback honours path and reports no match plainly", async () => {
    const h = setup({ jgBin: "/nonexistent/jg" })
    const scoped = await h.call("code_search", { query: "unrelated", path: "src/upload.ts" })
    expect(scoped.output).not.toContain("src/other.ts")
    const none = await h.call("code_search", { query: "qqqqzzzz" })
    expect(none.output).toContain('No symbols or text match "qqqqzzzz"')
  })
})

describe("jg helpers", () => {
  test("the environment carries PATH, HOME and only the named provider keys", () => {
    const env = jgEnvironment({ PATH: "/bin", HOME: "/home/u", AI_GATEWAY_API_KEY: "a", OPENROUTER_API_KEY: "", OPENCODE_API_KEY: "c", AWS_SECRET_ACCESS_KEY: "no", ANTHROPIC_API_KEY: "no" })
    expect(env).toEqual({ PATH: "/bin", HOME: "/home/u", AI_GATEWAY_API_KEY: "a", OPENCODE_API_KEY: "c" })
  })

  test("parseJgOutput separates prose from hits, strips colour and normalises absolute paths", () => {
    const parsed = parseJgOutput({
      cwd: "/work/app",
      text: ["\u001b[1mFound it\u001b[0m", "----", "1. /work/app/src/a.ts:10:3: const x = 1", "- src/b.py:4-9", "/elsewhere/c.go:7: outside", "plain prose"].join("\n"),
    })
    expect(parsed.summary).toBe("Found it\nplain prose")
    expect(parsed.hits).toEqual([
      { path: "src/a.ts", line: 10, text: "const x = 1" },
      { path: "src/b.py", line: 4, text: "" },
      { path: "/elsewhere/c.go", line: 7, text: "outside" },
    ])
  })
})
