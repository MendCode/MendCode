import { PROMPT_FOCUS_CHOICES, PROMPT_MODES, type PromptMode, type PromptFocusChoice } from "@mendcode/protocol/wire"

export type PromptAutomation = { kind: "prompt"; operation: "sources" | "build" | "mode" | "cycle-mode"; mode?: PromptMode; focusID?: PromptFocusChoice; modelID?: string; role?: string; workflow?: string; showFull?: boolean }
export function parsePromptAutomation(args: string[], flags: Map<string, string | true>): PromptAutomation | { error: string } {
  const operation = args[0] ?? "mode"
  if (!["sources", "build", "mode", "cycle-mode"].includes(operation)) return { error: "prompt needs sources|build|mode|cycle-mode" }
  const allowed = new Set(["dir", "json", "format", "compat", "help", ...(operation === "build" ? ["mode", "focus", "model", "role", "workflow", "show-full"] : operation === "mode" ? ["focus"] : operation === "sources" ? ["model"] : [])])
  for (const key of flags.keys()) if (!allowed.has(key)) return { error: `--${key} is not valid for prompt ${operation}` }
  if (args.length > (operation === "mode" ? 2 : 1)) return { error: `unexpected argument for prompt ${operation}` }
  const str = (key: string) => typeof flags.get(key) === "string" ? String(flags.get(key)) : undefined
  const rawMode = operation === "build" ? str("mode") ?? "focus" : args[1]
  const mode = rawMode === "dev-js" ? "full" : rawMode
  if (mode !== undefined && !PROMPT_MODES.includes(mode as PromptMode)) return { error: "mode needs minimal|focus|guide|full|custom" }
  const focusID = str("focus") ?? (operation === "build" ? "auto" : undefined)
  if (focusID !== undefined && !PROMPT_FOCUS_CHOICES.includes(focusID as PromptFocusChoice)) return { error: "focus needs " + PROMPT_FOCUS_CHOICES.join("|") }
  for (const key of ["model", "role", "workflow"]) if (str(key) !== undefined && (!str(key) || str(key)!.startsWith("--") || str(key)!.length > (key === "model" ? 200 : 100))) return { error: `invalid --${key}` }
  return { kind: "prompt", operation: operation as PromptAutomation["operation"], ...(mode ? { mode: mode as PromptMode } : {}), ...(focusID ? { focusID: focusID as PromptFocusChoice } : {}), ...(str("model") ? { modelID: str("model")! } : {}), ...(str("role") ? { role: str("role")! } : {}), ...(str("workflow") ? { workflow: str("workflow")! } : {}), ...(flags.has("show-full") ? { showFull: true } : {}) }
}
