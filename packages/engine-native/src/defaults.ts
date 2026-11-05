import systemFile from "../prompts/system.md" with { type: "file" }
import compactionFile from "../prompts/compaction.md" with { type: "file" }
import continuationFile from "../prompts/continuation.md" with { type: "file" }

/** The one model used for live testing on the user's ChatGPT subscription (decision in the plan §9). */
export const NATIVE_DEFAULTS = {
  providerId: "chatgpt",
  model: "gpt-6-luna",
  effort: "low",
  systemPromptFile: systemFile,
  compactionPromptFile: compactionFile,
} as const

/** Sent after a partial answer the connection cut, asking the model to go on from its last character. */
export async function loadContinuationPrompt(file: string = continuationFile) {
  return (await Bun.file(file).text()).trim()
}

export async function loadCompactionPrompt(file: string = NATIVE_DEFAULTS.compactionPromptFile) {
  return (await Bun.file(file).text()).trim()
}

/** Reads the prompt template once; returns a renderer for a project root. */
export async function loadSystemPrompt(file: string = NATIVE_DEFAULTS.systemPromptFile) {
  const template = await Bun.file(file).text()
  return (cwd: string) => template.replaceAll("{{cwd}}", cwd)
}
