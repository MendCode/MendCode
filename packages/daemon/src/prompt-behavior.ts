import type { PromptFamily, PromptFocus } from "@mendcode/protocol/wire"
import { modelNote } from "./prompt-guidance"

const MODEL_GUIDANCE: Array<{ family: PromptFamily; pattern: RegExp; label: string; text: string }> = [
  { family: "codex", pattern: /gpt[-_.:/]?5[-_.:/]?6(?:[^a-z0-9]|$)/i, label: "GPT-5.6 compatibility", text: "No model-specific harness is assumed. Resolve reasoning, caching, transport and tool availability from the current runtime." },
  { family: "codex", pattern: /gpt[-_.:/]?6[-_.:/]?astra(?:[^a-z0-9]|$)/i, label: "GPT-6 Astra compatibility", text: "Verify exposed tools, context limits and reasoning settings before promising advanced capabilities. A model alias is not a Codex CLI feature contract." },
  { family: "claude", pattern: /claude[-_.:/]?sonnet[-_.:/]?5(?:3)?(?:[^a-z0-9]|$)/i, label: "Claude Sonnet 5 guidance", text: "Apply explicit instructions to all affected items. Use deliberate tool calls and useful progress updates on complex tasks; keep simple answers concise." },
  { family: "claude", pattern: /claude[-_.:/]?opus[-_.:/]?5(?:3)?(?:[^a-z0-9]|$)/i, label: "Claude Opus 5 guidance", text: "Decompose long coding tasks, inspect tool results and self-verify. Keep the requested scope and runtime permissions explicit throughout." },
  { family: "deepseek", pattern: /deepseek[-_.:/]?v?(?:4|3[-_.:/]?2)(?:[-_.:/]?(?:flash|pro|exp))?(?:\[[^\]]+\])?(?:[^a-z0-9]|$)/i, label: "DeepSeek runtime guidance", text: "Check the actual model behind compatibility aliases. Thinking, context, web search and subagents are runtime settings; iterate with tools and report uncertainty when verification is unavailable." },
  { family: "kimi", pattern: /(?:kimi|moonshot)[-_.:/]?k2[-_.:/]?5(?:[^a-z0-9]|$)/i, label: "Kimi K2.5 guidance", text: "Use only exposed multimodal and agent tools. Instant/thinking mode belongs to runtime configuration. Inspect coding tool results and verify changes." },
]

/** `guide` adds the model note of the family's prompt file after the compatibility note, when one matches. */
export function promptBehavior(family: PromptFocus, binding: { modelID?: string; role?: string; workflow?: string }, options: { guide?: boolean } = {}) {
  const model = MODEL_GUIDANCE.find((item) => item.family === family && item.pattern.test(binding.modelID ?? ""))
  const sections: Array<{ id: string; label: string; text: string }> = []
  if (model) sections.push({ id: "model-behavior", label: model.label, text: model.text })
  const note = options.guide ? modelNote(family, binding.modelID) : undefined
  if (note) sections.push({ id: "model-guidance", label: note.label, text: note.text })
  if (binding.role === "review") sections.push({ id: "review", label: "Review policy", text: "Review the requested change for confirmed defects. Trace callers and error paths; report location, trigger and impact with evidence. Reviewing does not grant permission to edit." })
  else if (binding.workflow === "edit" || binding.workflow === "apply") sections.push({ id: "editing", label: "Editing policy", text: "Inspect the target and its immediate contract before changing it. Apply focused patches, preserve unrelated work, and run proportionate checks on the resulting behavior." })
  return sections
}
