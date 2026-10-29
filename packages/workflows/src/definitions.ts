import { createHash, randomUUID } from "node:crypto"
import { WorkflowDefinition, WorkflowRevision, type WorkflowPlan, type WorkflowRevisionReceipt } from "@mendcode/protocol"
import { validatePlan } from "./plan"

export interface WorkflowDefinitionsPort {
  list(directory: string, limit: number): WorkflowDefinition[]
  definition(definitionId: string): WorkflowDefinition | undefined
  revision(revisionId: string): WorkflowRevision | undefined
  save(definition: WorkflowDefinition, revision: WorkflowRevision): void
}

/** Canonical key order; task/dependency order remains meaningful. */
export function workflowPlanHash(plan: WorkflowPlan): string {
  const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, canonical(entry)]))
    : value
  return createHash("sha256").update(JSON.stringify(canonical(plan))).digest("hex")
}

export function createWorkflowDefinitions(options: { store: WorkflowDefinitionsPort; now(): number }) {
  const { store } = options
  function get(directory: string, ref: { definitionId: string } | { revisionId: string }): WorkflowRevisionReceipt {
    const definition = "definitionId" in ref ? store.definition(ref.definitionId) : undefined
    const revision = store.revision("revisionId" in ref ? ref.revisionId : definition?.currentRevisionId ?? "")
    const owner = revision ? store.definition(revision.definitionId) : undefined
    if (!revision || !owner || owner.directory !== directory) throw new RangeError("unknown workflow revision in this project")
    if (typeof revision.plan.contract === "string" || workflowPlanHash(revision.plan) !== revision.planHash) throw new RangeError("workflow revision failed integrity check")
    return structuredClone({ ...revision, definition: owner })
  }
  return {
    list: (directory: string, limit = 50) => store.list(directory, Math.max(1, Math.min(100, limit))),
    get,
    save(input: { directory: string; plan: WorkflowPlan; definitionId?: string | undefined; name?: string | undefined; description?: string | undefined; source?: WorkflowDefinition["source"] | undefined; saved?: boolean | undefined; ownerSessionId?: WorkflowDefinition["ownerSessionId"] | undefined; restPlan?: Record<string, unknown> | undefined }): WorkflowRevisionReceipt {
      const checked = validatePlan(input.plan)
      if (!checked.ok) throw new RangeError(checked.problems.join("; "))
      if (typeof checked.plan.contract === "string") throw new RangeError("resolve the contract before saving")
      const current = input.definitionId ? store.definition(input.definitionId) : undefined
      if (input.definitionId && (!current || current.directory !== input.directory)) throw new RangeError("unknown workflow definition in this project")
      const at = options.now()
      const definitionId = current?.definitionId ?? `wfd_${randomUUID()}`
      const revisionId = `wfr_${randomUUID()}`
      const revision = (current?.currentRevision ?? 0) + 1
      const definition = WorkflowDefinition.parse({
        definitionId, directory: input.directory, name: input.name ?? current?.name ?? checked.plan.name,
        description: input.description ?? current?.description ?? "", source: current?.source ?? input.source ?? "manual",
        saved: input.saved ?? current?.saved ?? true, currentRevision: revision, currentRevisionId: revisionId,
        createdAt: current?.createdAt ?? at, updatedAt: at,
        ownerSessionId: input.ownerSessionId ?? current?.ownerSessionId,
      })
      const frozen = WorkflowRevision.parse({ definitionId, revisionId, revision, plan: checked.plan, planHash: workflowPlanHash(checked.plan), immutable: true, createdAt: at, ...(input.restPlan ? { restPlan: input.restPlan } : {}) })
      store.save(definition, frozen)
      return structuredClone({ ...frozen, definition })
    },
  }
}
