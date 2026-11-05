import { readFileSync } from "node:fs"
import instructions from "../prompts/memory-extract.md" with { type: "file" }
import full from "../prompts/memory-extract-full.md" with { type: "file" }

/**
 * The after-turn extractor's request: the packaged criteria (prompts/memory-extract.md; the full tier's
 * prompts/memory-extract-full.md also keeps decisions and the state of the work, with scores), then the redacted digest of the turn.
 */
export function memoryExtractionPrompt(digest: string, fullTier = false) {
  return `${readFileSync(fullTier ? full : instructions, "utf8").trim()}\n\n${digest}`
}
