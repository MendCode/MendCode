import { readFileSync } from "node:fs"
import instructions from "../prompts/memory-extract.md" with { type: "file" }

/** The after-turn extractor's request: the packaged criteria (prompts/memory-extract.md), then the redacted digest of the turn. */
export function memoryExtractionPrompt(digest: string) {
  return `${readFileSync(instructions, "utf8").trim()}\n\n${digest}`
}
