import { createHash } from "node:crypto"
import type { Database } from "bun:sqlite"
import type { LedgerCategory, LedgerEntry, LedgerPage, LedgerQuery, LedgerScope, Loop, WorkflowRetention, WorkflowRun } from "@mendcode/protocol"

export const LEDGER_RUN_LIMIT = 50
export const LEDGER_ENTRY_LIMIT = 512
const MAX_DATA_BYTES = 64 * 1024
type Draft = Omit<LedgerEntry, "sequence">
type Head = { sequence: number; truncated: number; historical: number }

/** Evidence is committed with its projection. No transcript scan, network, file outputs or timers. */
export function createAutomationLedger(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS automation_ledger_heads (
      scope TEXT NOT NULL, owner TEXT NOT NULL, sequence INTEGER NOT NULL DEFAULT 0,
      truncated INTEGER NOT NULL DEFAULT 0, historical INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY(scope, owner)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS automation_ledger (
      scope TEXT NOT NULL, owner TEXT NOT NULL, sequence INTEGER NOT NULL, run INTEGER NOT NULL,
      category TEXT NOT NULL, evidence_key TEXT NOT NULL, hash TEXT NOT NULL, payload TEXT NOT NULL,
      PRIMARY KEY(scope, owner, sequence)
    ) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS automation_ledger_run ON automation_ledger(scope, owner, run, sequence DESC);
    CREATE TABLE IF NOT EXISTS automation_ledger_seen (
      scope TEXT NOT NULL, owner TEXT NOT NULL, run INTEGER NOT NULL, evidence_key TEXT NOT NULL, hash TEXT NOT NULL,
      PRIMARY KEY(scope, owner, run, evidence_key)
    ) WITHOUT ROWID;
  `)

  function append(scope: LedgerScope, owner: string, key: string, draft: Draft) {
    const identity = JSON.stringify({ ...draft, at: undefined })
    const hash = createHash("sha256").update(identity).digest("hex")
    // The last hash written per key survives retention, so evidence a plan's retention dropped is not written again.
    const previous = db.query<{ hash: string }, [string, string, number, string]>("SELECT hash FROM automation_ledger_seen WHERE scope = ? AND owner = ? AND run = ? AND evidence_key = ?").get(scope, owner, draft.run, key)
      ?? db.query<{ hash: string }, [string, string, number, string]>("SELECT hash FROM automation_ledger WHERE scope = ? AND owner = ? AND run = ? AND evidence_key = ? ORDER BY sequence DESC LIMIT 1").get(scope, owner, draft.run, key)
    if (previous?.hash === hash) return
    db.query("INSERT INTO automation_ledger_seen VALUES (?, ?, ?, ?, ?) ON CONFLICT(scope, owner, run, evidence_key) DO UPDATE SET hash = excluded.hash").run(scope, owner, draft.run, key, hash)
    const head = db.query<Head, [string, string]>("SELECT * FROM automation_ledger_heads WHERE scope = ? AND owner = ?").get(scope, owner)!
    const entry: LedgerEntry = { ...draft, sequence: head.sequence + 1 }
    if (Buffer.byteLength(JSON.stringify(entry.data)) > MAX_DATA_BYTES) {
      // Large fields retain an explicit digest/size instead of a silently incomplete JSON object.
      entry.data = { omitted: true, bytes: Buffer.byteLength(JSON.stringify(draft.data)), sha256: createHash("sha256").update(JSON.stringify(draft.data)).digest("hex") }
    }
    db.query("INSERT INTO automation_ledger VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(scope, owner, entry.sequence, entry.run, entry.category, key, hash, JSON.stringify(entry))
    db.query("UPDATE automation_ledger_heads SET sequence = ? WHERE scope = ? AND owner = ?").run(entry.sequence, scope, owner)
  }

  /**
   * A plan's own retention (workflows): entries older than `maxAgeMs`, artifacts beyond the newest `maxArtifacts`, and the oldest
   * events then artifacts while the total exceeds `maxBytes`. The completion receipt is never dropped. Returns how many were dropped.
   */
  function enforceRetention(scope: LedgerScope, owner: string, retention: WorkflowRetention, now: number) {
    const rows = db.query<{ sequence: number; category: string; payload: string }, [string, string]>("SELECT sequence, category, payload FROM automation_ledger WHERE scope = ? AND owner = ? ORDER BY sequence").all(scope, owner)
    const entries = rows.map((row) => ({ sequence: row.sequence, category: row.category, bytes: Buffer.byteLength(row.payload), at: (JSON.parse(row.payload) as LedgerEntry).at }))
    const drop = new Set<number>()
    if (retention.maxAgeMs !== undefined) for (const entry of entries) if (entry.category !== "receipt" && now - entry.at > retention.maxAgeMs) drop.add(entry.sequence)
    if (retention.maxArtifacts !== undefined) {
      const artifacts = entries.filter((entry) => entry.category === "artifact" && !drop.has(entry.sequence))
      for (const entry of artifacts.slice(0, Math.max(0, artifacts.length - retention.maxArtifacts))) drop.add(entry.sequence)
    }
    if (retention.maxBytes !== undefined) {
      let total = entries.filter((entry) => !drop.has(entry.sequence)).reduce((sum, entry) => sum + entry.bytes, 0)
      for (const entry of [...entries.filter((candidate) => candidate.category === "event"), ...entries.filter((candidate) => candidate.category === "artifact")]) {
        if (total <= retention.maxBytes) break
        if (drop.has(entry.sequence)) continue
        drop.add(entry.sequence)
        total -= entry.bytes
      }
    }
    for (const sequence of drop) db.query("DELETE FROM automation_ledger WHERE scope = ? AND owner = ? AND sequence = ?").run(scope, owner, sequence)
    return drop.size
  }

  function record(scope: LedgerScope, owner: string, drafts: Array<{ key: string; entry: Draft }>, historical = true, retention?: { policy: WorkflowRetention; now: number }) {
    db.query("INSERT OR IGNORE INTO automation_ledger_heads(scope, owner, historical) VALUES (?, ?, ?)").run(scope, owner, historical ? 1 : 0)
    for (const { key, entry } of drafts) append(scope, owner, key, entry)
    const droppedByPlan = retention ? enforceRetention(scope, owner, retention.policy, retention.now) : 0
    // Runs with late audit/review evidence keep their run number; latest 50 wakeups are retained.
    const droppedRuns = db.query("DELETE FROM automation_ledger WHERE scope = ? AND owner = ? AND run NOT IN (SELECT DISTINCT run FROM automation_ledger WHERE scope = ? AND owner = ? ORDER BY run DESC LIMIT ?)").run(scope, owner, scope, owner, LEDGER_RUN_LIMIT).changes
    let droppedEntries = 0
    for (const { run } of db.query<{ run: number }, [string, string]>("SELECT DISTINCT run FROM automation_ledger WHERE scope = ? AND owner = ?").all(scope, owner)) {
      const count = db.query<{ n: number }, [string, string, number]>("SELECT COUNT(*) AS n FROM automation_ledger WHERE scope = ? AND owner = ? AND run = ?").get(scope, owner, run)!.n
      if (count <= LEDGER_ENTRY_LIMIT) continue
      // Protect the latest artifact/receipt for each key, including failed gates and overrides.
      droppedEntries += db.query(`DELETE FROM automation_ledger WHERE scope = ? AND owner = ? AND sequence IN (
        SELECT sequence FROM automation_ledger AS old WHERE scope = ? AND owner = ? AND run = ?
        AND (category = 'event' OR sequence < (SELECT MAX(sequence) FROM automation_ledger AS newer
          WHERE newer.scope = old.scope AND newer.owner = old.owner AND newer.run = old.run AND newer.evidence_key = old.evidence_key))
        ORDER BY sequence LIMIT ?
      )`).run(scope, owner, scope, owner, run, count - LEDGER_ENTRY_LIMIT).changes
    }
    if (droppedRuns + droppedEntries + droppedByPlan) db.query("UPDATE automation_ledger_heads SET truncated = 1 WHERE scope = ? AND owner = ?").run(scope, owner)
  }

  function workflow(run: WorkflowRun, before?: WorkflowRun, historical = true) {
    const drafts: Array<{ key: string; entry: Draft }> = []
    const add = (category: LedgerCategory, kind: string, title: string, summary: string, data: Record<string, unknown>, extra: Partial<Draft> = {}, key = kind) => drafts.push({ key, entry: { run: 0, category, kind, title, summary: summary.slice(0, 2_000), at: run.updatedAt, data, ...extra } })
    if (!before || before.state !== run.state) add("event", `workflow.${run.state}`, run.name, run.reason ?? run.state, { state: run.state, planHash: run.planHash }, {}, "workflow-state")
    if (before && (before.permissionMode !== run.permissionMode || before.sessionPermission !== run.sessionPermission)) add("event", "workflow.permissions", "Workflow permission settings changed", run.permissionReason ?? `policy ${run.permissionMode ?? "inherited"} · session ${run.sessionPermission ?? "inherited"}`, { permissionMode: run.permissionMode, sessionPermission: run.sessionPermission }, {}, "workflow-permissions")
    if (!before) {
      const { tasks, ...plan } = run.plan
      add("artifact", "plan", "Frozen plan", run.objective, { plan, taskIds: tasks.map((task) => task.id), planHash: run.planHash, permission: run.permission })
      for (const task of tasks) add("artifact", "task-spec", task.title, task.kind === "agent" || task.kind === "human" ? task.prompt : task.kind === "check" ? task.command : task.map.taskTemplate.prompt, { ...task }, { taskId: task.id }, `task-spec:${task.id}`)
    }
    for (const task of run.tasks) {
      const old = before?.tasks.find((entry) => entry.id === task.id)
      const extra = { taskId: task.id, ...(task.sessionId ? { sessionId: task.sessionId } : {}) }
      if (!old || old.state !== task.state || old.attempt !== task.attempt) add("event", `task.${task.state}`, task.title, task.reason ?? `${task.id} · attempt ${task.attempt}`, { state: task.state, attempt: task.attempt }, extra, `task-state:${task.id}`)
      if (task.result !== undefined || task.reason !== undefined) add("artifact", "task-result", task.title, task.result ?? task.reason!, { state: task.state, attempt: task.attempt, result: task.result, reason: task.reason }, extra, `task-result:${task.id}:${task.attempt}`)
      if (task.output) add("artifact", "task-output", task.title, `${task.output.kind} output`, { ...task.output, attempt: task.attempt }, extra, `task-output:${task.id}:${task.attempt}`)
    }
    for (const round of run.verifications) {
      const { gates: _gates, audit: _audit, ...verification } = round
      add("artifact", "verification", `Verification ${round.round}`, round.accepted ? "accepted" : "rejected", { ...verification }, { at: round.at }, `verification:${round.round}`)
      for (const gate of round.gates) add("artifact", "gate", gate.id, gate.detail ?? gate.status, { ...gate, round: round.round }, { at: round.at }, `gate:${round.round}:${gate.id}`)
      if (round.audit) add("artifact", "judgment", `Audit ${round.round}`, round.audit.findings, { ...round.audit, round: round.round }, { at: round.at, sessionId: round.audit.sessionId }, `audit:${round.round}`)
    }
    if (run.override) add("artifact", "override", "User acceptance", run.override.reason, { ...run.override }, { at: run.override.at })
    const last = run.verifications.at(-1)
    if (!before || before.state !== run.state || before.tasks.filter((task) => task.state === "done").length !== run.tasks.filter((task) => task.state === "done").length || before.verifications.length !== run.verifications.length || JSON.stringify(before.override) !== JSON.stringify(run.override)) {
      add("receipt", "completion", run.name, run.reason ?? run.state, {
        state: run.state, planHash: run.planHash, done: run.tasks.filter((task) => task.state === "done").length, total: run.tasks.length,
        verification: last ? { round: last.round, at: last.at, accepted: last.accepted, criteria: last.criteria } : undefined, override: run.override, verified: !run.override && last?.accepted === true,
        startedAt: run.startedAt, endedAt: run.endedAt,
      })
    }
    record("workflow", run.workflowId, drafts, historical, run.plan.retention ? { policy: run.plan.retention, now: run.updatedAt } : undefined)
  }

  function loop(loop: Loop, before?: Loop, historical = true) {
    const drafts: Array<{ key: string; entry: Draft }> = []
    const add = (run: number, category: LedgerCategory, kind: string, title: string, summary: string, data: Record<string, unknown>, at = loop.updatedAt, key = kind, sessionId?: string) => drafts.push({ key, entry: { run, category, kind, title, summary: summary.slice(0, 2_000), data, at, ...(sessionId ? { sessionId } : {}) } })
    if (!before || before.state !== loop.state) add(loop.runs, "event", `loop.${loop.state}`, loop.name, loop.reason ?? loop.state, { state: loop.state }, loop.updatedAt, "loop-state")
    for (const run of loop.history) {
      const old = before?.history.find((entry) => entry.run === run.run)
      const session = run.sessionId ?? loop.sessionId
      if (!old) add(run.run, "event", "run.started", `Run ${run.run}`, run.trigger ?? "schedule", { startedAt: run.startedAt, trigger: run.trigger }, run.startedAt, "run.started", session)
      if (run.endedAt !== undefined && old?.endedAt === undefined) add(run.run, "event", "run.ended", `Run ${run.run}`, run.outcome ?? "unknown", { endedAt: run.endedAt, outcome: run.outcome }, run.endedAt, "run.ended", session)
      if (run.checkpoint) {
        add(run.run, "artifact", "checkpoint", "Loop checkpoint", run.checkpoint.summary, { ...run.checkpoint, checkpointHash: run.checkpointHash }, run.endedAt, "checkpoint", session)
        add(run.run, "artifact", "memory", "Run memory", run.checkpoint.next ?? run.checkpoint.summary, { summary: run.checkpoint.summary, next: run.checkpoint.next, source: "checkpoint" }, run.endedAt, "memory", session)
      }
      if (run.usage) add(run.run, "artifact", "cost", "Usage ledger", `${run.usage.tokens} tokens · ${run.usage.unknownCostCalls ? "cost unknown" : `$${(run.usage.costMicros / 1_000_000).toFixed(6)}`}`, { ...run.usage }, loop.updatedAt, "cost", session)
      if (run.audit) add(run.run, "artifact", "judgment", "Independent audit", run.audit.findings, { ...run.audit }, loop.updatedAt, "judgment", run.audit.sessionId)
      for (const gate of run.gates ?? []) add(run.run, "artifact", "gate", gate.id, gate.detail ?? gate.status, { ...gate }, loop.updatedAt, `gate:${gate.id}`, session)
      if (run.rubricResult) add(run.run, "artifact", "rubric", "Runtime rubric", run.rubricResult.status, { ...run.rubricResult })
      if (run.approvals?.length) add(run.run, "artifact", "approval", "Action approvals", run.approvals.map((approval) => approval.action).join(", "), { approvals: run.approvals })
      if (run.worktree) add(run.run, "artifact", "worktree", run.worktree.branch, run.worktree.detail ?? run.worktree.state, { ...run.worktree })
      if (run.endedAt !== undefined && (!old || JSON.stringify(old) !== JSON.stringify(run) || before?.state !== loop.state || before?.reviewInvalidatedAt !== loop.reviewInvalidatedAt || JSON.stringify(before?.override) !== JSON.stringify(loop.override))) {
        const gates = run.gates ?? []
        add(run.run, "receipt", "completion", `Run ${run.run}`, run.checkpoint?.summary ?? run.outcome ?? "unknown", {
          state: run.run === loop.runs ? loop.state : run.outcome, checkpoint: run.checkpoint, checkpointHash: run.checkpointHash,
          gates, audit: run.audit, rubric: run.rubricResult, usage: run.usage, override: run.run === loop.runs ? loop.override : undefined,
          reviewInvalidatedAt: loop.reviewInvalidatedAt,
          verified: run.checkpoint?.status === "complete" && loop.state === "completed" && !loop.override && loop.reviewInvalidatedAt === undefined && gates.every((gate) => gate.status === "pass" && !gate.waiver) && (gates.length > 0 || run.audit?.verdict === "pass") && (!run.audit || run.audit.verdict === "pass" && !run.audit.workspaceChanged),
          startedAt: run.startedAt, endedAt: run.endedAt,
        })
      }
    }
    if (loop.override) add(loop.runs, "artifact", "override", "User acceptance", loop.override.reason, { ...loop.override }, loop.override.at)
    record("loop", loop.loopId, drafts, historical)
  }

  function page(scope: LedgerScope, ownerId: string, category?: LedgerCategory, query: LedgerQuery = {}): LedgerPage {
    const params: Array<string | number> = [scope, ownerId]
    let where = "scope = ? AND owner = ?"
    if (category) { where += " AND category = ?"; params.push(category) }
    if (query.run !== undefined) { where += " AND run = ?"; params.push(query.run) }
    const retained = db.query<{ n: number }, Array<string | number>>(`SELECT COUNT(*) AS n FROM automation_ledger WHERE ${where}`).get(...params)!.n
    if (query.before !== undefined) { where += " AND sequence < ?"; params.push(query.before) }
    const limit = Math.max(1, Math.min(100, query.limit ?? 50))
    const rows = db.query<{ payload: string }, Array<string | number>>(`SELECT payload FROM automation_ledger WHERE ${where} ORDER BY sequence DESC LIMIT ?`).all(...params, limit + 1)
    const entries: LedgerEntry[] = []
    let bytes = 0
    for (const row of rows.slice(0, limit)) {
      if (entries.length && bytes + Buffer.byteLength(row.payload) > 72 * 1024) break
      bytes += Buffer.byteLength(row.payload)
      entries.push(JSON.parse(row.payload) as LedgerEntry)
    }
    const head = db.query<Head, [string, string]>("SELECT * FROM automation_ledger_heads WHERE scope = ? AND owner = ?").get(scope, ownerId)
    return { scope, ownerId, entries, ...(rows.length > entries.length ? { nextBefore: entries.at(-1)!.sequence } : {}), retained, latestSequence: head?.sequence ?? 0, truncated: !!head?.truncated, historical: !!head?.historical }
  }

  function remove(scope: LedgerScope, owner: string) {
    db.query("DELETE FROM automation_ledger WHERE scope = ? AND owner = ?").run(scope, owner)
    db.query("DELETE FROM automation_ledger_heads WHERE scope = ? AND owner = ?").run(scope, owner)
    db.query("DELETE FROM automation_ledger_seen WHERE scope = ? AND owner = ?").run(scope, owner)
  }
  function cleanWorkflows() {
    db.exec("DELETE FROM automation_ledger_seen WHERE scope = 'workflow' AND owner NOT IN (SELECT id FROM workflows)")
    db.exec("DELETE FROM automation_ledger WHERE scope = 'workflow' AND owner NOT IN (SELECT id FROM workflows)")
    db.exec("DELETE FROM automation_ledger_heads WHERE scope = 'workflow' AND owner NOT IN (SELECT id FROM workflows)")
  }
  const known = (scope: LedgerScope, owner: string) => db.query("SELECT 1 FROM automation_ledger_heads WHERE scope = ? AND owner = ?").get(scope, owner) !== null
  return { workflow, loop, page, remove, cleanWorkflows, known }
}
