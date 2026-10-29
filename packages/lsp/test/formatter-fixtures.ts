import { chmodSync } from "node:fs"
import { join } from "node:path"
import { put } from "./helpers"

export const FORMATTER_FIXTURE = join(import.meta.dir, "fixtures", "fake-formatter.ts")
export function formatterFixture(root: string, names = ["prettier", "oxfmt", "biome"]) {
  put({ root, path: "package.json", content: JSON.stringify({ devDependencies: { prettier: "test", oxfmt: "test" } }) })
  put({ root, path: "biome.jsonc", content: "{}" })
  for (const name of names) {
    const file = put({ root, path: `node_modules/.bin/${name}`, content: `#!${process.execPath}\nimport ${JSON.stringify(FORMATTER_FIXTURE)}\n` })
    chmodSync(file, 0o755)
  }
  return { command: [process.execPath, FORMATTER_FIXTURE, "$FILE"] }
}
