import { createHash } from "node:crypto"
import { WORKFLOW_SCRIPT_MAX_BYTES, WorkflowScriptMeta, type WorkflowPlan, type WorkflowScriptOrigin } from "@mendcode/protocol"
import { scanForbidden, splitScript } from "./script-source"

/** Arguments are frozen into the plan (and its hash), so they stay small. */
export const MAX_SCRIPT_ARGS_BYTES = 8 * 1024

export const scriptHash = (source: string) => createHash("sha256").update(source).digest("hex")

export type ParsedScript = { ok: true; meta: WorkflowScriptMeta; body: string; hash: string } | { ok: false; problems: string[] }

/** Reads a script without running it: size, literal meta (validated), and the forbidden-construct scan of its body. */
export function parseScript(source: string): ParsedScript {
  if (Buffer.byteLength(source) > WORKFLOW_SCRIPT_MAX_BYTES) return { ok: false, problems: [`the script is larger than ${WORKFLOW_SCRIPT_MAX_BYTES / 1024} KiB`] }
  const split = splitScript(source)
  if (!split.ok) return { ok: false, problems: [split.problem] }
  const meta = WorkflowScriptMeta.safeParse(split.meta)
  if (!meta.success) return { ok: false, problems: meta.error.issues.slice(0, 5).map((issue) => `meta.${issue.path.join(".") || "(root)"}: ${issue.message}`) }
  const forbidden = scanForbidden(split.body)
  if (forbidden) return { ok: false, problems: [forbidden] }
  return { ok: true, meta: meta.data, body: split.body, hash: scriptHash(source) }
}

/** The plan a script runs as: no static tasks, the script frozen in it (source, hash, meta, args, origin). */
export function buildScriptPlan(input: { source: string; args?: Record<string, unknown> | undefined; origin: WorkflowScriptOrigin }): { ok: true; plan: WorkflowPlan } | { ok: false; problems: string[] } {
  const parsed = parseScript(input.source)
  if (!parsed.ok) return parsed
  const { meta } = parsed
  if (input.args && Buffer.byteLength(JSON.stringify(input.args)) > MAX_SCRIPT_ARGS_BYTES) return { ok: false, problems: [`args are larger than ${MAX_SCRIPT_ARGS_BYTES / 1024} KiB`] }
  return {
    ok: true,
    plan: {
      name: meta.name,
      objective: meta.description || meta.name,
      tasks: [],
      ...(meta.contract !== undefined ? { contract: meta.contract } : {}),
      ...(meta.permission ? { permission: meta.permission } : {}),
      maxConcurrent: meta.maxConcurrent ?? 16,
      script: { source: input.source, hash: parsed.hash, meta, ...(input.args ? { args: input.args } : {}), origin: input.origin },
    },
  }
}

/** Problems with a script plan that the shape check cannot see: the hash and meta must be what the source says. */
export function scriptPlanProblems(plan: WorkflowPlan): string[] {
  const { script } = plan
  if (!script) return plan.tasks.length === 0 ? ["a plan needs at least one task"] : []
  const problems: string[] = []
  if (plan.tasks.length) problems.push("a script plan has no static tasks")
  if (plan.phases) problems.push("a script plan declares its phases in meta")
  const parsed = parseScript(script.source)
  if (!parsed.ok) return parsed.problems
  if (parsed.hash !== script.hash) problems.push("the script hash does not match its source")
  if (JSON.stringify(parsed.meta) !== JSON.stringify(script.meta)) problems.push("the script meta does not match its source")
  if (script.args && Buffer.byteLength(JSON.stringify(script.args)) > MAX_SCRIPT_ARGS_BYTES) problems.push(`args are larger than ${MAX_SCRIPT_ARGS_BYTES / 1024} KiB`)
  return problems
}
