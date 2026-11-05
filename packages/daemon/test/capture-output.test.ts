import { expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { captureOutput } from "../src/project-git"

const leftovers = () => readdirSync(tmpdir()).filter((name) => name.startsWith(`mendcode-capture-${process.pid}-`))

test("captureOutput returns the output and removes its temporary file", async () => {
  const result = await captureOutput(["/bin/echo", "hello"], { limit: 1024, timeoutMs: 5000 })
  expect(result).toEqual({ code: 0, stopped: false, out: "hello\n" })
  expect(leftovers()).toEqual([])
})

test("captureOutput reports a failing exit code with its output", async () => {
  const result = await captureOutput(["/bin/sh", "-c", "echo partial; exit 3"], { limit: 1024, timeoutMs: 5000 })
  expect(result.code).toBe(3)
  expect(result.out).toBe("partial\n")
})

test("captureOutput stops a child whose output passes the limit", async () => {
  const result = await captureOutput(["/usr/bin/yes"], { limit: 4096, timeoutMs: 5000 })
  expect(result.stopped).toBe(true)
  expect(result.out).toBe("")
  expect(leftovers()).toEqual([])
})

test("captureOutput stops a child that outlives its time limit", async () => {
  const result = await captureOutput(["/bin/sleep", "5"], { limit: 1024, timeoutMs: 100 })
  expect(result.stopped).toBe(true)
  expect(leftovers()).toEqual([])
})

test("captureOutput stops a child when the request is cancelled", async () => {
  const controller = new AbortController()
  const pending = captureOutput(["/bin/sleep", "5"], { signal: controller.signal, limit: 1024, timeoutMs: 5000 })
  setTimeout(() => controller.abort(), 50)
  expect((await pending).stopped).toBe(true)
  expect(leftovers()).toEqual([])
})
