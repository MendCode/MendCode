import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { WorktreeReport } from "@mendcode/protocol"
import { createWorktreeManager } from "../src/worktrees"
import { boot, openSession } from "./native-harness"

const temporary: string[] = []
afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }) })
async function git(directory: string, ...argv: string[]) {
  const child = Bun.spawn(["git", "--no-optional-locks", "-c", "core.hooksPath=/dev/null", "-c", "user.name=B30 Test", "-c", "user.email=b30@example.invalid", "-c", "commit.gpgsign=false", "-C", directory, ...argv], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" } })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(`Git fixture failed: ${argv.join(" ")}\n${stderr}`)
  return stdout.trimEnd()
}
async function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "mendcode-b30-")))
  temporary.push(root)
  const project = path.join(root, "project"), linked = path.join(root, "linked"), dir = path.join(root, "data")
  mkdirSync(project)
  await git(project, "init", "-b", "main")
  writeFileSync(path.join(project, "tracked.txt"), "base\n")
  await git(project, "add", "tracked.txt")
  await git(project, "commit", "-m", "fixture")
  await git(project, "worktree", "add", "-b", "mend/linked", linked)
  return { root, project, linked, dir, manager: createWorktreeManager({ dir }) }
}

describe("B30 native worktree manager", () => {
  test("status reads Git and shares repository identity from linked checkouts and subdirectories", async () => {
    const harness = await fixture()
    const base = await harness.manager.query(harness.project, { operation: "status" })
    const linked = await harness.manager.query(harness.linked, { operation: "status" })
    const sub = path.join(harness.project, "nested")
    mkdirSync(sub)
    const nested = await harness.manager.query(sub, { operation: "status" })
    expect(WorktreeReport.safeParse(base).success).toBe(true)
    expect(base.records).toHaveLength(2)
    expect(base.records.every((record) => record.ownership === "external" && record.dirty.clean)).toBe(true)
    expect(linked.registryPath).toBe(base.registryPath)
    expect(linked.workspace).toMatchObject({ repoRoot: harness.project, isLinkedWorktree: true })
    expect(nested.workspace.isLinkedWorktree).toBe(false)
    expect(existsSync(base.registryPath)).toBe(false)
  })
  test("repository roots do not assume the common Git directory lives under .git", async () => {
    const harness = await fixture()
    const alternate = path.join(harness.root, "alternate"), metadata = path.join(harness.root, "metadata")
    mkdirSync(alternate)
    await git(alternate, "init", "-b", "main", `--separate-git-dir=${metadata}`)
    expect((await harness.manager.query(alternate, { operation: "status" })).workspace.repoRoot).toBe(alternate)
  })
  test("plan/create persist only previews, preserve flags and serialize concurrent writes", async () => {
    const harness = await fixture()
    const before = await git(harness.project, "worktree", "list", "--porcelain")
    await Promise.all([harness.manager.change(harness.project, { operation: "plan", input: { name: "Client", branch: "mend/client", base: "main", focus: "claude" } }), harness.manager.change(harness.project, { operation: "create", input: { name: "Daemon" } })])
    const report = await harness.manager.query(harness.project, { operation: "status" })
    expect(report.plans.map((plan) => plan.id)).toEqual(["Client", "Daemon"])
    expect(report.plans[0]?.preview.commands[0]?.argv).toContain("main")
    expect(report.plans[0]?.focus).toBe("claude")
    expect(report.plans[1]?.focus).toBe("auto")
    expect(report.plans.every((plan) => !existsSync(plan.preview.target.path) && !plan.preview.executesGit)).toBe(true)
    expect(await git(harness.project, "worktree", "list", "--porcelain")).toBe(before)
    expect(await git(harness.project, "branch", "--list", "mend/client", "mend/daemon")).toBe("")
  })
  test("create validation rejects occupied paths, branches, invalid base and unknown focus without writes", async () => {
    const harness = await fixture()
    for (const input of [{ name: "bad", path: harness.project }, { name: "bad", branch: "main" }, { name: "bad", branch: "-bad" }, { name: "bad", base: "missing" }, { name: "bad", focus: "missing" }]) {
      const report = await harness.manager.change(harness.project, { operation: "create", input })
      expect(report.ok).toBe(false)
      expect(report.preview?.blocked).toBe(true)
      expect(existsSync(report.registryPath)).toBe(false)
    }
    await expect(harness.manager.change(harness.project, { operation: "plan", input: { name: ".." } })).rejects.toThrow("Invalid worktree name")
  })
  test("adopt persists ownership idempotently; open resolves branch, id and relative path without launch", async () => {
    const harness = await fixture()
    const report = await harness.manager.change(harness.project, { operation: "adopt", target: harness.linked })
    const record = report.records.find((item) => item.path === harness.linked)!
    expect(record).toMatchObject({ ownership: "adopted", creator: "user-adopted", cleanupPolicy: "manual-only" })
    const manager = createWorktreeManager({ dir: harness.dir })
    await manager.change(harness.linked, { operation: "adopt", target: record.id })
    for (const target of [record.id, record.branch!, "../linked"]) {
      const opened = await manager.query(harness.project, { operation: "open", target })
      expect(opened.preview).toMatchObject({ action: "open", executesGit: false, executesTsm: false, commands: [], target: { path: harness.linked, ownership: "adopted" } })
    }
    expect(JSON.parse(readFileSync(report.registryPath, "utf8")).records).toHaveLength(1)
    await expect(manager.query(harness.project, { operation: "open", target: "missing" })).rejects.toThrow("Unknown worktree target")
  })
  test("remove/reset gate external, dirty and base checkouts, and clean previews never execute", async () => {
    const harness = await fixture()
    expect((await harness.manager.query(harness.project, { operation: "remove", target: harness.linked })).ok).toBe(false)
    await harness.manager.change(harness.project, { operation: "adopt", target: harness.linked })
    for (const operation of ["remove", "reset"] as const) {
      const preview = (await harness.manager.query(harness.project, { operation, target: harness.linked })).preview!
      expect(preview.blocked).toBe(false)
      expect(preview.commands.every((command) => command.destructive)).toBe(true)
      expect(preview.forceConfirmation).toBe(harness.linked)
      expect(existsSync(path.join(harness.linked, "tracked.txt"))).toBe(true)
    }
    writeFileSync(path.join(harness.linked, "tracked.txt"), "dirty\n")
    expect((await harness.manager.query(harness.project, { operation: "reset", target: harness.linked })).preview?.blockReasons.join(" ")).toContain("dirty")
    await harness.manager.change(harness.project, { operation: "adopt", target: harness.project })
    expect((await harness.manager.query(harness.project, { operation: "remove", target: harness.project })).preview?.blockReasons.join(" ")).toContain("base checkout")
    expect(readFileSync(path.join(harness.linked, "tracked.txt"), "utf8")).toBe("dirty\n")
  })
  test("branch drift and stale registries remain visible and block destructive previews", async () => {
    const harness = await fixture()
    await harness.manager.change(harness.project, { operation: "adopt", target: harness.linked })
    await git(harness.linked, "switch", "-c", "mend/moved")
    const drifted = await harness.manager.query(harness.project, { operation: "reset", target: harness.linked })
    expect(drifted.preview?.target.ownership).toBe("drifted")
    expect(drifted.ok).toBe(false)
    await git(harness.project, "worktree", "remove", harness.linked)
    const stale = await harness.manager.query(harness.project, { operation: "doctor" })
    expect(stale.records.find((record) => record.path === harness.linked)?.ownership).toBe("stale")
    expect(stale.warnings.join(" ")).toContain("Stale or drifted")
    expect((await harness.manager.query(harness.project, { operation: "open", target: harness.linked })).ok).toBe(false)
    await expect(harness.manager.change(harness.project, { operation: "adopt", target: harness.linked })).rejects.toThrow("unavailable")
  })
  test("non-Git and corrupt registries fail safely; read-only preview never saves a plan", async () => {
    const harness = await fixture()
    const missing = await harness.manager.query(harness.root, { operation: "doctor" })
    expect(missing.ok).toBe(false)
    expect(existsSync(missing.registryPath)).toBe(false)
    const preview = await harness.manager.query(harness.project, { operation: "preview", input: { name: "test" } })
    expect(preview.ok).toBe(true)
    expect(existsSync(preview.registryPath)).toBe(false)
    await harness.manager.change(harness.project, { operation: "plan", input: { name: "test", branch: "feature" } })
    expect((await harness.manager.query(harness.project, { operation: "doctor" })).warnings.join(" ")).toContain("mend/ prefix")
    writeFileSync(preview.registryPath, "broken")
    await expect(harness.manager.change(harness.project, { operation: "adopt", target: harness.linked })).rejects.toThrow()
    expect(readFileSync(preview.registryPath, "utf8")).toBe("broken")
  })
  test("socket commands, typed client helpers and session counts use the daemon contract", async () => {
    const harness = await fixture()
    const daemon = await boot({ project: harness.project, dir: harness.dir })
    try {
      await openSession(daemon)
      const status = await daemon.client.worktrees(harness.project)
      expect(status.ok).toBe(true)
      if (!status.ok) throw new Error(status.error.message)
      expect(WorktreeReport.safeParse(status.report).success).toBe(true)
      expect(status.report.records.find((record) => record.path === harness.project)?.sessions).toHaveLength(1)
      const plan = await daemon.client.changeWorktree(harness.project, { operation: "create", input: { name: "socket" } })
      expect(plan.ok).toBe(true)
      const adopted = await daemon.client.changeWorktree(harness.project, { operation: "adopt", target: harness.linked })
      expect(adopted.ok).toBe(true)
      const bad = await daemon.client.worktrees(harness.project, { operation: "open", target: "missing" })
      expect(bad.ok).toBe(false)
    } finally { await daemon.cleanup() }
  })
})
