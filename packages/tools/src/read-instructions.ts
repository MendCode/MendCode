import { realpath } from "node:fs/promises"
import path from "node:path"
import { collectInstructions, instructionChain, instructionFileIn, newInstructionState } from "./instructions"
import type { ToolContext } from "./tool"

const MAX_BYTES = 16_000

/** What marks one delivered version of an instruction file: its real path and `mtimeMs:size`. An edit changes it, so the file is delivered again. */
export const instructionClaim = (resolved: string, signature: string) => `${resolved}#${signature}`

const inside = (root: string, target: string) => {
  const relative = path.relative(root, target)
  return relative !== "" && !(relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
}

/**
 * Nearby instructions below the session directory, loaded when a file there is read; root/global policy is already in the
 * system prompt. Same loader as the prompt's: per directory `AGENTS.override.md` > `AGENTS.md` > `CLAUDE.md` > `CONTEXT.md`
 * (plus the configured fallbacks), `@include` lines, the same per-file and total limits, outermost directory first. A file is
 * delivered once per version: `loadedInstructions` holds `path#mtime:size` claims, so an edited file is injected again.
 */
export async function readInstructions(file: string, context: ToolContext, maxBytes = MAX_BYTES) {
  const root = await realpath(context.cwd).catch(() => path.resolve(context.cwd))
  const target = await realpath(file).catch(() => file)
  const options = context.instructions ?? {}
  const projectRoot = await realpath(instructionChain(root, options)[0] ?? root).catch(() => root)
  const directories: string[] = []
  for (let directory = path.dirname(target); inside(root, directory); directory = path.dirname(directory)) directories.unshift(directory)
  const loaded: string[] = []
  const blocks: string[] = []
  const state = newInstructionState()
  let budget = Math.max(0, Math.min(MAX_BYTES, maxBytes))
  for (const directory of directories) {
    if (budget <= 0 || context.signal.aborted) break
    const first = instructionFileIn(directory, options)
    if (!first) continue
    collectInstructions(first, {
      root: projectRoot, includes: options.includes?.() !== false, ...(options.maxChars ? { maxChars: options.maxChars } : {}), state,
      emit: (section) => {
        const claim = instructionClaim(section.resolved, section.signature)
        if (budget <= 0 || section.resolved === target || context.loadedInstructions?.has(claim)) return
        const bytes = Buffer.from(section.text)
        const cut = bytes.length > budget
        const text = (cut ? bytes.subarray(0, budget).toString() : section.text).trim()
        budget -= Math.min(bytes.length, budget)
        if (!text) return
        loaded.push(claim)
        context.loadedInstructions?.add(claim)
        blocks.push(`Instructions from: ${section.resolved}\n${text}${cut ? "\n[… instructions truncated]" : ""}`)
      },
    })
  }
  return { loaded, text: blocks.length ? `\n\n<system-reminder>\n${blocks.join("\n\n")}\n</system-reminder>` : "" }
}
