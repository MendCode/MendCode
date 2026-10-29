import type { SystemPart } from "@mendcode/engine-native"
import type { PromptFiles, PromptOverrides } from "./extensions"
import { composePromptParts, createPromptModes } from "./prompt-modes"

export function promptContextParts(dir: string, root: string, parts: SystemPart[], binding: { modelID?: string; role?: string } = {}): SystemPart[] {
  return composePromptParts(dir, root, parts, binding).parts
}

/**
 * The prompt files a prompt mode reads. `APPEND_SYSTEM.md` is the user's own text, like AGENTS.md, so every mode carries it;
 * `SYSTEM.md` replaces the packaged base prompt, which `focus`, `guide` and `full` send (`minimal` and `custom` have their own
 * base and never send the packaged one).
 */
export function promptFilesFor(mode: string, files: PromptOverrides): PromptOverrides {
  return mode === "minimal" || mode === "custom" ? (files.appendSystem ? { appendSystem: files.appendSystem } : {}) : files
}

/** The prompt files of the project's own prompt mode. */
export function promptFileOverrides(dir: string, root: string, prompts: PromptFiles): PromptOverrides {
  return promptFilesFor(createPromptModes(dir).status(root).mode, prompts.read(root))
}
