/** Imports every module of the agent's tree and compares each exported `*_MS` constant with the expected table. */
import { readFileSync } from "node:fs"
import path from "node:path"

const root = process.argv[2]
if (!root) throw new Error("usage: bun verify.ts <tree>")
const expected = JSON.parse(readFileSync(path.join(import.meta.dir, "expected-ms.json"), "utf8")) as Record<string, Record<string, number>>

const problems: string[] = []
for (const [relative, constants] of Object.entries(expected)) {
  let module: Record<string, unknown>
  try {
    module = (await import(path.join(root, relative))) as Record<string, unknown>
  } catch (error) {
    problems.push(`${relative}: cannot import (${error instanceof Error ? error.message : String(error)})`)
    continue
  }
  for (const [name, value] of Object.entries(constants)) {
    if (module[name] !== value) problems.push(`${relative}: ${name} is ${String(module[name])}, expected ${value}`)
  }
}

if (problems.length > 0) {
  console.error(problems.join("\n"))
  process.exit(1)
}
console.log(`verified ${Object.keys(expected).length} modules`)
