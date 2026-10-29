import { afterEach, expect, test } from "bun:test"
import { chmodSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createBackgroundTasks, read, shell, type BackgroundTasks } from "../src"
import { makeContext, useTempDir } from "./helpers"

const temp = useTempDir()
const registries: BackgroundTasks[] = []
afterEach(() => { for (const registry of registries.splice(0)) registry.stop() })
function customShell(directory: string) {
  const file = path.join(directory, "configured-shell")
  writeFileSync(file, '#!/bin/sh\nexport B42_SHELL=custom\nexec /bin/sh "$@"\n')
  chmodSync(file, 0o700)
  return file
}

test("configured shell is used by foreground and background execution", async () => {
  const directory = temp(), executable = customShell(directory)
  const context = { ...makeContext({ cwd: directory }), shell: executable }
  expect((await shell.execute({ command: "printf '%s' \"$B42_SHELL\"" }, context)).output).toBe("custom")
  const tasks = createBackgroundTasks({})
  registries.push(tasks)
  const port = tasks.forSession("b42")
  const result = await shell.execute({ command: "printf '%s' \"$B42_SHELL\"", background: true }, { ...context, background: port })
  expect(result.isError).toBe(false)
  const output = await port.read(String(result.meta?.taskId), { waitMs: 500, signal: context.signal })
  expect(output?.output).toBe("custom")
})

test("engine-owned truncation receives more than the old 50 KB cap from shell and read", async () => {
  const directory = temp()
  const file = path.join(directory, "large.txt")
  const text = "long line of source text\n".repeat(3000)
  writeFileSync(file, text)
  const context = { ...makeContext({ cwd: directory }), outputLimits: { maxBytes: 100000, maxLines: 4000 } }
  const readResult = await read.execute({ path: "large.txt", limit: 3000 }, context)
  expect(Buffer.byteLength(readResult.output)).toBeGreaterThan(51200)
  expect(readResult.output).toContain("3000")
  const shellResult = await shell.execute({ command: "cat large.txt" }, context)
  expect(shellResult.output).toBe(text)
  expect(shellResult.truncated).toBe(false)
})
