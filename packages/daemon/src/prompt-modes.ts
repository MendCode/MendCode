import { mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { PROMPT_FAMILIES, PROMPT_FOCUS_CHOICES, PROMPT_MODES, promptFocusLabel, redactSecrets, type PromptBuildReport, type PromptFamily, type PromptFocus, type PromptFocusChoice, type PromptMode, type PromptModeCost, type PromptStatus } from "@mendcode/protocol/wire"
import { NATIVE_DEFAULTS, type SystemPart } from "@mendcode/engine-native"
import { createTuiControl } from "./tui-control"
import { promptBehavior } from "./prompt-behavior"
import { resolveFocus } from "./prompt-focus"
import { guideText, operatorGuideText, selfKnowledgeText } from "./prompt-guidance"

type Choice = { mode?: PromptMode; focusID?: PromptFocusChoice }
export const FOCUS_CONTEXT: Record<PromptFocus, { files: string[]; behavior: string }> = {
  neutral: { files: ["AGENTS.md", ".mendcode/context/project.md"], behavior: "Read before editing, stay in scope, verify with command output and use only the capabilities this runtime exposes." },
  codex: { files: ["AGENTS.md", ".agents/context.md", ".agents/global/context.md", ".mendcode/context/project.md"], behavior: "Read the AGENTS.md hierarchy. Prefer focused patches and executable verification. Respect sandbox and approval boundaries." },
  claude: { files: ["CLAUDE.md", "AGENTS.md", ".mendcode/context/project.md"], behavior: "Read before writing. Plan complex work explicitly, verify risky changes with tests and keep output proportional to the task." },
  gemini: { files: ["GEMINI.md", "AGENTS.md", ".mendcode/context/project.md"], behavior: "Track checkpoints during large-context work. Ground conclusions in repository evidence and command or evaluation results." },
  kimi: { files: ["AGENTS.md", ".mendcode/context/project.md"], behavior: "Use shell tools deliberately, inspect command output, and load skills or delegate only when authorized and exposed by the runtime." },
  deepseek: { files: ["AGENTS.md", ".agents/context.md", ".mendcode/context/project.md"], behavior: "Verify before reporting success. Track context and cache usage from runtime facts. Independent work may use authorized subagents; model aliases do not grant capabilities." },
  mistral: { files: ["AGENTS.md", ".vibe/AGENTS.md", ".mendcode/context/project.md"], behavior: "Read agent configuration and tool policy first. Respect configured turn and cost limits; validate results with command output." },
  glm: { files: ["AGENTS.md", ".mendcode/context/project.md"], behavior: "Iterate with tools: plan, act, inspect results, revise. Answer in the user's language and use only the context and thinking mode this runtime exposes." },
  minimax: { files: ["AGENTS.md", ".mendcode/context/project.md"], behavior: "Work in act-and-verify loops. Use only the tools and skills this session exposes and check every tool result before relying on it." },
  grok: { files: ["AGENTS.md", ".mendcode/context/project.md"], behavior: "Keep steps small and verify each one with command output. Use only exposed tools and permissions; make no claims about hidden behavior." },
  local: { files: ["AGENTS.md", ".mendcode/context/project.md"], behavior: "Make one strict tool call at a time with exact arguments, keep context small, stop after repeated failures and verify with command output." },
}

function projectKey(root: string) {
  try { return realpathSync(root) } catch { return path.resolve(root) }
}
function boundedProjectFile(root: string, relative: string, limit: number) {
  const project = realpathSync(root)
  const file = realpathSync(path.join(project, relative))
  const rel = path.relative(project, file)
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) throw new Error("Prompt source must stay inside the project")
  const info = statSync(file)
  if (!info.isFile()) throw new Error("Prompt source must be a regular file")
  if (info.size > limit) throw new Error(`Prompt source exceeds ${limit} bytes`)
  const raw = readFileSync(file, "utf8")
  if (Buffer.byteLength(raw) > limit) throw new Error(`Prompt source exceeds ${limit} bytes`)
  return raw.replace(/\r\n?/g, "\n").trim()
}
export function readProjectPrompt(root: string) {
  const relative = ".mendcode/prompts/custom.md"
  const status: PromptStatus["customPrompt"] = { name: "Project prompt", path: relative, bytes: 0, available: false, fallbackReason: null }
  try {
    const raw = boundedProjectFile(root, relative, 32 * 1024)
    const front = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(raw)
    const name = front ? /^name\s*:\s*(.+)$/im.exec(front[1]!)?.[1] : /^#\s+(.+)$/m.exec(raw)?.[1]
    const text = (front ? raw.slice(front[0].length) : raw).trim()
    if (!text) throw new Error("Custom prompt is empty")
    return { status: { ...status, name: (name?.trim().replace(/^['"]|['"]$/g, "") || status.name).slice(0, 80), bytes: Buffer.byteLength(text), available: true }, text }
  } catch (error) {
    return { status: { ...status, fallbackReason: (error as NodeJS.ErrnoException).code === "ENOENT" ? "Custom prompt is unavailable" : (error as Error).message }, text: "" }
  }
}

/**
 * Project choices live in the daemon data dir; folder profiles and model settings remain independent.
 * `defaultModel` names the model a status is read for when the caller names none (the project's main model),
 * so `auto` can show which family it resolves to.
 */
export function createPromptModes(dir: string, options: { defaultModel?(directory: string): string | undefined } = {}) {
  const file = path.join(dir, "prompt-context.json")
  function choices(): Record<string, Choice> {
    try {
      const value = JSON.parse(readFileSync(file, "utf8"))
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid prompt-context.json")
      return value
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
      throw error
    }
  }
  /** The saved choice and what it resolves to, without the cost of each mode (the composer reads this on every model call). */
  function bareStatus(directory: string, modelID?: string): PromptStatus {
    const root = projectKey(directory)
    const current = choices()[root]
    const fallback = createTuiControl(dir).run({ operation: "profile" }).profile.promptContext
    const mode = PROMPT_MODES.includes(current?.mode as PromptMode) ? current!.mode! : PROMPT_MODES.includes(fallback as PromptMode) ? fallback as PromptMode : "focus"
    // A project with no saved family follows its model. A saved `codex` stays `codex`: before `auto` existed it was also what
    // an untouched project saved on its first mode change, and that cannot be told apart from a deliberate choice.
    const focusID = PROMPT_FOCUS_CHOICES.includes(current?.focusID as PromptFocusChoice) ? current!.focusID! : "auto"
    const customPrompt = readProjectPrompt(root).status
    return { directory: root, mode, focusID, resolvedFocus: resolveFocus(focusID, modelID ?? options.defaultModel?.(root)), customPrompt, available: customPrompt.available ? [...PROMPT_MODES] : ["minimal", "focus", "guide", "full"] }
  }
  /** The status a client shows: the saved choice, plus what each available mode adds to every model call for the resolved family and model. */
  function status(directory: string, modelID?: string): PromptStatus {
    const current = bareStatus(directory, modelID)
    return { ...current, costs: modeCosts({ focusID: current.focusID, resolved: current.resolvedFocus, modelID: modelID ?? options.defaultModel?.(current.directory), custom: readProjectPrompt(current.directory) }) }
  }
  function set(directory: string, patch: Choice) {
    if (patch.mode !== undefined && !PROMPT_MODES.includes(patch.mode)) throw new Error("Unknown prompt mode")
    if (patch.focusID !== undefined && !PROMPT_FOCUS_CHOICES.includes(patch.focusID)) throw new Error("Unknown focus family")
    if (patch.mode === undefined && patch.focusID === undefined) throw new Error("Expected mode or focus family")
    const all = choices()
    const current = bareStatus(directory)
    all[current.directory] = { mode: current.mode, focusID: current.focusID, ...patch }
    mkdirSync(dir, { recursive: true })
    const temporary = file + "." + randomUUID() + ".tmp"
    writeFileSync(temporary, JSON.stringify(all, null, 2) + "\n", { mode: 0o600 })
    renameSync(temporary, file)
    return status(directory)
  }
  function cycle(directory: string) {
    const current = bareStatus(directory)
    return set(directory, { mode: current.available[(current.available.indexOf(current.mode) + 1) % current.available.length]! })
  }
  function sources(directory: string, modelID?: string) {
    const current = status(directory, modelID)
    const entry = (id: PromptFocus) => ({ id, sourcePolicy: "native-behavior", promptAvailable: true, contextFiles: FOCUS_CONTEXT[id].files, behavior: FOCUS_CONTEXT[id].behavior })
    return { ...current, focusLabel: promptFocusLabel(current), sources: Object.fromEntries(PROMPT_FAMILIES.map((id) => [id, entry(id)])), neutral: entry("neutral"), architecture: "native-harness", profileMapping: "undecided" }
  }
  return { status, bareStatus, set, cycle, sources }
}

const boundary = (root: string) => `You are MendCode, a coding assistant working in ${root}. Answer directly. Read before editing, preserve unrelated work and verify changes with the available tools. Follow the user's scope, runtime permissions and budgets. Use loop tools for scheduled or repeated work, inspect existing loops first and never set an iteration cap to zero. Configured budgets are authoritative; do not infer limits from a provider name. Do not invent successful tests or tool results. Do not expose secrets.`

const COST_ROOT = "/project"
const costCache = new Map<string, PromptModeCost[]>()
const costBase = () => readFileSync(NATIVE_DEFAULTS.systemPromptFile, "utf8").replaceAll("{{cwd}}", COST_ROOT)

/**
 * What each mode adds to every model call for one family and model: the real composed text (the packaged harness prompt included,
 * the project's instructions, skills, memory and context files left out), characters over four. The static modes are measured once
 * per family and model; `custom` is measured from the project's prompt file each time.
 */
function modeCosts(input: { focusID: PromptFocusChoice; resolved: PromptFocus; modelID: string | undefined; custom: ReturnType<typeof readProjectPrompt> }): PromptModeCost[] {
  const measure = (mode: PromptMode, custom: BuildInput["custom"]) => {
    const parts = buildParts({ mode, focusID: input.focusID, resolved: input.resolved, root: COST_ROOT, parts: [{ id: "base", label: "base prompt", text: costBase() }], override: input.modelID ? { modelID: input.modelID } : {}, custom })
    return Math.ceil(parts.map((part) => part.text).filter(Boolean).join("\n\n").length / 4)
  }
  const key = `${input.focusID}|${input.resolved}|${input.modelID ?? ""}`
  let fixed = costCache.get(key)
  if (!fixed) {
    const focus = measure("focus", input.custom)
    fixed = (["minimal", "focus", "guide", "full"] as const).map((mode) => { const tokens = mode === "focus" ? focus : measure(mode, input.custom); return { mode, tokens, overFocus: tokens - focus } })
    costCache.set(key, fixed)
  }
  if (!input.custom.status.available) return fixed
  const focus = fixed.find((cost) => cost.mode === "focus")!.tokens
  const tokens = measure("custom", input.custom)
  return [...fixed, { mode: "custom", tokens, overFocus: tokens - focus }]
}

/** The same mode policy feeds native turns and prompt build; no provider calls or donor imports. */
export function composePromptParts(dir: string, root: string, parts: SystemPart[], binding: Choice & { modelID?: string; role?: string; workflow?: string; /** Names the model `auto` follows when no call binds one (a preview). */ fallbackModelID?: string } = {}) {
  const { fallbackModelID, ...override } = binding
  const current = createPromptModes(dir).bareStatus(root)
  // `auto` resolves from the model of this very call, so switching the session's model changes the guidance on the next call.
  const resolved = resolveFocus(override.focusID ?? current.focusID, override.modelID ?? fallbackModelID)
  const mode = override.mode ?? current.mode
  const custom = readProjectPrompt(root)
  const built = buildParts({ mode, focusID: override.focusID ?? current.focusID, resolved, root, parts, override, custom })
  const status = { ...current, ...override, focusID: override.focusID ?? current.focusID, resolvedFocus: resolved, costs: modeCosts({ focusID: override.focusID ?? current.focusID, resolved, modelID: override.modelID ?? fallbackModelID, custom }) }
  return { status, parts: built.filter((part) => part.text.trim()), fallbackReason: mode === "custom" ? custom.status.fallbackReason : null }
}

type BuildInput = { mode: PromptMode; focusID: PromptFocusChoice; resolved: PromptFocus; root: string; parts: SystemPart[]; override: { modelID?: string; role?: string; workflow?: string }; custom: ReturnType<typeof readProjectPrompt> }
/** The system parts of one mode for one family: pure, so the cost of each mode is measured on the very text a call would send. */
function buildParts({ mode, focusID, resolved, root, parts, override, custom }: BuildInput): SystemPart[] {
  const memory = parts.filter((part) => part.id === "memory")
  // The user's own rules (AGENTS.md / CLAUDE.md hierarchy and the global file) are not optional chrome: every mode carries them,
  // within the loader's per-file and total caps. Only the skill catalog is a mode choice: focus and full list skills by name and
  // one-line description, minimal and custom leave it to the `skill` tool's listing.
  const instructions = parts.filter((part) => part.id === "instructions")
  // APPEND_SYSTEM.md is the user's own text too: every mode carries it after the instructions.
  const appended = parts.filter((part) => part.id === "append")
  const safe: SystemPart = { id: "boundary", label: "MendCode boundary", text: boundary(root) }
  // One line in every mode but `custom` (which inherits nothing): where to read about configuring and extending MendCode, instead of the web.
  const self: SystemPart = { id: "self-knowledge", label: "MendCode docs pointer", text: selfKnowledgeText() }
  let result: SystemPart[]
  if (mode === "minimal") result = [{ ...safe, id: "base", label: "base prompt (minimal)" }, self, ...instructions, ...appended, ...memory]
  else if (mode === "custom") result = [safe, ...(custom.status.available ? [{ id: "base", label: custom.status.name, text: custom.text.replaceAll("{{cwd}}", root) }] : []), ...instructions, ...appended, ...memory]
  else {
    // Focus and guide keep the native harness (or SYSTEM.md in its place), the user's instructions, the skill catalog and APPEND_SYSTEM.md.
    result = parts.filter((part) => part.id !== "memory" && (mode === "full" || ["base", "instructions", "skills", "append"].includes(part.id)))
    const longGuidance = mode === "guide" || mode === "full"
    result = [...result, safe, self, { id: "focus", label: `${promptFocusLabel({ focusID, resolvedFocus: resolved })} focus`, text: `MendCode focus: ${resolved}${focusID === "auto" ? " (auto)" : ""}. ${FOCUS_CONTEXT[resolved].behavior}` }]
    // `guide` and `full` add the working basics and the family's guidance file; `focus` stays the short line above.
    if (longGuidance) result.push({ id: "focus-guide", label: "Provider guide", text: guideText(resolved) })
    if (override.modelID || override.role || override.workflow) result.push({ id: "binding", label: "Prompt binding", text: `Model: ${override.modelID ?? "runtime"}. Role: ${override.role ?? "main"}. Workflow: ${override.workflow ?? "interactive"}. Use only capabilities exposed by the runtime; do not infer tools, transport, quota or reasoning settings from this binding.` })
    result.push(...promptBehavior(resolved, override, { guide: longGuidance }))
    if (mode === "full") {
      const instructions = parts.find((part) => part.id === "instructions")?.text ?? ""
      for (const relative of FOCUS_CONTEXT[resolved].files) {
        // The hierarchy loader already includes root AGENTS/CLAUDE; do not inject either twice.
        if (instructions.includes(`source="${relative}"`)) continue
        try {
          const text = boundedProjectFile(root, relative, 16_000)
          if (text) result.push({ id: `focus-context:${relative}`, label: relative, text })
        } catch {}
      }
      result.push({ id: "capabilities", label: "MendCode operator guide", text: operatorGuideText() })
    }
    // Memory is chosen per user message, so it goes last and the static parts before it stay a stable prefix.
    result.push(...memory)
  }
  return result
}

export function promptBuildReport(composed: ReturnType<typeof composePromptParts>, input: { modelID?: string | undefined; role?: string | undefined; workflow?: string | undefined; showFull?: boolean | undefined }): PromptBuildReport {
  const { status, parts, fallbackReason } = composed
  const instructions = parts.map((part) => part.text).join("\n\n")
  const preview = (text: string) => redactSecrets(text).text.slice(0, 240)
  return { ...status, modelID: input.modelID ?? null, role: input.role ?? null, workflow: input.workflow ?? null,
    promptOrigin: status.mode === "custom" ? "project-custom" : "preset", basePromptSource: status.mode === "minimal" || status.mode === "custom" && !status.customPrompt.available ? "minimal-base" : status.mode === "custom" ? "project-custom" : "native-harness",
    includeProjectInstructions: true, includeSkillsByDefault: status.mode === "focus" || status.mode === "guide" || status.mode === "full", includeCustomInstructions: status.mode === "full", fallbackReason,
    sections: parts.map((part) => ({ id: part.id, label: part.label, bytes: Buffer.byteLength(part.text), preview: preview(part.text) })), instructionsBytes: Buffer.byteLength(instructions), instructionsPreview: preview(instructions), printsFullPrompt: input.showFull === true,
    ...(input.showFull ? { instructions: redactSecrets(instructions).text } : {}),
  }
}
