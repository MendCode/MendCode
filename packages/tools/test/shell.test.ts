import { describe, expect, test } from "bun:test"
import { shell } from "../src"
import { alive, makeContext, useTempDir } from "./helpers"

const tmp = useTempDir()
const run = (command: string, extra: { timeoutMs?: number; workdir?: string } = {}, ctx = makeContext({ cwd: tmp() })) =>
  shell.execute({ command, ...extra }, ctx)

describe("shell", () => {
  test("captures merged output, exit code 0 and env", async () => {
    const result = await run("echo out; echo err 1>&2; echo $PAGER $TERM")
    expect(result.isError).toBe(false)
    expect(result.output).toContain("out\n")
    expect(result.output).toContain("err\n")
    expect(result.output).toContain("cat dumb\n")
    expect(result.meta).toMatchObject({ exitCode: 0, timedOut: false, cancelled: false })
    expect(result.title).toBe("echo out; echo err 1>&2; echo $PAGER $TERM")
  })
  test("non-zero exit is an error; stdin is closed", async () => {
    const failed = await run("exit 3")
    expect(failed.isError).toBe(true)
    expect(failed.meta?.exitCode).toBe(3)
    expect(failed.output).toBe("[exit 3]")
    expect((await run("cat")).output).toBe("")
  })
  test("honours workdir and reports a bad one", async () => {
    const root = tmp()
    const ok = await shell.execute({ command: "pwd", workdir: "." }, makeContext({ cwd: root }))
    expect(ok.output.trim().endsWith(root.split("/").pop() as string)).toBe(true)
    const bad = await shell.execute({ command: "pwd", workdir: "nope" }, makeContext({ cwd: root }))
    expect(bad.isError).toBe(true)
  })
  test("streams chunks to onOutput", async () => {
    const chunks: string[] = []
    const ctx = makeContext({ cwd: tmp(), onOutput: (c) => chunks.push(c) })
    await shell.execute({ command: "echo a; sleep 0.2; echo b" }, ctx)
    expect(chunks.join("")).toBe("a\nb\n")
    expect(chunks.length).toBeGreaterThan(1)
  })
  test("keeps head and tail when output is long", async () => {
    const result = await run("seq 1 10000")
    expect(result.truncated).toBe(true)
    expect(result.output.startsWith("1\n2\n")).toBe(true)
    expect(result.output.trimEnd().endsWith("10000")).toBe(true)
    expect(result.output).toMatch(/… [\d,]+ lines omitted …/)
    expect(result.output.split("\n").length).toBeLessThan(2100)
  })
  test("title clips the first line to 60 chars", async () => {
    const result = await run(`echo ${"x".repeat(100)}\necho two`)
    expect(result.title.length).toBe(60)
  })
  test("cancel kills the child quickly", async () => {
    const controller = new AbortController()
    const pids: number[] = []
    const ctx = makeContext({ cwd: tmp(), signal: controller.signal, onOutput: (c) => pids.push(...(c.match(/\d+/g) ?? []).map(Number)) })
    const started = Date.now()
    const pending = shell.execute({ command: "sleep 30 & echo $!; wait" }, ctx)
    await Bun.sleep(300)
    controller.abort()
    const result = await pending
    expect(Date.now() - started).toBeLessThan(3000)
    expect(result.meta?.cancelled).toBe(true)
    expect(result.isError).toBe(true)
    expect(pids.length).toBe(1)
    await Bun.sleep(100)
    expect(alive(pids[0] as number)).toBe(false)
  })
  test("already-aborted signal does not run", async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await run("echo hi", {}, makeContext({ cwd: tmp(), signal: controller.signal }))
    expect(result.output).toBe("cancelled")
  })
  test("timeout kills the command", async () => {
    const started = Date.now()
    const result = await run("sleep 30", { timeoutMs: 300 })
    expect(Date.now() - started).toBeLessThan(3000)
    expect(result.meta?.timedOut).toBe(true)
    expect(result.isError).toBe(true)
    expect(result.output).toContain("timed out")
  })
  test("process-group kill takes down every child", async () => {
    const controller = new AbortController()
    const pids: number[] = []
    const ctx = makeContext({ cwd: tmp(), signal: controller.signal, onOutput: (c) => pids.push(...(c.match(/\d+/g) ?? []).map(Number)) })
    const pending = shell.execute({ command: "sleep 30 & echo $!; sleep 31 & echo $!; wait" }, ctx)
    await Bun.sleep(400)
    expect(pids.length).toBe(2)
    controller.abort()
    await pending
    await Bun.sleep(100)
    for (const pid of pids) expect(alive(pid)).toBe(false)
  })
  test("returns promptly when a background process holds the pipes", async () => {
    const started = Date.now()
    const result = await run("sleep 30 & echo done")
    expect(Date.now() - started).toBeLessThan(3000)
    expect(result.output).toContain("done")
  })
  test("binary output is one line with its size, never the bytes, also in the live output", async () => {
    const chunks: string[] = []
    const result = await shell.execute({ command: "head -c 13224 /dev/urandom" }, makeContext({ cwd: tmp(), onOutput: (c) => chunks.push(c) }))
    expect(result.output).toBe("[binary output: 13,224 bytes; not shown. Use file, xxd | head, or strings to inspect it]")
    expect(result.isError).toBe(false)
    expect(result.meta).toMatchObject({ exitCode: 0, binary: true, outputBytes: 13224 })
    expect(chunks.join("")).toBe("[binary output; not shown]\n")
    // NUL-heavy bytes that are valid UTF-8 (the start of an executable) count too, and a failing command keeps its exit line.
    const zeros = await run("head -c 600 /dev/zero; printf 'MZ header'; exit 4")
    expect(zeros.output).toBe("[binary output: 609 bytes; not shown. Use file, xxd | head, or strings to inspect it]\n[exit 4]")
    expect(zeros.isError).toBe(true)
  })
  test("text is never taken for binary: any language, colour codes, progress bars, box drawing, a few odd bytes, NUL-separated lists", async () => {
    const samples = [
      "printf 'héllo wörld · 日本語のテキスト · العربية · Ελληνικά · 🙂\\n'",
      "printf '\\033[1;31merror\\033[0m \\033[32mok\\033[0m\\n'",
      "printf 'downloading 10%%\\rdownloading 55%%\\rdownloading 100%%\\n'",
      "printf '┌──────┬──────┐\\n│ name │ size │\\n└──────┴──────┘\\n'",
      "printf 'a line with one stray byte \\377 and a bell \\007 in forty characters of text\\n'",
      "printf 'src/first/file.ts\\000src/second/file.ts\\000src/third/file.ts\\000'",
      "printf 'col1\\tcol2\\r\\nval1\\tval2\\r\\n\\f'",
    ]
    for (const command of samples) {
      const result = await run(command)
      expect(result.output, command).not.toContain("[binary output")
      expect(result.meta?.binary, command).toBeUndefined()
      expect(result.output.length, command).toBeGreaterThan(10)
    }
  })
  test("a failing command ends with its exit code; a search or comparison that answers no says so and stays an error", async () => {
    const none = await run("printf 'HOME=/x\\nPATH=/y\\n' | grep -E '^(A|B)'")
    expect(none.output).toBe("[exit 1: no match]")
    expect(none.isError).toBe(true)
    expect(none.meta).toMatchObject({ exitCode: 1, expectedExit: "no match" })
    const differ = await run("printf 'a\\n' > one; printf 'b\\n' > two; diff one two")
    expect(differ.output.endsWith("\n[exit 1: files differ]")).toBe(true)
    expect((await run("test -f nowhere")).output).toBe("[exit 1: false]")
    expect((await run("true && [ -d nowhere ]")).output).toBe("[exit 1: false]")
    expect((await run("LC_ALL=C grep -c zzz /dev/null")).output).toBe("0\n[exit 1: no match]")
    // Not that narrow case: another exit code, something on stderr, a last command that is not a search, a negated one.
    const missing = await run("grep zzz ./no-such-file")
    expect(missing.output).toMatch(/No such file[^\n]*\n\[exit 2\]$/)
    expect(missing.meta?.expectedExit).toBeUndefined()
    expect((await run("echo warn 1>&2; echo a | grep b")).output).toBe("warn\n[exit 1]")
    expect((await run("echo a | grep b; false")).output).toBe("[exit 1]")
    expect((await run("grep b /dev/null || exit 1")).output).toBe("[exit 1]")
    expect((await run("echo 'x | grep y'; exit 1")).output).toBe("x | grep y\n[exit 1]")
    expect((await run("! grep -q a /dev/null; exit 1")).output).toBe("[exit 1]")
    expect((await run("echo fine | grep fine")).output).toBe("fine\n")
  })
  test("SIGTERM-ignoring child is escalated to SIGKILL", async () => {
    const started = Date.now()
    const result = await run("trap '' TERM; sleep 30", { timeoutMs: 200 })
    expect(Date.now() - started).toBeLessThan(4000)
    expect(result.meta?.timedOut).toBe(true)
  })
})
