import { createHash, randomUUID } from "node:crypto"
import path from "node:path"
import { Flock } from "@mendcode/core/util/flock"
import { z } from "zod"
import { validateWorkflowPlan, WorkflowPlan } from "@/session/workflow-plan"
import { evolutionPaths, readEvolutionJSON, readEvolutionPolicy, writeEvolutionJSON } from "./config"
import { authorizeEvolutionAction, withEvolutionAction } from "./policy"
import { assertEvolutionTextSafe, listEvolutionEvidence } from "./evidence"

export const CandidateInputSchema = z.object({
  kind: z.enum(["memory", "skill", "workflow"]),
  name: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/),
  description: z.string().min(1).max(300),
  content: z.string().min(1),
  evidenceIDs: z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(5),
}).strict()
export type CandidateInput = z.infer<typeof CandidateInputSchema>
export const CandidateSchema = CandidateInputSchema.extend({
  kind: z.enum(["skill", "workflow"]),
  id: z.string().uuid(), revision: z.string(), hash: z.string(), createdAt: z.string().datetime(),
  status: z.enum(["pending", "active", "rejected", "rolled_back", "blocked"]),
  receipt: z.object({
    kind: z.enum(["memory", "skill", "workflow"]),
    target: z.string(), hash: z.string(), revision: z.number().optional(),
  }).strict().nullable(),
}).strict()
export type EvolutionCandidate = z.infer<typeof CandidateSchema>

export function evolutionHash(value: unknown) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex")
}

export function validateEvolutionCandidate(input: CandidateInput) {
  const candidate = CandidateInputSchema.parse(input)
  if (Buffer.byteLength(JSON.stringify(candidate)) > 32 * 1024) throw new Error("Candidate exceeds 32 KiB")
  assertEvolutionTextSafe(JSON.stringify(candidate))
  if (candidate.kind === "memory" && Buffer.byteLength(candidate.content) > 4096) throw new Error("Memory candidate exceeds 4 KiB")
  if (candidate.kind === "skill" && /^---\s*$/m.test(candidate.content)) throw new Error("Skill content must be a body, not caller-controlled frontmatter")
  if (candidate.kind === "workflow") {
    const plan = WorkflowPlan.zod.parse(JSON.parse(candidate.content)) as WorkflowPlan
    if (plan.completion?.confirmation !== "next-run") throw new Error("Generated workflows require next-run completion audit")
    const result = validateWorkflowPlan(plan)
    if (!result.valid) throw new Error("Workflow preview rejected the candidate")
    const policies = [plan, ...plan.tasks, ...plan.tasks.flatMap((task) => task.map ? [task.map.taskTemplate] : [])]
    if (policies.some((item) => item.permissions?.mode !== "report-only" || item.permissions.allowEdits || item.permissions.allowMutatingCommands || item.permissions.allowExternalSend || item.permissions.approvedActions?.length || item.workspace?.mode !== "read-only")) {
      throw new Error("Generated workflows must explicitly remain read-only and report-only")
    }
  }
  return candidate
}

export async function readEvolutionCandidates(root: string, dataDir?: string) {
  const raw = await readEvolutionJSON(path.join(evolutionPaths(root, dataDir).projectDir, "candidates.json"))
  return raw === undefined ? [] : z.array(CandidateSchema).max(200).parse(raw)
}

export async function withEvolutionCandidates<T>(root: string, fn: (entries: EvolutionCandidate[]) => Promise<T>, dataDir?: string) {
  const paths = evolutionPaths(root, dataDir)
  return Flock.withLock(`evolution-candidates:${paths.projectDir}`, () => readEvolutionCandidates(root, dataDir).then(fn), { dir: path.join(paths.projectDir, ".locks"), timeoutMs: 5_000 })
}

export async function writeEvolutionCandidates(root: string, entries: EvolutionCandidate[], dataDir?: string) {
  if (entries.length > 200) throw new Error("Evolution candidate receipt capacity reached")
  await writeEvolutionJSON(path.join(evolutionPaths(root, dataDir).projectDir, "candidates.json"), entries)
}

export async function createEvolutionCandidate(root: string, input: CandidateInput, revision: string, dataDir?: string) {
  const value = validateEvolutionCandidate(input)
  if (value.kind === "memory") throw new Error("Memory candidates belong in the existing memory proposal store")
  const kind = value.kind
  return withEvolutionCandidates(root, async (entries) => {
    const policy = await readEvolutionPolicy(root, dataDir)
    const decision = authorizeEvolutionAction(policy, "propose", revision)
    if (!decision.allowed) throw new Error(decision.reason)
    const output = value.kind === "memory" ? "memory" : value.kind === "skill" ? "skills" : "workflows"
    if (!policy.config.outputs[output]) throw new Error("Candidate output disabled")
    const evidence = await listEvolutionEvidence(root, dataDir)
    if (!value.evidenceIDs.every((id) => evidence.some((item) => item.id === id && item.text && item.revision === revision))) throw new Error("Candidate evidence is missing or stale")
    const hash = evolutionHash(value)
    const duplicate = entries.find((item) => item.hash === hash)
    if (duplicate) return duplicate
    if (entries.filter((item) => item.status === "pending").length >= 100) throw new Error("Pending candidate capacity reached")
    const candidate: EvolutionCandidate = {
      ...value, kind, id: randomUUID(), revision, hash, createdAt: new Date().toISOString(),
      status: "pending", receipt: null,
    }
    await withEvolutionAction(root, "propose", revision, () => writeEvolutionCandidates(root, [...entries, candidate], dataDir), dataDir)
    return candidate
  }, dataDir)
}
