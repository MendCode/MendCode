import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { canonicalDir } from "@mendcode/tools"

/** Private project notes live under the daemon data dir, never in a session or model context. */
export function scratchpadFile(dir: string, directory: string) {
  const key = createHash("sha256").update(canonicalDir(directory)).digest("hex")
  return path.join(dir, "scratchpads", `${key}.txt`)
}
export function readScratchpad(dir: string, directory: string) {
  try { return readFileSync(scratchpadFile(dir, directory), "utf8").slice(0, 8_000) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error }
}
export function writeScratchpad(dir: string, directory: string, text: string) {
  const file = scratchpadFile(dir, directory)
  mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, text.replace(/\r\n?/g, "\n").slice(0, 8_000))
  renameSync(temp, file)
}
