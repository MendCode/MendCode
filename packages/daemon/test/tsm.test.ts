import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { TsmReport } from "@mendcode/protocol"
import { createTsmManager } from "../src/tsm"
import { createWorktreeManager } from "../src/worktrees"
import { boot } from "./native-harness"

/** The product default is 1 s per probe; a fixture script that is slow to start on a loaded machine must not read as "not capable". */
const PROBE_TIMEOUT_MS = 30_000
const temporary: string[] = []
const originalBinary = process.env.MENDCODE_TSM_BINARY
afterEach(() => {
  if (originalBinary === undefined) delete process.env.MENDCODE_TSM_BINARY
  else process.env.MENDCODE_TSM_BINARY = originalBinary
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true })
})
async function git(directory: string, ...argv: string[]) {
  const child = Bun.spawn(["git", "--no-optional-locks", "-c", "core.hooksPath=/dev/null", "-c", "user.name=B72", "-c", "user.email=b72@example.invalid", "-c", "commit.gpgsign=false", "-C", directory, ...argv], { stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" } })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(`Git fixture failed: ${stderr}`)
  return stdout.trimEnd()
}
async function fixture(commit = true) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "mendcode-b72-")))
  temporary.push(root)
  const project = path.join(root, "project"), dir = path.join(root, "data"), binary = path.join(root, "tsm"), log = path.join(root, "probes")
  mkdirSync(project)
  await git(project, "init", "-b", "main")
  if (commit) {
    writeFileSync(path.join(project, "tracked.txt"), "base\n")
    await git(project, "add", "tracked.txt")
    await git(project, "commit", "-m", "fixture")
  }
  process.env.MENDCODE_TSM_BINARY = binary
  const fake = (version = "v0.7.0", help = "tsm wt open add rm move prune", code = 0) => writeFileSync(binary, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\ncase "$*" in\n  --version) printf '%s\\n' '${version}' ;;\n  'wt --help') printf '%s\\n' '${help}' ;;\n  *) exit 99 ;;\nesac\nexit ${code}\n`, { mode: 0o700 })
  const worktrees = createWorktreeManager({ dir }), manager = createTsmManager({ dir, worktrees, probeTimeoutMs: PROBE_TIMEOUT_MS })
  return { root, project, dir, binary, log, fake, worktrees, manager }
}
describe("B72 TSM lifecycle and previews", () => {
  test("missing binary defaults off, status is pure, activation refuses and empty Git is explicit", async () => {
    const h = await fixture(false)
    const report = await h.manager.query(h.project, { operation: "status" })
    expect(TsmReport.safeParse(report).success).toBe(true)
    expect(report).toMatchObject({ enabled: false, lifecycle: "not-installed", rootGit: true, gitHead: false, defaultMuxBackend: "auto" })
    expect(report.warnings.join(" ")).toContain("no commits")
    expect(existsSync(h.dir)).toBe(false)
    await expect(h.manager.change(h.project, { operation: "activate" })).rejects.toThrow("binary not found")
    const doctor = await h.manager.query(h.root, { operation: "doctor" })
    expect(doctor.ok).toBe(false)
    expect(doctor.failures.join(" ")).toContain("Git checkout")
  })
  test("version/help capability detection does not expose raw executable output", async () => {
    const h = await fixture()
    h.fake("v0.6.7 private-probe-content", "worktree commands private-probe-content")
    const capable = await h.manager.query(h.project, { operation: "status" })
    expect(capable).toMatchObject({ detectedVersion: "v0.6.7", worktreeCapable: true, lifecycle: "installed-inactive" })
    expect(JSON.stringify(capable)).not.toContain("private-probe-content")
    h.fake("v0.6.6", "sessions only")
    expect((await h.manager.query(h.project, { operation: "status" })).worktreeCapable).toBe(false)
    await expect(h.manager.change(h.project, { operation: "activate" })).rejects.toThrow("worktree support")
    h.fake("v0.7.0", "sessions only")
    expect((await h.manager.query(h.project, { operation: "status" })).worktreeCapable).toBe(true)
    h.fake("v0.7.0", "worktree", 1)
    expect((await h.manager.query(h.project, { operation: "status" })).worktreeCapable).toBe(false)
  })
  test("plan/install/setup persist dry-run instructions without installing, activating or changing Git", async () => {
    const h = await fixture()
    h.fake()
    const before = await git(h.project, "status", "--porcelain")
    for (const operation of ["plan", "install", "setup"] as const) {
      const result = await h.manager.change(h.project, { operation })
      expect(TsmReport.safeParse(result).success).toBe(true)
      expect(result).toMatchObject({ operation, enabled: false, plan: { status: "dry-run", install: { executesInstall: false }, activation: { delegatesWorktreesImmediately: false } } })
      expect(existsSync(result.managedFiles.plan)).toBe(true)
      expect(existsSync(result.managedFiles.state)).toBe(false)
    }
    expect(await git(h.project, "status", "--porcelain")).toBe(before)
    expect(readFileSync(h.log, "utf8").split("\n").filter(Boolean).every((line) => ["--version", "wt --help"].includes(line))).toBe(true)
  })
  test("activation is persistent/shared with linked worktrees; degraded adapters are visible", async () => {
    const h = await fixture()
    h.fake()
    const linked = path.join(h.root, "linked")
    await git(h.project, "worktree", "add", "-b", "mend/linked", linked)
    const active = await h.manager.change(h.project, { operation: "activate", muxBackend: "kitty" })
    const restart = createTsmManager({ dir: h.dir, worktrees: h.worktrees, probeTimeoutMs: PROBE_TIMEOUT_MS })
    const report = await restart.query(linked, { operation: "status" })
    expect(report).toMatchObject({ lifecycle: "active", enabled: true, defaultMuxBackend: "kitty", workspace: { repoRoot: h.project, isLinkedWorktree: true } })
    expect(report.managedFiles).toEqual(active.managedFiles)
    process.env.MENDCODE_TSM_BINARY = path.join(h.root, "missing")
    const degraded = await restart.query(linked, { operation: "doctor" })
    expect(degraded).toMatchObject({ lifecycle: "degraded", enabled: true, ok: false })
    expect(degraded.failures.join(" ")).toContain("binary/capabilities")
    const off = await restart.change(linked, { operation: "deactivate" })
    expect(off.enabled).toBe(false)
    expect(off.defaultMuxBackend).toBe("kitty")
  })
  test("open/create adapters preserve native gates, sync gate and exact argv, and never launch", async () => {
    const h = await fixture()
    h.fake()
    const blocked = await h.manager.query(h.project, { operation: "open", target: "main" })
    expect(blocked.preview?.blockReasons.join(" ")).toContain("not active")
    const active = await h.manager.change(h.project, { operation: "activate" })
    const open = await h.manager.query(h.project, { operation: "open", target: "main" })
    expect(TsmReport.safeParse(open).success).toBe(true)
    expect(open.preview).toMatchObject({ blocked: false, executesTsm: false, commands: [{ tool: "tsm", argv: ["wt", "main"], cwd: h.project }] })
    const create = await h.manager.query(h.project, { operation: "create", input: { name: "Client", branch: "mend/client", base: "main" } })
    expect(create.preview?.commands[0]?.argv).toEqual(["wt", "add", "mend/client"])
    expect(existsSync(create.preview!.target)).toBe(false)
    expect((await h.manager.query(h.project, { operation: "create", input: { name: "occupied", branch: "main" } })).ok).toBe(false)
    mkdirSync(path.dirname(active.managedFiles.policy), { recursive: true })
    writeFileSync(active.managedFiles.policy, JSON.stringify({ mode: "off", liveSync: true, neverSync: ["secrets"] }))
    expect((await h.manager.query(h.project, { operation: "doctor" })).failures.join(" ")).toContain("liveSync=true")
    expect((await h.manager.query(h.project, { operation: "open", target: "main" })).ok).toBe(false)
    expect((await git(h.project, "worktree", "list", "--porcelain")).match(/^worktree /gm)).toHaveLength(1)
    expect(readFileSync(h.log, "utf8").split("\n").filter(Boolean).every((line) => ["--version", "wt --help"].includes(line))).toBe(true)
  })
  test("remove recycles only scaffold and preserves external binary, sync policy, sessions and checkouts", async () => {
    const h = await fixture()
    h.fake()
    await h.manager.change(h.project, { operation: "setup" })
    const active = await h.manager.change(h.project, { operation: "activate" })
    mkdirSync(path.dirname(active.managedFiles.policy), { recursive: true })
    writeFileSync(active.managedFiles.policy, JSON.stringify({ mode: "off", liveSync: false, neverSync: [] }))
    const result = await h.manager.change(h.project, { operation: "remove" })
    expect(result).toMatchObject({ lifecycle: "installed-inactive", enabled: false })
    expect(result.plan).toBeUndefined()
    expect(existsSync(result.managedFiles.state)).toBe(false)
    expect(existsSync(path.join(result.archivedTo!, "state.json"))).toBe(true)
    expect(existsSync(path.join(result.archivedTo!, "plan.json"))).toBe(true)
    expect(existsSync(result.managedFiles.policy)).toBe(true)
    expect(existsSync(h.binary)).toBe(true)
    expect(readFileSync(path.join(h.project, "tracked.txt"), "utf8")).toBe("base\n")
    expect((await h.manager.change(h.project, { operation: "remove" })).archivedTo).toBeUndefined()
  })
  test("corrupt state and redirected owned directories fail without overwriting", async () => {
    const h = await fixture()
    h.fake()
    const report = await h.manager.change(h.project, { operation: "activate" })
    writeFileSync(report.managedFiles.state, "broken")
    await expect(h.manager.change(h.project, { operation: "deactivate" })).rejects.toThrow()
    expect(readFileSync(report.managedFiles.state, "utf8")).toBe("broken")
    const otherData = path.join(h.root, "redirected")
    mkdirSync(otherData)
    symlinkSync(path.dirname(report.managedFiles.state), path.join(otherData, "tsm"))
    const redirected = createTsmManager({ dir: otherData, worktrees: createWorktreeManager({ dir: otherData }), probeTimeoutMs: PROBE_TIMEOUT_MS })
    await expect(redirected.change(h.project, { operation: "setup" })).rejects.toThrow("symlink")
  })
  test("probe deadlines and oversized output are bounded and do not activate", async () => {
    const h = await fixture()
    writeFileSync(h.binary, "#!/bin/sh\nexec sleep 5\n", { mode: 0o700 })
    const timeout = await createTsmManager({ dir: h.dir, worktrees: h.worktrees, probeTimeoutMs: 150 }).query(h.project, { operation: "status" })
    expect(timeout.worktreeCapable).toBe(false)
    expect(timeout.warnings.join(" ")).toContain("timed out")
    writeFileSync(h.binary, "#!/bin/sh\nexec yes worktree\n", { mode: 0o700 })
    const oversized = await h.manager.query(h.project, { operation: "status" })
    expect(oversized.worktreeCapable).toBe(false)
    expect(oversized.warnings.join(" ")).toContain("output limit")
  }, 10000)
  test("socket commands and typed client route every control operation without provider calls", async () => {
    const h = await fixture()
    h.fake()
    const daemon = await boot({ dir: h.dir, project: h.project })
    try {
      const status = await daemon.client.tsm(h.project)
      expect(status.ok).toBe(true)
      if (!status.ok) throw new Error(status.error.message)
      expect(TsmReport.safeParse(status.report).success).toBe(true)
      for (const operation of ["plan", "install", "setup", "activate", "deactivate", "remove"] as const) {
        const reply = await daemon.client.changeTsm(h.project, { operation })
        expect(reply.ok).toBe(true)
      }
      expect((await daemon.client.tsm(h.project, { operation: "doctor" })).ok).toBe(true)
      expect((await daemon.client.tsm(h.project, { operation: "open", target: "missing" })).ok).toBe(false)
      expect(daemon.requests).toHaveLength(0)
    } finally { await daemon.cleanup() }
  }, 15000)
})
