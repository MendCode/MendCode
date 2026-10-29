import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { z } from "zod"
import { WorktreePlan, WorktreeRecord, type WorktreeChange, type WorktreeRead, type WorktreeReport, type WorktreePreview, type WorktreeCreateInput } from "@mendcode/protocol"
import { PROMPT_FOCUS_CHOICES } from "@mendcode/protocol/wire"

type GitResult = { ok: boolean; out: string; truncated: boolean }
const Registry = z.strictObject({ version: z.literal(1), records: z.array(WorktreeRecord).max(500), plans: z.array(WorktreePlan).max(100) })
const hash = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24)
const canonical = (value: string) => realpathSync(value)

async function git(directory: string, args: string[]): Promise<GitResult> {
  try {
    const child = Bun.spawn(["git", "--no-optional-locks", "-C", directory, ...args], { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } })
    const timer = setTimeout(() => child.kill(), 5000)
    const decoder = new TextDecoder()
    let out = "", truncated = false
    try {
      for await (const chunk of child.stdout) {
        out += decoder.decode(chunk, { stream: true })
        if (out.length > 128000) { out = out.slice(0, 128000); truncated = true; child.kill(); break }
      }
      out += decoder.decode()
      return { ok: await child.exited === 0, out: out.trimEnd(), truncated }
    } finally { clearTimeout(timer) }
  } catch { return { ok: false, out: "", truncated: false } }
}

async function dirty(directory: string) {
  const result = await git(directory, ["status", "--porcelain=v1", "-z", "--untracked-files=normal"])
  return { clean: result.ok && !result.out && !result.truncated, summary: !result.ok ? "Git status unavailable" : result.truncated ? "Changes exceed status limit" : result.out ? "Uncommitted changes" : "Clean", checkedAt: Date.now() }
}

export function createWorktreeManager(input: { dir: string; sessions?: (directory: string) => string[]; focus?: (directory: string) => string }) {
  let pending = Promise.resolve()
  async function context(directory: string) {
    const currentPath = canonical(directory)
    const root = await git(currentPath, ["rev-parse", "--show-toplevel"])
    const common = root.ok ? await git(currentPath, ["rev-parse", "--path-format=absolute", "--git-common-dir"]) : undefined
    const commonPath = common?.ok ? canonical(common.out) : currentPath
    const own = common?.ok ? await git(currentPath, ["rev-parse", "--absolute-git-dir"]) : undefined
    const isLinkedWorktree = Boolean(own?.ok && canonical(own.out) !== commonPath)
    const listed = root.ok ? await git(currentPath, ["worktree", "list", "--porcelain", "-z"]) : undefined
    const basePath = listed?.ok ? listed.out.split("\0").find((field) => field.startsWith("worktree "))?.slice(9) : undefined
    const repoRoot = root.ok && !isLinkedWorktree ? canonical(root.out) : basePath && existsSync(basePath) ? canonical(basePath) : null
    const branch = root.ok ? await git(currentPath, ["symbolic-ref", "--quiet", "--short", "HEAD"]) : undefined
    const registryPath = path.join(input.dir, "worktree-manager", `${hash(commonPath)}.json`)
    const state = existsSync(registryPath) ? Registry.parse(JSON.parse(readFileSync(registryPath, "utf8"))) : { version: 1 as const, records: [], plans: [] }
    const workspace = { currentPath, currentBranch: branch?.ok ? branch.out : null, repoRoot, isLinkedWorktree }
    return { workspace, registryPath, state, commonPath, listed }
  }

  async function load(directory: string): Promise<WorktreeReport> {
    const ctx = await context(directory)
    const listed = ctx.listed
    const failures = !listed?.ok ? ["Project is not an available Git checkout"] : []
    const entries: Array<{ path: string; branch: string | null; head: string | null }> = []
    let entry: typeof entries[number] | undefined
    for (const field of listed?.out.split("\0") ?? []) {
      if (field.startsWith("worktree ")) { entry = { path: field.slice(9), branch: null, head: null }; entries.push(entry) }
      else if (entry && field.startsWith("branch ")) entry.branch = field.slice(7).replace(/^refs\/heads\//, "")
      else if (entry && field.startsWith("HEAD ")) entry.head = field.slice(5)
    }
    if (!ctx.workspace.isLinkedWorktree && entries[0] && ctx.workspace.repoRoot) entries[0].path = ctx.workspace.repoRoot
    const records: WorktreeRecord[] = []
    for (const entry of entries.slice(0, 500)) {
      const saved = ctx.state.records.find((record) => record.path === entry.path)
      const drift: string[] = []
      if (saved && saved.branch !== entry.branch) drift.push("Branch differs from registry")
      const present = existsSync(entry.path)
      if (!present) drift.push("Worktree directory is missing")
      records.push({ id: hash(entry.path), path: entry.path, branch: entry.branch, head: entry.head, ownership: !present ? "stale" : drift.length ? "drifted" : saved?.ownership ?? "external", dirty: present ? await dirty(entry.path) : { clean: false, summary: "Directory missing", checkedAt: Date.now() }, drift, creator: saved?.creator ?? "git", executor: "native", baseRef: saved?.baseRef ?? null, cleanupPolicy: saved?.cleanupPolicy ?? "manual-only", sessions: (input.sessions?.(entry.path) ?? []).slice(0, 100), createdAt: saved?.createdAt ?? 0 })
    }
    if (listed?.ok && !listed.truncated) for (const saved of ctx.state.records) {
      if (!entries.some((entry) => entry.path === saved.path)) records.push({ ...saved, ownership: "stale", dirty: { clean: false, summary: "Not registered in Git", checkedAt: Date.now() }, drift: ["Worktree no longer registered in Git"] })
    }
    const warnings = ["Create, open, remove and reset are previews; no Git mutation or shell launch"]
    if (records.some((record) => record.ownership === "stale" || record.ownership === "drifted")) warnings.push("Stale or drifted records require review before cleanup")
    return { operation: "status", ok: failures.length === 0, workspace: ctx.workspace, registryPath: ctx.registryPath, records: records.slice(0, 500), plans: ctx.state.plans, failures, warnings, truncated: Boolean(listed?.truncated || entries.length > 500 || records.length > 500), mode: "preview", executesGit: false, executesTsm: false }
  }

  function resolve(report: WorktreeReport, target: string) {
    const byPath = path.resolve(report.workspace.currentPath, target)
    const matches = report.records.filter((record) => record.id === target || record.branch === target || record.path === byPath)
    if (matches.length !== 1) throw new Error(matches.length ? "Ambiguous worktree target; use its path or id" : `Unknown worktree target: ${target}`)
    return matches[0]!
  }

  async function previewCreate(report: WorktreeReport, values: WorktreeCreateInput): Promise<WorktreePreview> {
    const slug = values.name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "")
    if (!slug || slug === "." || slug === "..") throw new Error("Invalid worktree name")
    const branch = values.branch ?? `mend/${slug}`
    const directory = report.workspace.currentPath
    const root = report.workspace.repoRoot
    const target = values.path ? path.resolve(directory, values.path) : path.join(input.dir, "worktrees", path.basename(report.registryPath, ".json"), slug)
    const reasons = [...report.failures]
    const focus = values.focus ?? input.focus?.(directory) ?? "auto"
    if (!(PROMPT_FOCUS_CHOICES as readonly string[]).includes(focus)) reasons.push(`Unknown focus profile: ${focus}`)
    if (root) {
      if (branch.startsWith("-") || !(await git(directory, ["check-ref-format", "--branch", branch])).ok) reasons.push("Invalid branch name")
      if (!(await git(directory, ["rev-parse", "--verify", "--end-of-options", `${values.base ?? "HEAD"}^{commit}`])).ok) reasons.push("Base ref does not resolve to a commit")
      if ((await git(directory, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).ok) reasons.push("Branch already exists")
    }
    if (existsSync(target) || report.records.some((record) => record.path === target)) reasons.push("Target path already exists")
    return { action: "create", target: { id: hash(target), path: target, branch, head: null, ownership: "owned", dirty: { clean: true, summary: "Not created", checkedAt: Date.now() }, drift: [], creator: "mendcode", executor: "native", baseRef: values.base ?? null, cleanupPolicy: "remove-when-clean", sessions: [], createdAt: Date.now() }, commands: root ? [{ tool: "git", argv: ["worktree", "add", "--no-checkout", "-b", branch, target, ...(values.base ? [values.base] : [])], cwd: directory, destructive: false }] : [], stateWrites: [report.registryPath], blocked: reasons.length > 0, blockReasons: reasons, forceConfirmation: null, executesGit: false, executesTsm: false }
  }

  async function query(directory: string, query: WorktreeRead): Promise<WorktreeReport> {
    const report = await load(directory)
    report.operation = query.operation
    if (query.operation === "status" || query.operation === "doctor") {
      if (query.operation === "doctor") {
        for (const plan of report.plans) if (!plan.preview.target.branch?.startsWith("mend/")) report.warnings.push(`Plan ${plan.id} branch does not use mend/ prefix`)
        report.warnings = report.warnings.slice(0, 20)
      }
      return report
    }
    if (query.operation === "preview") {
      report.preview = await previewCreate(report, query.input)
    } else if ("target" in query) {
      const record = resolve(report, query.target)
      const reasons = [...report.failures]
      const destructive = query.operation !== "open"
      if (destructive && !["owned", "adopted"].includes(record.ownership)) reasons.push(`Target is ${record.ownership}; adopt or reconcile it first`)
      if (record.ownership === "stale") reasons.push("Target is unavailable")
      if (destructive && !record.dirty.clean) reasons.push(`Target is dirty: ${record.dirty.summary}`)
      if (destructive && record.path === report.workspace.repoRoot) reasons.push("Cannot remove or reset the base checkout")
      const commands: WorktreePreview["commands"] = query.operation === "remove" ? [{ tool: "git", argv: ["worktree", "remove", "--force", record.path], cwd: directory, destructive: true }, ...(record.branch ? [{ tool: "git" as const, argv: ["branch", "-D", record.branch], cwd: directory, destructive: true }] : [])] : query.operation === "reset" ? [{ tool: "git", argv: ["reset", "--hard", record.baseRef ?? "default-branch"], cwd: record.path, destructive: true }, { tool: "git", argv: ["clean", "-ffdx"], cwd: record.path, destructive: true }] : []
      report.preview = { action: query.operation, target: record, commands, stateWrites: destructive ? [report.registryPath] : [], blocked: reasons.length > 0, blockReasons: reasons, forceConfirmation: destructive ? record.path : null, executesGit: false, executesTsm: false }
    }
    report.ok = !report.preview?.blocked && !report.failures.length
    return report
  }

  async function change(directory: string, change: WorktreeChange): Promise<WorktreeReport> {
    const report = await load(directory)
    if (!report.ok) return { ...report, operation: change.operation }
    const ctx = await context(directory)
    if (change.operation === "adopt") {
      const record = resolve(report, change.target)
      if (record.ownership === "stale") throw new Error("Cannot adopt an unavailable worktree")
      const saved: WorktreeRecord = { ...record, ownership: record.ownership === "owned" ? "owned" : "adopted", creator: record.creator === "mendcode" ? "mendcode" : "user-adopted", cleanupPolicy: "manual-only", drift: [], createdAt: record.createdAt || Date.now() }
      ctx.state.records = [...ctx.state.records.filter((item) => item.id !== saved.id), saved]
    } else {
      const preview = await previewCreate(report, change.input)
      if (preview.blocked) return { ...report, operation: change.operation, ok: false, preview }
      const plan = { id: change.input.name, focus: change.input.focus ?? input.focus?.(directory) ?? "auto", createdAt: Date.now(), preview }
      ctx.state.plans = [...ctx.state.plans.filter((item) => item.id !== plan.id), plan].slice(-100)
      report.preview = preview
    }
    Registry.parse(ctx.state)
    mkdirSync(path.dirname(ctx.registryPath), { recursive: true, mode: 0o700 })
    const temporary = `${ctx.registryPath}.${crypto.randomUUID()}.tmp`
    writeFileSync(temporary, JSON.stringify(ctx.state, null, 2), { mode: 0o600 })
    renameSync(temporary, ctx.registryPath)
    return { ...await load(directory), operation: change.operation, ...(report.preview ? { preview: report.preview } : {}) }
  }

  return { query, change(directory: string, changeInput: WorktreeChange) {
    const result = pending.then(() => change(directory, changeInput))
    pending = result.then(() => {}, () => {})
    return result
  } }
}
