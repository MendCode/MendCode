import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import { readdirSync, readFileSync, rmSync } from "fs"
import path from "path"

import { ProjectTable } from "../../src/project/project.sql"
import { ProjectID as ProjectSchemaID } from "../../src/project/schema"
import {
  SessionTable,
  WorkflowArtifactTable,
  WorkflowDefinitionTable,
  WorkflowEventTable,
  WorkflowGateTable,
  WorkflowPhaseTable,
  WorkflowRevisionTable,
  WorkflowRunTable,
  WorkflowTaskAttemptTable,
  WorkflowTaskDependencyTable,
  WorkflowTaskTable,
} from "../../src/session/session.sql"
import {
  WorkflowArtifactID,
  WorkflowDefinitionID,
  WorkflowEventID,
  WorkflowGateID,
  WorkflowPhaseID,
  WorkflowRevisionID,
  WorkflowRunID,
  WorkflowTaskAttemptID,
  WorkflowTaskID,
} from "../../src/session/workflow"
import { SessionID } from "../../src/session/schema"
import type { WorkflowPlan } from "../../src/session/workflow-plan"

const projectID = ProjectSchemaID.global
const sessionID = SessionID.make("ses_workflow_origin")
const definitionID = WorkflowDefinitionID.make("definition")
const revisionID = WorkflowRevisionID.make("revision")
const runID = WorkflowRunID.make("run")
const phaseID = WorkflowPhaseID.make("phase")
const taskID = WorkflowTaskID.make("task")
const dependentTaskID = WorkflowTaskID.make("dependent-task")
const attemptID = WorkflowTaskAttemptID.make("attempt")
const artifactID = WorkflowArtifactID.make("artifact")
const eventID = WorkflowEventID.make("event")
const gateID = WorkflowGateID.make("gate")
const persistedPlan = {
  formatVersion: 1,
  name: "Persisted workflow",
  description: "A test workflow",
  objective: "Exercise persistence",
  phases: [],
  tasks: [],
  finalTaskID: taskID,
  completionCriteria: ["the row survives reopen"],
  requiredGates: [],
} as unknown as WorkflowPlan

const migrations = readdirSync(path.join(import.meta.dirname, "../../migration"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => ({
    sql: readFileSync(path.join(import.meta.dirname, "../../migration", entry.name, "migration.sql"), "utf8"),
    timestamp: Number(entry.name.split("_")[0]),
    name: entry.name,
  }))
  .sort((left, right) => left.timestamp - right.timestamp)

let databasePath: string | undefined
let sqlite: Database | undefined

afterEach(() => {
  sqlite?.close(false)
  sqlite = undefined
  if (databasePath) rmSync(databasePath, { force: true })
  databasePath = undefined
})

describe("workflow persistence schema", () => {
  test("persists independent runs and task graph links across reopen", () => {
    databasePath = path.join(import.meta.dir, `workflow-${Date.now()}.db`)
    sqlite = new Database(databasePath)
    sqlite.exec("PRAGMA foreign_keys = ON")
    const db = drizzle({ client: sqlite })
    migrate(db, migrations)

    db.insert(ProjectTable).values({
      id: projectID,
      worktree: "/tmp/workflow-project",
      name: "Workflow test project",
      sandboxes: [],
      time_created: 1,
      time_updated: 1,
    }).run()
    db.insert(SessionTable).values({
      id: sessionID,
      project_id: projectID,
      slug: "workflow-origin",
      directory: "/tmp/workflow-project",
      title: "Workflow origin",
      version: "test",
      time_created: 1,
      time_updated: 1,
    }).run()
    db.insert(WorkflowDefinitionTable).values({
      id: definitionID,
      project_id: projectID,
      name: "Persisted workflow",
      description: "A test workflow",
      source: "manual",
      saved: false,
      time_created: 1,
      time_updated: 1,
    }).run()
    db.insert(WorkflowRevisionTable).values({
      id: revisionID,
      definition_id: definitionID,
      revision: 1,
      plan_hash: "sha256:test",
      plan: persistedPlan,
      immutable: true,
      time_created: 1,
      time_updated: 1,
    }).run()
    db.insert(WorkflowRunTable).values({
      id: runID,
      definition_id: definitionID,
      revision_id: revisionID,
      revision: 1,
      origin_session_id: sessionID,
      state: "queued",
      data: {},
      time_created: 1,
      time_updated: 1,
    }).run()
    db.insert(WorkflowPhaseTable).values({
      run_id: runID,
      id: phaseID,
      ordinal: 1,
      name: "Research",
      state: "queued",
      barrier: { kind: "all" },
      time_created: 1,
      time_updated: 1,
    }).run()
    db.insert(WorkflowTaskTable).values({
      run_id: runID,
      id: taskID,
      phase_id: phaseID,
      name: "Research",
      kind: "agent",
      prompt: "Inspect the project",
      state: "pending",
      depends_on: [],
      output: { kind: "text" },
      time_created: 1,
      time_updated: 1,
    }).run()
    db.insert(WorkflowTaskTable).values({
      run_id: runID,
      id: dependentTaskID,
      phase_id: phaseID,
      name: "Dependent task",
      kind: "verify",
      prompt: "Verify the research",
      state: "pending",
      depends_on: [taskID],
      output: { kind: "text" },
      time_created: 1,
      time_updated: 1,
    }).run()
    db.insert(WorkflowTaskDependencyTable).values({
      run_id: runID,
      task_id: dependentTaskID,
      depends_on_task_id: taskID,
    }).run()
    db.insert(WorkflowTaskAttemptTable).values({
      id: attemptID,
      run_id: runID,
      task_id: taskID,
      attempt: 1,
      state: "queued",
      background_task_id: SessionID.make("ses_background_task"),
      background_generation: 1,
      time_created: 1,
      time_updated: 1,
    }).run()
    db.insert(WorkflowArtifactTable).values({
      id: artifactID,
      run_id: runID,
      task_id: taskID,
      attempt_id: attemptID,
      sequence: 1,
      kind: "summary",
      summary: "bounded",
      status: "valid",
      schema_validated: true,
      output_refs: [],
      evidence: [],
      time_created: 1,
      time_updated: 1,
    }).run()
    db.insert(WorkflowEventTable).values({
      id: eventID,
      run_id: runID,
      sequence: 1,
      level: "info",
      type: "workflow.run.created",
      title: "Created",
      summary: "Workflow queued",
      time_created: 1,
      time_updated: 1,
    }).run()
    db.insert(WorkflowGateTable).values({
      run_id: runID,
      id: gateID,
      state: "pending",
      required: true,
      time_created: 1,
      time_updated: 1,
    }).run()

    expect(db.select().from(WorkflowRunTable).all()).toHaveLength(1)
    expect(db.select().from(WorkflowTaskAttemptTable).all()[0]?.background_generation).toBe(1)
    expect(db.select().from(WorkflowTaskDependencyTable).all()).toHaveLength(1)
    expect(db.select().from(WorkflowArtifactTable).all()).toHaveLength(1)
    expect(db.select().from(WorkflowEventTable).all()).toHaveLength(1)
    expect(db.select().from(WorkflowGateTable).all()).toHaveLength(1)

    sqlite.close(false)
    sqlite = new Database(databasePath)
    sqlite.exec("PRAGMA foreign_keys = ON")
    const reopened = drizzle({ client: sqlite })
    migrate(reopened, migrations)
    const persistedRun = reopened.select().from(WorkflowRunTable).get()
    expect(persistedRun?.state).toBe("queued")
    expect(persistedRun?.loop_id).toBeNull()
    expect(reopened.select().from(WorkflowTaskTable).all()).toHaveLength(2)

    sqlite.exec("DELETE FROM session")
    const detachedRun = reopened.select().from(WorkflowRunTable).get()
    expect(detachedRun?.origin_session_id).toBeNull()
    expect(reopened.select().from(WorkflowDefinitionTable).all()).toHaveLength(1)
  })

  test("keeps loop linkage optional and exposes lease/adapter columns", () => {
    databasePath = path.join(import.meta.dir, `workflow-columns-${Date.now()}.db`)
    sqlite = new Database(databasePath)
    sqlite.exec("PRAGMA foreign_keys = ON")
    const db = drizzle({ client: sqlite })
    migrate(db, migrations)

    const columns = sqlite.query("PRAGMA table_info(workflow_run)").all() as Array<{ name: string }>
    const columnNames = columns.map((column) => column.name)
    expect(columnNames).toEqual(expect.arrayContaining(["loop_id", "loop_run_id", "lease_expires_at"]))
    const attemptColumns = sqlite.query("PRAGMA table_info(workflow_task_attempt)").all() as Array<{ name: string }>
    expect(attemptColumns.map((column) => column.name)).toContain("background_generation")
  })
})
