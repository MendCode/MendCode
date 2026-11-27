import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createExtensionRuntime } from "../src/extensions/runtime"
import type { ExtensionFile } from "../src/extensions/discover"

const body = (note: string) => `export default { name: "mend-decide", tui() { /* ${note} */ } }\n`

async function load(files: string[]) {
  const runtime = createExtensionRuntime({ redraw() {} })
  const entries = files.map((file) => ({ file, dir: path.dirname(file), source: "user" as const, pkg: path.basename(path.dirname(path.dirname(path.dirname(file)))) }) as unknown as ExtensionFile)
  await runtime.load(entries)
  const out = { loaded: runtime.loaded.length, problems: [...runtime.problems] }
  runtime.dispose()
  return out
}

function twoPackages(first: string, second: string) {
  const root = mkdtempSync(path.join(tmpdir(), "same-file-"))
  const files = [first, second].map((text, index) => {
    const file = path.join(root, `pkg${index}`, "extensions", "mend-decide.ts")
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, text)
    return file
  })
  return { root, files }
}

test("two packages shipping the identical extension file load it once without a warning", async () => {
  const { root, files } = twoPackages(body("same"), body("same"))
  try {
    const result = await load(files)
    expect(result.problems).toEqual([])
    expect(result.loaded).toBe(1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("two different files with one extension name still warn, once", async () => {
  const { root, files } = twoPackages(body("a"), body("b"))
  try {
    const result = await load(files)
    expect(result.problems.map((problem) => problem.message)).toHaveLength(1)
    expect(result.problems[0]!.message).toContain("already called mend-decide")
    expect(result.loaded).toBe(1)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
