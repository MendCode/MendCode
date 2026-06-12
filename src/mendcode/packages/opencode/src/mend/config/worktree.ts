import { readFile, writeFile, mkdir } from "fs/promises"
import { existsSync } from "fs"
import path from "path"
import { mendPaths } from "./paths"
import { activeFocus, focusProfiles } from "./project"

export const MFLOW_DEFAULT_SIGNALING = "wss://mflow-signal.obed0101.deno.net"
export const MFLOW_REPOSITORY = "https://github.com/Obed0101/mflow"
export const MFLOW_NPM_PACKAGE = "mflow-cli"
export const MFLOW_NPM_VERSION = "0.1.12"
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
  const paths = mendPaths(root)
  const flows = await readJson(path.join(paths.mendDir, "worktree", "flows.json"), { version: 0, flows: [] })
  const locks = await readJson(path.join(paths.mendDir, "worktree", "locks.json"), {})
  return { policy: await readWorktreePolicy(paths.root), flows: flows.flows || [], locks }
}

export async function worktreePlan(args: string[], root?: string) {
  const paths = mendPaths(root)
  const name = args[0]
  if (!name) throw new Error("Usage: mend worktree plan <name> [--branch <branch>] [--focus <focus>]")
  const branch = optionValue(args, "--branch") || `mend/${name}`
  const focus = optionValue(args, "--focus") || activeFocus(paths.root)
  if (!focusProfiles[focus]) throw new Error(`Unknown focus profile: ${focus}`)
  const flowsPath = path.join(paths.mendDir, "worktree", "flows.json")
  const state = await readJson(flowsPath, { version: 0, flows: [] })
  const plan = {
    id: name,
    branch,
    focus,
    mode: (await readWorktreePolicy(paths.root)).mode,
    status: "planned",
    createdAt: new Date().toISOString(),
    executesGit: false,
    note: "Phase 2 command architecture only; this plan does not create a git worktree.",
  }
  state.flows = [...(state.flows || []).filter((flow: any) => flow.id !== name), plan]
  await writeJson(flowsPath, state)
  return plan
}

export async function worktreeDoctor(root?: string) {
  const paths = mendPaths(root)
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
    install: { package: MFLOW_NPM_PACKAGE, version: MFLOW_NPM_VERSION, command: `pnpm dlx --package ${MFLOW_NPM_PACKAGE}@${MFLOW_NPM_VERSION} mflow setup`, executesInstall: false },
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
  if (!existsSync(paths.mflowPlan)) warnings.push("mflow plan has not been generated yet; run `mend mflow plan` before implementation")
  if (MFLOW_NPM_PACKAGE !== "mflow-cli") failures.push(`selected package must remain mflow-cli, got ${MFLOW_NPM_PACKAGE}`)
  return { ok: failures.length === 0, package: { reserved: MFLOW_RESERVED_NPM_PACKAGE, selected: MFLOW_NPM_PACKAGE, version: MFLOW_NPM_VERSION, published: true }, repository: MFLOW_REPOSITORY, signaling: MFLOW_DEFAULT_SIGNALING, policy, plan: existsSync(paths.mflowPlan) ? path.relative(paths.root, paths.mflowPlan) : null, failures, warnings }
}

export async function tsmStatus(root?: string) {
  const paths = mendPaths(root)
  const policy = await readWorktreePolicy(root)
  const rootGit = existsSync(path.join(paths.root, ".git"))
  const safety = { installsTsm: false, runsTsm: false, runsGitWorktreeAdd: false, liveSyncRequired: false, explicitApprovalRequiredForExecution: true }
  const candidate = { repository: TSM_REPOSITORY, observedHead: TSM_OBSERVED_HEAD, capabilitiesObserved: ["persistent terminal sessions", "native terminal mux workspaces", "git worktree lifecycle via tsm wt", "session TUI/palette"] }
  return { integration: "external-terminal-session-worktree-candidate", candidate, policy, rootGit, plan: existsSync(paths.tsmPlan) ? path.relative(paths.root, paths.tsmPlan) : null, safety }
}

export async function tsmPlan(root?: string) {
  const paths = mendPaths(root)
  const status = await tsmStatus(root)
  const plan = { version: 0, status: "dry-run", generatedAt: new Date().toISOString(), candidate: status.candidate, objective: "Use TSM as a possible session/workspace controller around MendCode worktree flows, not as live sync and not as a required runtime dependency.", phase: "inspect-and-plan-only", proposedSurfaces: { "mend tsm status": "read candidate/policy state", "mend tsm plan": "write this dry-run plan", "future mend worktree create --executor tsm": "blocked until explicit approval; would delegate worktree/session lifecycle after safety gate" }, executionBoundaries: { install: false, runTsmWtAdd: false, runGitWorktreeAdd: false, removeWorktrees: false, pruneSessions: false, touchMflow: false, touchDonorHotPaths: false }, requiredBeforeExecution: ["approval for real worktree creation", "branch/path policy", "dirty-tree guard", "cleanup/rollback plan", "lock ownership behavior", "TSM install provenance decision"], localPolicy: status.policy, rootGit: status.rootGit, safety: status.safety }
  await writeJson(paths.tsmPlan, plan)
  return { ...plan, path: path.relative(paths.root, paths.tsmPlan) }
}

export async function tsmDoctor(root?: string) {
  const paths = mendPaths(root)
  const status = await tsmStatus(root)
  const failures: string[] = []
  const warnings: string[] = []
  if (!status.rootGit) failures.push("project root must be a git checkout before any worktree executor can be approved")
  if (status.policy.liveSync) failures.push("TSM worktree execution must not start while liveSync=true")
  if (!existsSync(paths.tsmPlan)) warnings.push("TSM plan has not been generated yet; run `mend tsm plan`")
  return { ok: failures.length === 0, ...status, failures, warnings }
}
