import { expect, test } from "bun:test"
import { readdirSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { captureOutput } from "../src/capture-output"

const leftovers = () => readdirSync(tmpdir()).filter((name) => name.startsWith(`mendcode-capture-${process.pid}-`))

test("captureOutput returns the output and removes its temporary file", async () => {
  const result = await captureOutput(["/bin/echo", "hello"], { limit: 1024, timeoutMs: 5000 })
  expect(result).toEqual({ code: 0, stopped: false, truncated: false, out: "hello\n", err: "" })
  expect(leftovers()).toEqual([])
})

test("captureOutput reports a failing exit code with its output", async () => {
  const result = await captureOutput(["/bin/sh", "-c", "echo partial; exit 3"], { limit: 1024, timeoutMs: 5000 })
  expect(result.code).toBe(3)
  expect(result.out).toBe("partial\n")
})

test("captureOutput keeps standard error apart, only when asked", async () => {
  const script = ["/bin/sh", "-c", "echo out; echo problem >&2; exit 2"]
  expect(await captureOutput(script, { limit: 1024, timeoutMs: 5000 })).toMatchObject({ code: 2, out: "out\n", err: "" })
  expect(await captureOutput(script, { stderr: "capture", limit: 1024, timeoutMs: 5000 })).toMatchObject({ code: 2, out: "out\n", err: "problem\n" })
  expect(leftovers()).toEqual([])
})

test("captureOutput passes the working directory, the environment and the standard input", async () => {
  const result = await captureOutput(["/bin/sh", "-c", "pwd; echo $PROBE; cat"], { cwd: "/", env: { PATH: "/usr/bin:/bin", PROBE: "yes" }, stdin: "typed", limit: 1024, timeoutMs: 5000 })
  expect(result.out).toBe("/\nyes\ntyped")
})

test("captureOutput stops a child whose output passes the limit", async () => {
  const result = await captureOutput(["/usr/bin/yes"], { limit: 4096, timeoutMs: 5000 })
  expect(result).toMatchObject({ stopped: true, truncated: true, out: "" })
  expect(leftovers()).toEqual([])
})

test("captureOutput with keepOnLimit stops the child and returns the first bytes", async () => {
  const result = await captureOutput(["/usr/bin/yes"], { limit: 4096, timeoutMs: 5000, keepOnLimit: true })
  expect(result).toMatchObject({ stopped: false, truncated: true })
  expect(result.out.length).toBe(4096)
  expect(leftovers()).toEqual([])
})

test("captureOutput stops a child that outlives its time limit", async () => {
  const started = Date.now()
  const result = await captureOutput(["/bin/sleep", "5"], { limit: 1024, timeoutMs: 100 })
  expect(result.stopped).toBe(true)
  expect(Date.now() - started).toBeLessThan(3000)
  expect(leftovers()).toEqual([])
})

test("captureOutput stops a child when the request is cancelled", async () => {
  const controller = new AbortController()
  const pending = captureOutput(["/bin/sleep", "5"], { signal: controller.signal, limit: 1024, timeoutMs: 5000 })
  setTimeout(() => controller.abort(), 50)
  expect((await pending).stopped).toBe(true)
  expect(leftovers()).toEqual([])
})

test("captureOutput does not start work for a request already cancelled", async () => {
  const controller = new AbortController()
  controller.abort()
  const started = Date.now()
  expect((await captureOutput(["/bin/sleep", "5"], { signal: controller.signal, limit: 1024, timeoutMs: 5000 })).stopped).toBe(true)
  expect(Date.now() - started).toBeLessThan(3000)
})

test("captureOutput throws for a program that does not exist and leaves no file", async () => {
  await expect(captureOutput(["/nonexistent/program"], { limit: 1024, timeoutMs: 1000 })).rejects.toThrow()
  expect(leftovers()).toEqual([])
})

test("captureOutput keeps its files private to the user", async () => {
  const pending = captureOutput(["/bin/sleep", "1"], { limit: 1024, timeoutMs: 5000 })
  await Bun.sleep(100)
  const [name] = leftovers()
  expect(name).toBeDefined()
  expect(statSync(`${tmpdir()}/${name}`).mode & 0o077).toBe(0)
  await pending
})
