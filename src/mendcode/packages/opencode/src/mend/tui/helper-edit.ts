import type { MendTuiProfile } from "../profile"
import { mergeMendTuiProfile, validateMendTuiProfile } from "../profile"
import { buildRunPlan, executeRunPlan } from "../runtime/run"
import { readTuiSurfaceDraft } from "./profile-actions"

export type TuiHelperEditTarget = "home" | "session" | "footer" | "sidebar" | "chatInput"

export type TuiHelperEditResult = {
  ok: boolean
  changed: boolean
  status: "applied" | "blocked" | "invalid-output" | "error" | "no-change"
  target: TuiHelperEditTarget
  patch?: {
    homeAscii?: string
    sessionAscii?: string
    profile?: Partial<MendTuiProfile>
    pluginSource?: string
  }
  diagnostics: string[]
  model?: string | null
}

function extractJsonObject(text: string) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]
  const raw = fenced || text
  const start = raw.indexOf("{")
  const end = raw.lastIndexOf("}")
  if (start < 0 || end < start) return
  try {
    return JSON.parse(raw.slice(start, end + 1)) as unknown
  } catch {
    return
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function cleanPatchText(value: unknown) {
  if (typeof value !== "string") return undefined
  const text = value.trimEnd()
  if (!text.trim()) return undefined
  return text
}

function containsForbiddenSurfaceText(value: string | undefined) {
  if (!value) return false
  return value.includes("### MendCode local edit") || value.includes(".mendcode/tui/surfaces") || value.includes(".mendcode/tui/drafts")
}

function helperPrompt(input: {
  instruction: string
  target: TuiHelperEditTarget
  homeAscii: string
  sessionAscii: string
}) {
  return [
    "You are MendCode's setup Helper for editing the terminal TUI draft.",
    "Return only one JSON object. Do not include Markdown, prose, file paths, secrets, comments, or explanations.",
    "Allowed output shape:",
    '{"homeAscii":"optional string","sessionAscii":"optional string","profile":"optional partial MendTuiProfile object","pluginSource":"optional string"}',
    "Only include fields that must change. Preserve any surface that does not need to change.",
    "Never append the user's instruction as content unless the user explicitly asks for that visible text.",
    "Never include local filesystem paths or headings like 'MendCode local edit'.",
    `Target: ${input.target}`,
    `Instruction: ${input.instruction}`,
    "",
    "Current homeAscii:",
    input.homeAscii,
    "",
    "Current sessionAscii:",
    input.sessionAscii,
  ].join("\n")
}

export async function runTuiHelperEdit(input: {
  instruction: string
  target: TuiHelperEditTarget
  root?: string
}): Promise<TuiHelperEditResult> {
  const instruction = input.instruction.trim()
  if (!instruction) {
    return {
      ok: false,
      changed: false,
      status: "no-change",
      target: input.target,
      diagnostics: ["Empty helper instruction."],
      model: null,
    }
  }

  const draft = await readTuiSurfaceDraft(input.root)
  const prompt = helperPrompt({
    instruction,
    target: input.target,
    homeAscii: draft.homeAscii,
    sessionAscii: draft.sessionAscii,
  })

  try {
    const plan = await buildRunPlan({ prompt, dryRun: false, root: input.root, promptMode: "focus" })
    if (plan.blockers.length || !plan.wouldCallProvider) {
      return {
        ok: false,
        changed: false,
        status: "blocked",
        target: input.target,
        diagnostics: plan.blockers.length
          ? [...plan.blockers].filter((item): item is string => typeof item === "string" && item.length > 0)
          : ["No configured provider call is available for Helper edits."],
        model: plan.selected?.modelID ?? null,
      }
    }

    const { result } = await executeRunPlan({ plan, prompt, root: input.root })
    const model = result.model || plan.selected.modelID || null
    if (!result.ok) {
      return {
        ok: false,
        changed: false,
        status: "error",
        target: input.target,
        diagnostics: [result.outputText || "Helper provider call failed."],
        model,
      }
    }

    const parsed = extractJsonObject(result.outputText || "")
    if (!isRecord(parsed)) {
      return {
        ok: false,
        changed: false,
        status: "invalid-output",
        target: input.target,
        diagnostics: ["Helper returned no JSON object."],
        model,
      }
    }

    const patch = {
      homeAscii: cleanPatchText(parsed.homeAscii),
      sessionAscii: cleanPatchText(parsed.sessionAscii),
      pluginSource: cleanPatchText(parsed.pluginSource),
      profile: isRecord(parsed.profile) ? (parsed.profile as Partial<MendTuiProfile>) : undefined,
    }

    if (containsForbiddenSurfaceText(patch.homeAscii) || containsForbiddenSurfaceText(patch.sessionAscii) || containsForbiddenSurfaceText(patch.pluginSource)) {
      return {
        ok: false,
        changed: false,
        status: "invalid-output",
        target: input.target,
        diagnostics: ["Helper output included internal paths or old local-edit marker text."],
        model,
      }
    }

    if (patch.profile) {
      const validation = validateMendTuiProfile(mergeMendTuiProfile(patch.profile))
      if (!validation.ok) {
        return {
          ok: false,
          changed: false,
          status: "invalid-output",
          target: input.target,
          diagnostics: validation.failures,
          model,
        }
      }
    }

    const changed =
      (patch.homeAscii !== undefined && patch.homeAscii.trimEnd() !== draft.homeAscii.trimEnd()) ||
      (patch.sessionAscii !== undefined && patch.sessionAscii.trimEnd() !== draft.sessionAscii.trimEnd()) ||
      patch.pluginSource !== undefined ||
      patch.profile !== undefined

    if (!changed) {
      return {
        ok: true,
        changed: false,
        status: "no-change",
        target: input.target,
        diagnostics: ["Helper returned a valid response with no draft changes."],
        model,
      }
    }

    return {
      ok: true,
      changed: true,
      status: "applied",
      target: input.target,
      patch,
      diagnostics: [],
      model,
    }
  } catch (error) {
    return {
      ok: false,
      changed: false,
      status: "error",
      target: input.target,
      diagnostics: [error instanceof Error ? error.message : String(error)],
      model: null,
    }
  }
}
