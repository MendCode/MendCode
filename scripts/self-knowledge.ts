// Regenerate the texts MendCode tells about itself from docs/*.md and their authored sources, or check them without modifying files (`--check`):
// the reference cards `mendcode docs` prints (embedded in the binary) and the operator guide that prompt mode `full` sends.
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { CARDS_FILE, CARDS_REGENERATE, cardIndexText, docCards } from "../packages/daemon/src/doc-cards"
import { OPERATOR_GUIDE_FILE, operatorGuide } from "../packages/daemon/src/operator-guide"

export const SELF_KNOWLEDGE_REGENERATE = CARDS_REGENERATE
export { CARDS_FILE, OPERATOR_GUIDE_FILE }

const root = path.resolve(import.meta.dir, "..")

if (import.meta.main) {
  const targets = [{ name: CARDS_FILE, expected: cardIndexText(docCards(root)) }, { name: OPERATOR_GUIDE_FILE, expected: operatorGuide(root) }]
  const check = process.argv.includes("--check")
  let stale = false
  for (const { name, expected } of targets) {
    const file = path.join(root, name)
    if (check) {
      if (!existsSync(file) || readFileSync(file, "utf8") !== expected) {
        console.error(`${name} is stale. Run: ${SELF_KNOWLEDGE_REGENERATE}`)
        stale = true
      } else console.log(`${name} is up to date`)
    } else {
      writeFileSync(file, expected)
      console.log(`wrote ${name}`)
    }
  }
  if (stale) process.exit(1)
}
