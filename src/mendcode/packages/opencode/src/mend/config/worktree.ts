import { spawnSync } from "child_process"
import { readFile, writeFile, mkdir } from "fs/promises"
import { existsSync } from "fs"
import path from "path"
import { mendPaths } from "./paths"
import { activeFocus, focusProfiles } from "./project"
import { buildWorktreePreview, createWorktreeRecord, gitWorktreeList, planNativeWorktreeCreate, planNativeWorktreeRemove, planNativeWorktreeReset, readWorktreeState, reconcileWorktreeState, renderWorktreePreview, resolveWorktreeContext, saveWorktreeRecord } from "../worktree"
export { activateTsm, deactivateTsm, removeTsm, setupTsm, tsmDoctor, tsmPlan, tsmStatus } from "./tsm"

export const MFLOW_DEFAULT_SIGNALING = "ws://localhost:8787"
export const MFLOW_REPOSITORY = "https://github.com/Obed0101/mflow"
export const MFLOW_NPM_PACKAGE = "mflow-cli"
export const MFLOW_NPM_VERSION = "registry-default"
export const MFLOW_RESERVED_NPM_PACKAGE = { name: "mflow", reason: "npm name already exists for an unrelated monad-style flow control package" }
export const TSM_REPOSITORY = "https://github.com/adibhanna/tsm"
export const TSM_OBSERVED_HEAD = "d33778c90e36558c6eb5ad110a3506e209975f5c"

export async function readWorktreePolicy(root?: string) {
  const paths = mendPaths(root)
  const file = path.join(paths.mendDir, "worktree", "policy.yaml")
  let text = ""
  try { text = await readFile(file, "utf8") } catch {}
  const mode = text.match(/^mode:\s*(.+)$/m)?.[1]?.trim() || "off"
  const liveSync = text.match(/^liveSync:\s*(.+)$/m)?.[1]?.trim() === "true"
  const neverSyncRaw = text.match(/^neverSync:\s*\[(.+)\]$/m)?.[1] || ""
  const neverSync = neverSyncRaw.split(",").map((item) => item.trim().replace(/^"|"$/g, "")).filter(Boolean)
  return { path: path.relative(paths.root, file), mode, liveSync, neverSync }
}

async function readJson(file: string, fallback: any) {
  try {
    return JSON.parse(await readFile(file, "utf8"))
  } catch {
    return fallback
  }
}

async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

export async function mflowStatus(root?: string) {
  const policy = await readWorktreePolicy(root)
  const packageState = { reserved: MFLOW_RESERVED_NPM_PACKAGE, selected: MFLOW_NPM_PACKAGE, version: MFLOW_NPM_VERSION, published: true }
  const safety = { explicitOptInRequired: true, createsOrSyncsFiles: false, blockedByDefault: !policy.liveSync, neverSync: policy.neverSync }
  return { integration: "optional-open-source-package", repository: MFLOW_REPOSITORY, packageManager: "pnpm", npmPackage: packageState, signaling: MFLOW_DEFAULT_SIGNALING, mode: policy.mode, liveSync: policy.liveSync, enabled: policy.liveSync && policy.mode === "live-sync", safety }
}

function optionValue(args: string[], name: string) {
  const index = args.indexOf(name)
  if (index === -1) return null
  const value = args[index + 1]
  if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`)
  return value
}

export async function worktreeStatus(root?: string) {
  const context = resolveWorktreeContext(root || process.cwd())
  const paths = mendPaths(context.repoRoot)
  const flows = await readJson(path.join(paths.mendDir, "worktree", "flows.json"), { version: 0, flows: [] })
  const locks = await readJson(path.join(paths.mendDir, "worktree", "locks.json"), {})
  const state = await readWorktreeState(paths.root)
  const git = context.git.ok ? context.git : gitWorktreeList(paths.root)
  const reconciliation = reconcileWorktreeState(state, git.entries)
  return {
    workspace: {
      currentPath: context.currentPath,
      currentBranch: context.currentBranch,
      repoRoot: context.repoRoot,
      isLinkedWorktree: context.isLinkedWorktree,
      stateRoot: paths.root,
    },
    policy: await readWorktreePolicy(paths.root),
    registry: {
      path: path.relative(paths.root, path.join(paths.mendDir, "worktree", "state.json")),
      branchPrefix: state.branchPrefix,
      defaultExecutor: state.defaultExecutor,
      records: reconciliation.records,
      external: reconciliation.external,
      stale: reconciliation.stale,
      drifted: reconciliation.drifted,
    },
    git,
    flows: flows.flows || [],
    locks,
  }
}

export async function worktreePlan(args: string[], root?: string) {
  const context = resolveWorktreeContext(root || process.cwd())
  const paths = mendPaths(context.repoRoot)
  const name = args[0]
  if (!name) throw new Error("Usage: mendcode worktree plan <name> [--branch <branch>] [--focus <focus>]")
  const managerState = await readWorktreeState(paths.root)
  const branch = optionValue(args, "--branch") || `${managerState.branchPrefix}${name}`
  const focus = optionValue(args, "--focus") || activeFocus(paths.root)
  if (!focusProfiles[focus]) throw new Error(`Unknown focus profile: ${focus}`)
  const preview = planNativeWorktreeCreate({
    repoRoot: paths.root,
    name,
    branchPrefix: managerState.branchPrefix,
    branch,
    baseRef: optionValue(args, "--base") || null,
    directory: optionValue(args, "--path") || undefined,
    root: paths.root,
  }).preview
  const flowsPath = path.join(paths.mendDir, "worktree", "flows.json")
  const plan = {
    id: name,
    branch,
    focus,
    mode: (await readWorktreePolicy(paths.root)).mode,
    status: "planned",
    createdAt: new Date().toISOString(),
    executesGit: false,
    preview,
    previewText: renderWorktreePreview(preview),
    note: "Preview-only; this plan does not create a git worktree.",
  }
  const flowState = await readJson(flowsPath, { version: 0, flows: [] })
  flowState.flows = [...(flowState.flows || []).filter((flow: any) => flow.id !== name), plan]
  await writeJson(flowsPath, flowState)
  return plan
}

export async function worktreeCreate(args: string[], root?: string) {
  const plan = await worktreePlan(args, root)
  return {
    ...plan,
    command: "create",
    executesGit: false,
    requires: "live execution is intentionally gated behind a future explicit execute flag",
  }
}

export async function worktreeOpen(args: string[], root?: string) {
  const context = resolveWorktreeContext(root || process.cwd())
  const paths = mendPaths(context.repoRoot)
  const target = args[0]
  if (!target) throw new Error("Usage: mendcode worktree open <id|branch|path>")
  const state = await readWorktreeState(paths.root)
  const records = Object.values(state.worktrees)
  const record = records.find((item) => item.id === target || item.branch === target || item.path === target)
  if (record) {
    return {
      action: "open",
      target,
      ownership: record.ownership,
      executor: record.executor,
      path: record.path,
      branch: record.branch,
      executesTsm: false,
      executesGit: false,
    }
  }
  const git = gitWorktreeList(paths.root)
  const external = git.entries.find((item) => item.path === target || item.branch === target)
  if (!external) throw new Error(`Unknown worktree target: ${target}`)
  return {
    action: "open",
    target,
    ownership: "external",
    path: external.path,
    branch: external.branch,
    executesTsm: false,
    executesGit: false,
    note: "External worktree is visible but not owned; adopt before destructive actions.",
  }
}

export async function worktreeAdopt(args: string[], root?: string) {
  const context = resolveWorktreeContext(root || process.cwd())
  const paths = mendPaths(context.repoRoot)
  const target = args[0]
  if (!target) throw new Error("Usage: mendcode worktree adopt <path|branch>")
  const git = gitWorktreeList(paths.root)
  const external = git.entries.find((item) => item.path === target || item.branch === target)
  if (!external) throw new Error(`Cannot adopt unknown git worktree: ${target}`)
  const record = createWorktreeRecord({
    creator: "user-adopted",
    ownership: "adopted",
    repoRoot: paths.root,
    path: external.path,
    branch: external.branch,
    baseRef: null,
    executor: "native",
    sessions: [],
    packages: [],
    mflowMode: "unknown",
    creationPlan: { commands: [], writes: [".mendcode/worktree/state.json"], note: "explicit user adoption" },
    cleanupPolicy: "manual-only",
  })
  const saved = await saveWorktreeRecord(record, paths.root)
  return { action: "adopt", record: saved, executesGit: false, executesTsm: false }
}

export async function worktreeRemove(args: string[], root?: string) {
  return destructivePreview("remove", args, root)
}

export async function worktreeReset(args: string[], root?: string) {
  return destructivePreview("reset", args, root)
}

async function destructivePreview(action: "remove" | "reset", args: string[], root?: string) {
  const context = resolveWorktreeContext(root || process.cwd())
  const paths = mendPaths(context.repoRoot)
  const target = args[0]
  if (!target) throw new Error(`Usage: mendcode worktree ${action} <id|branch|path>`)
  const state = await readWorktreeState(paths.root)
  const records = Object.values(state.worktrees)
  const record = records.find((item) => item.id === target || item.branch === target || item.path === target)
  if (!record) {
    const git = gitWorktreeList(paths.root)
    const external = git.entries.find((item) => item.path === target || item.branch === target)
    if (!external) throw new Error(`Unknown worktree target: ${target}`)
    const preview = buildWorktreePreview({
      action,
      root: paths.root,
      record: createWorktreeRecord({
        creator: "user-adopted",
        ownership: "external",
        repoRoot: paths.root,
        path: external.path,
        branch: external.branch,
        baseRef: null,
        executor: "native",
        sessions: [],
        packages: [],
        mflowMode: "unknown",
        creationPlan: { commands: [], writes: [] },
        cleanupPolicy: "manual-only",
      }),
    })
    return { action, mode: "preview", executesGit: false, preview, previewText: renderWorktreePreview(preview) }
  }
  const preview = action === "remove" ? planNativeWorktreeRemove(record, paths.root) : planNativeWorktreeReset(record, paths.root)
  return { action, mode: "preview", executesGit: false, preview, previewText: renderWorktreePreview(preview) }
}

export async function worktreeDoctor(root?: string) {
  const context = resolveWorktreeContext(root || process.cwd())
  const paths = mendPaths(context.repoRoot)
  const policy = await readWorktreePolicy(paths.root)
  const flows = await readJson(path.join(paths.mendDir, "worktree", "flows.json"), { version: 0, flows: [] })
  const locks = await readJson(path.join(paths.mendDir, "worktree", "locks.json"), {})
  const failures: string[] = []
  const warnings: string[] = []
  const rootGit = existsSync(path.join(paths.root, ".git"))
  const engineGit = existsSync(path.join(paths.root, ".agents", "vendor", "opencode", ".git"))
  if (!rootGit) warnings.push("project root is not a git checkout; real `git worktree add` is blocked here")
  if (!engineGit) warnings.push("donor adapter checkout is missing .git; upstream worktree execution is unavailable")
  if (policy.liveSync) failures.push("worktree execution cannot proceed while liveSync=true")
  if (!["off", "awareness-only", "lock-only"].includes(policy.mode)) failures.push(`worktree execution requires mode off/awareness-only/lock-only, got ${policy.mode}`)
  for (const flow of flows.flows || []) {
    if (flow.executesGit) failures.push(`flow ${flow.id} claims executesGit=true before safety approval`)
    if (!flow.branch?.startsWith("mend/")) warnings.push(`flow ${flow.id} branch does not use mend/ prefix`)
  }
  return {
    ok: failures.length === 0,
    executesGit: false,
    approvedForRealWorktreeAdd: false,
    workspace: {
      currentPath: context.currentPath,
      currentBranch: context.currentBranch,
      repoRoot: context.repoRoot,
      isLinkedWorktree: context.isLinkedWorktree,
      stateRoot: paths.root,
    },
    policy,
    rootGit,
    engineGit,
    flows: flows.flows || [],
    locks,
    requiredReview: ".agents/specs/mendcode-opencode-phase0-spike/worktree-execution-safety-review.md",
    failures,
    warnings,
  }
}

export async function mflowPlan(root?: string) {
  const paths = mendPaths(root)
  const policy = await readWorktreePolicy(root)
  const status = await mflowStatus(root)
  const plan = {
    version: 0,
    status: "dry-run",
    generatedAt: new Date().toISOString(),
    integration: status.integration,
    repository: MFLOW_REPOSITORY,
    npmPackage: status.npmPackage,
    install: { package: MFLOW_NPM_PACKAGE, version: MFLOW_NPM_VERSION, command: `pnpm dlx --package ${MFLOW_NPM_PACKAGE} mflow setup`, executesInstall: false },
    lifecycle: { start: "dry-run-only-until-explicit-approval", stop: "safe-noop-until-start-exists", pause: "human-pause-authority-required", resume: "human-or-admin-explicit-only" },
    room: { idSource: "explicit-config-or-generated-local-plan", secretSource: "explicit-env-or-keychain-never-committed", signaling: MFLOW_DEFAULT_SIGNALING },
    surfaces: ["status", "peers", "files", "locks", "pause", "resume"],
    ignore: { file: ".mflowignore", requiredEntries: policy.neverSync },
    safety: status.safety,
    writesFiles: false,
    startsDaemon: false,
    touchesDonorHotPaths: false,
  }
  await writeJson(paths.mflowPlan, plan)
  return { ...plan, path: path.relative(paths.root, paths.mflowPlan) }
}

export async function mflowDoctor(root?: string) {
  const paths = mendPaths(root)
  const policy = await readWorktreePolicy(root)
  const requiredNeverSync = [".git", ".mflow", ".env*", "node_modules", ".mendcode/runs", ".mendcode/cache"]
  const failures: string[] = []
  const warnings: string[] = []
  for (const entry of requiredNeverSync) if (!policy.neverSync.includes(entry)) failures.push(`policy.neverSync missing ${entry}`)
  if (policy.liveSync && policy.mode !== "live-sync") failures.push("liveSync=true requires mode: live-sync")
  if (policy.mode === "live-sync") warnings.push("live-sync mode is configured; start must still remain explicit and visible")
  if (!existsSync(paths.mflowPlan)) warnings.push("mflow plan has not been generated yet; run `mendcode mflow plan` before implementation")
  if (MFLOW_NPM_PACKAGE !== "mflow-cli") failures.push(`selected package must remain mflow-cli, got ${MFLOW_NPM_PACKAGE}`)
  return { ok: failures.length === 0, package: { reserved: MFLOW_RESERVED_NPM_PACKAGE, selected: MFLOW_NPM_PACKAGE, version: MFLOW_NPM_VERSION, published: true }, repository: MFLOW_REPOSITORY, signaling: MFLOW_DEFAULT_SIGNALING, policy, plan: existsSync(paths.mflowPlan) ? path.relative(paths.root, paths.mflowPlan) : null, failures, warnings }
}
