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

/**
 * The "Terminal rendering" lines of the packaged prompt: what an answer may use because MendCode draws it (Markdown, math,
 * Mermaid diagrams and charts). An engine with its own system prompt (Claude Code) gets these lines appended, so the model
 * knows a diagram is drawn here; without them it never writes one.
 */
export async function loadTerminalRendering(file: string = NATIVE_DEFAULTS.systemPromptFile) {
  const lines = (await Bun.file(file).text()).split("\n")
  const start = lines.findIndex((line) => line.startsWith("Terminal rendering"))
  if (start < 0) return ""
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => !line.startsWith("- "))
  return [lines[start]!, ...(end < 0 ? rest : rest.slice(0, end))].join("\n")
}
