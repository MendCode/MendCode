import { describe, expect, test } from "bun:test"
import { spawnSync } from "child_process"
import { rm } from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import {
  buildWorktreePreview,
  createWorktreeRecord,
  finishWorktreeOperation,
  readWorktreeState,
  reconcileWorktreeState,
  renderWorktreePreview,
  saveWorktreeRecord,
  startWorktreeOperation,
  worktreeStatePath,
  planNativeWorktreeCreate,
} from "../../src/mend/worktree"
import { worktreeAdopt, worktreeCreate, worktreeOpen, worktreeRemove, worktreeReset, worktreeStatus } from "../../src/mend/config/worktree"

function passport(root: string, overrides: Partial<Parameters<typeof createWorktreeRecord>[0]> = {}) {
  const now = "2026-06-12T12:00:00.000Z"
  return createWorktreeRecord({
    creator: "mendcode",
    repoRoot: root,
    path: path.join(root, ".mendcode", "worktree", "demo"),
    branch: "mend/demo",
    baseRef: "main",
    executor: "native",
    sessions: [],
    packages: [{ id: "base", version: "1.0.0" }],
    mflowMode: "off",
    creationPlan: {
      commands: ["git worktree add --no-checkout -b mend/demo .mendcode/worktree/demo"],
      writes: [".mendcode/worktree/state.json"],
    },
    cleanupPolicy: "remove-when-clean",
    now,
    ...overrides,
  })
}

describe("Mend worktree manager contracts", () => {
  test("stores passport state outside package overlays", async () => {
    await using dir = await tmpdir()
    const record = passport(dir.path)

    await saveWorktreeRecord(record, dir.path)
    const state = await readWorktreeState(dir.path)

    expect(worktreeStatePath(dir.path)).toBe(path.join(dir.path, ".mendcode", "worktree", "state.json"))
    expect(state.worktrees[record.id]).toMatchObject({
      ownership: "owned",
      creator: "mendcode",
      repoRoot: dir.path,
      branch: "mend/demo",
      executor: "native",
      cleanupPolicy: "remove-when-clean",
    })
    expect(state.worktrees[record.id]?.packages).toEqual([{ id: "base", version: "1.0.0" }])
  })

  test("reconciliation classifies external, stale, and drifted worktrees", async () => {
    await using dir = await tmpdir()
    const owned = passport(dir.path)
    const missing = passport(dir.path, { id: "missing", path: path.join(dir.path, "missing") })
    const changed = passport(dir.path, { id: "changed", path: path.join(dir.path, "changed"), branch: "mend/old" })
    const state = await readWorktreeState(dir.path)
    state.worktrees[owned.id] = owned
    state.worktrees[missing.id] = missing
    state.worktrees[changed.id] = changed

    const result = reconcileWorktreeState(state, [
      { path: owned.path, branch: owned.branch },
      { path: changed.path, branch: "mend/new" },
      { path: path.join(dir.path, "external"), branch: "feature/external" },
    ], "2026-06-12T12:01:00.000Z")

    expect(result.external).toEqual([{ path: path.join(dir.path, "external"), branch: "feature/external" }])
    expect(result.stale.map((item) => item.id)).toEqual(["missing"])
    expect(result.drifted.map((item) => item.id)).toEqual(["changed"])
    expect(result.drifted[0]?.drift[0]).toContain("registry=mend/old git=mend/new")
  })

  test("destructive preview blocks external and dirty targets", async () => {
    await using dir = await tmpdir()
    const record = passport(dir.path, {
      ownership: "external",
      dirty: {
        checkedAt: "2026-06-12T12:00:00.000Z",
        clean: false,
        summary: "M file.ts",
      },
    })

    const preview = buildWorktreePreview({
      action: "remove",
      record,
      root: dir.path,
      commands: [{ tool: "git", argv: ["worktree", "remove", "--force", record.path], cwd: dir.path, destructive: true }],
    })
    const text = renderWorktreePreview(preview)

    expect(preview.blocked).toBe(true)
    expect(preview.blockReasons).toContain("target is external; adopt it before destructive actions")
    expect(preview.blockReasons).toContain("target is dirty: M file.ts")
    expect(preview.forceConfirmation).toBe(record.path)
    expect(text).toContain("Ownership: external")
    expect(text).toContain("git worktree remove --force")
  })

  test("operation journal records pending and recovery states", async () => {
    await using dir = await tmpdir()
    const record = passport(dir.path)
    const preview = buildWorktreePreview({ action: "reset", record, root: dir.path })

    const pending = await startWorktreeOperation("reset", record.path, preview, dir.path)
    const recovered = await finishWorktreeOperation(pending.id, "needs_recovery", {
      error: "git reset failed",
      recovery: ["inspect worktree before retry"],
    }, dir.path)
    const state = await readWorktreeState(dir.path)

    expect(pending.status).toBe("pending")
    expect(recovered.status).toBe("needs_recovery")
    expect(recovered.error).toBe("git reset failed")
    expect(state.operations[pending.id]?.recovery).toEqual(["inspect worktree before retry"])
  })

  test("native create planner produces a non-executing preview", async () => {
    await using dir = await tmpdir({ git: true })

    const { record, preview } = planNativeWorktreeCreate({
      repoRoot: dir.path,
      name: "Feature One",
      branchPrefix: "mend/",
      baseRef: "main",
    })

    expect(record.branch).toBe("mend/feature-one")
    expect(record.cleanupPolicy).toBe("remove-when-clean")
    expect(preview.action).toBe("create")
    expect(preview.blocked).toBe(false)
    expect(preview.commands[0]).toMatchObject({ tool: "git", destructive: false })
  })

  test("worktree status reports git entries as external until adopted", async () => {
    await using dir = await tmpdir({ git: true })

    const status = await worktreeStatus(dir.path)

    expect(status.git.ok).toBe(true)
    expect(status.git.entries[0]?.path).toBe(dir.path)
    expect(status.registry.records).toEqual([])
    expect(status.registry.external[0]?.path).toBe(dir.path)
  })

  test("worktree commands expose preview-first gates", async () => {
    await using dir = await tmpdir({ git: true })

    const created = await worktreeCreate(["demo"], dir.path)
    const openedExternal = await worktreeOpen([dir.path], dir.path)
    const removeExternal = await worktreeRemove([dir.path], dir.path)
    const adopted = await worktreeAdopt([dir.path], dir.path)
    const openedOwned = await worktreeOpen([adopted.record.id], dir.path)
    const resetOwned = await worktreeReset([adopted.record.id], dir.path)

    expect(created.executesGit).toBe(false)
    expect(created.preview.action).toBe("create")
    expect(openedExternal.ownership).toBe("external")
    expect(removeExternal.preview.blocked).toBe(true)
    expect(removeExternal.preview.blockReasons[0]).toContain("external")
    expect(adopted.executesGit).toBe(false)
    expect(openedOwned.ownership).toBe("adopted")
    expect(resetOwned.preview.forceConfirmation).toBe(dir.path)
  })

  test("linked worktrees share the base registry state", async () => {
    await using dir = await tmpdir({ git: true })
    const linked = path.resolve(dir.path, "..", "linked-worktree")
    const add = spawnSync("git", ["worktree", "add", "-b", "mend/linked", linked, "HEAD"], {
      cwd: dir.path,
      encoding: "utf8",
    })
    try {
      expect(add.status).toBe(0)

      const adopted = await worktreeAdopt([linked], dir.path)
      const fromLinked = await worktreeStatus(linked)

      expect(fromLinked.workspace.isLinkedWorktree).toBe(true)
      expect(fromLinked.workspace.repoRoot).toBe(dir.path)
      expect(fromLinked.workspace.currentPath).toBe(linked)
      expect(fromLinked.registry.records.map((record) => record.id)).toContain(adopted.record.id)
    } finally {
      spawnSync("git", ["worktree", "remove", "--force", linked], { cwd: dir.path, encoding: "utf8" })
      await rm(linked, { recursive: true, force: true })
    }
  })
})
