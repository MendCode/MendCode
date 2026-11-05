import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs"
import { lstat, readdir } from "node:fs/promises"
import path from "node:path"
import type { ProjectRestInfo, StorageArtifact, StorageWorktree, StorageWorktreesReport } from "@mendcode/protocol"
import { DEFAULT_WORKTREE_GC_DAYS } from "@mendcode/protocol"
import { readGitBranch } from "./git-branch"
import { captureOutput, defaultBranch, projectGit } from "./project-git"

const DAY_MS = 86_400_000
/** Entries one size walk visits at most: a worktree this large reports a lower bound instead of stalling the daemon. */
const WALK_LIMIT = 400_000
/** Worktrees idle this long are cleaned when no age is given. */
export const DEFAULT_WORKTREE_IDLE_DAYS = DEFAULT_WORKTREE_GC_DAYS
/** A `bun build --compile` temp file this old is a leftover, not a build in progress. */
export const STALE_BUN_BUILD_MS = 10 * 60_000
const BUN_BUILD_FILE = /^\..+\.bun-build$/
/** Ignored build output worth reclaiming from an idle worktree; all of it is rebuilt or reinstalled by the project's own commands. */
const ARTIFACT_DIRS = ["dist", "build", "out", "target", ".next", ".nuxt", ".turbo", ".svelte-kit", ".parcel-cache", "coverage", "node_modules"]
/** Containers whose children may hold their own artifact directories (monorepo packages). */
const ARTIFACT_PARENTS = ["apps", "packages"]
const ARTIFACT_LIMIT = 500
/** Directories the leftover search does not enter: huge, and never where `bun build` puts its temp files. */
const SKIPPED_WALK = new Set([".git", "node_modules", "target"])

type Kind = NonNullable<StorageWorktree["kind"]>

/** `du` gets this long per tree; a tree it cannot finish in time is reported as not measured instead of stalling the daemon. */
const DU_TIMEOUT_MS = 60_000
/** A measured size is trusted this long while the directory itself has not changed. */
const SIZE_TTL_MS = 10 * 60_000
const SIZE_CACHE_LIMIT = 2_000
/** Deleting a large checkout takes a while; git is not cut off in the middle of it. */
const REMOVE_TIMEOUT_MS = 10 * 60_000
const SCAN_CONCURRENCY = 4
const SIZE_CONCURRENCY = 2

/**
 * Allocated bytes under `root` from the system's `du -sk`: native, nothing retained in this process. Undefined when `du`
 * did not answer in time (or was cancelled); throws only when it cannot be started at all.
 */
async function duBytes(root: string, signal?: AbortSignal): Promise<number | undefined> {
  if (signal?.aborted) return undefined
  const { out, stopped } = await captureOutput(["du", "-sk", root], { signal, limit: 4096, timeoutMs: DU_TIMEOUT_MS })
  const kilobytes = /^(\d+)/.exec(out.trim())?.[1]
  return kilobytes === undefined || stopped || signal?.aborted ? undefined : Number(kilobytes) * 1024
}

/** Bytes under `root` without following links, yielding to the event loop between directories (only where `du` is missing). */
async function walkBytes(root: string, limit = WALK_LIMIT, signal?: AbortSignal): Promise<number> {
  let bytes = 0
  let seen = 0
  const pending = [root]
  while (pending.length && seen < limit && !signal?.aborted) {
    const directory = pending.pop()!
    let entries
    try { entries = await readdir(directory, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (++seen > limit) break
      const full = path.join(directory, entry.name)
      try {
        const stat = await lstat(full)
        // Allocated blocks, like du: a tree of many small files costs more disk than its bytes add up to.
        bytes += stat.blocks > 0 ? stat.blocks * 512 : stat.size
        if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(full)
      } catch { /* vanished while walking */ }
    }
  }
  return bytes
}

/** Disk bytes under `root`: `du` when there is one, a bounded walk otherwise. */
export async function treeBytes(root: string, limit = WALK_LIMIT, signal?: AbortSignal): Promise<number> {
  try { return (await duBytes(root, signal)) ?? 0 } catch { return walkBytes(root, limit, signal) }
}

type Flight = { promise: Promise<unknown>; waiters: number; controller: AbortController }

/** Runs `work` for the items, `width` at a time, keeping the order of the results. */
async function pool<T, R>(items: T[], width: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await work(items[index]!) }
  }))
  return results
}

/** Where the daemon puts the worktrees of loops, fan-outs, workflows and compound runs, under its data directory. */
const MANAGED_ROOTS: Array<{ kind: Kind; parts: string[]; depth: 1 | 2 }> = [
  { kind: "loop", parts: ["loop-worktrees"], depth: 1 },
  { kind: "fanout", parts: ["fanout-worktrees"], depth: 1 },
  { kind: "compound", parts: ["compound-worktrees"], depth: 1 },
  { kind: "merge", parts: ["workflows", "merge"], depth: 1 },
  { kind: "workflow", parts: ["workflows", "workspaces"], depth: 2 },
]

const normal = (directory: string) => { try { return realpathSync(directory) } catch { return path.resolve(directory) } }

/** The checkout a linked worktree belongs to, read from its `.git` pointer without spawning git (undefined when it is not a linked worktree). */
function repoOf(directory: string): string | undefined {
  try {
    const target = /^gitdir:\s*(.+)$/m.exec(readFileSync(path.join(directory, ".git"), "utf8"))?.[1]?.trim()
    if (!target) return undefined
    const gitdir = path.resolve(directory, target)
    const common = path.dirname(path.dirname(gitdir))
    return path.basename(path.dirname(gitdir)) === "worktrees" && path.basename(common) === ".git" ? path.dirname(common) : undefined
  } catch { return undefined }
}

type Candidate = { directory: string; kind: Kind; repo: string; project?: ProjectRestInfo; locked?: boolean }
type Target = StorageWorktree & { candidate: Candidate; idleOnly: boolean }
/** `measure`: "cached" shows the sizes already known (0, flagged, for the rest) and spawns nothing; "full" (the default) measures every tree. */
export type WorktreeScope = { artifacts?: boolean; external?: boolean; capBytes?: number; measure?: "cached" | "full" }

/**
 * What the daemon's worktrees cost and which of them may go. A worktree is a git checkout that shares the project's
 * object store (`git worktree add`), so the cost is its working files and ignored build output; removal uses plain
 * `git worktree remove` (no --force), which git itself refuses for uncommitted or untracked work.
 * Project sandboxes and the worktrees of loops, fan-outs, workflows and compound runs follow the same rule: clean, nothing
 * unmerged, unused and idle long enough. Worktrees git lists that MendCode did not make are only looked at when asked.
 */
export function createWorktreeGc(input: {
  dir: string
  projects(): ProjectRestInfo[]
  occupied(directory: string): boolean
  /** Last time a session worked in `directory` (0 when none ever did). */
  lastSession(directory: string): number
  /** Drops the registry entries of a removed (or vanished) worktree. */
  forget(project: ProjectRestInfo, directory: string): void
  now(): number
}) {
  const { dir } = input

  /** Sizes already measured, valid while the directory's own time is unchanged and for `SIZE_TTL_MS`. A number per tree, never a listing. */
  const sizes = new Map<string, { bytes: number; at: number; stamp: number }>()
  /** Work in flight by key: identical requests share it, and it stops when the last one that waits for it goes away. */
  const flights = new Map<string, Flight>()
  const stampOf = (directory: string) => { try { return statSync(directory).mtimeMs } catch { return 0 } }

  function share<T>(key: string, work: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    let flight = flights.get(key)
    if (!flight) {
      const controller = new AbortController()
      const created: Flight = { promise: work(controller.signal), waiters: 0, controller }
      created.promise.then(() => undefined, () => undefined).finally(() => { if (flights.get(key) === created) flights.delete(key) })
      flights.set(key, created)
      flight = created
    }
    const joined = flight
    joined.waiters++
    return new Promise<T>((resolve, reject) => {
      let left = false
      const leave = () => {
        if (left) return
        left = true
        signal?.removeEventListener("abort", cancel)
        if (--joined.waiters === 0) {
          if (flights.get(key) === joined) flights.delete(key)
          joined.controller.abort()
        }
      }
      const cancel = () => { leave(); reject(new Error("[GC]: request cancelled")) }
      if (signal?.aborted) return cancel()
      signal?.addEventListener("abort", cancel, { once: true })
      joined.promise.then((value) => { leave(); resolve(value as T) }, (error) => { leave(); reject(error) })
    })
  }

  function cachedBytes(directory: string): number | undefined {
    const entry = sizes.get(normal(directory))
    return entry && input.now() - entry.at < SIZE_TTL_MS && entry.stamp === stampOf(directory) ? entry.bytes : undefined
  }

  /** The tree's disk bytes: the cached size, else one `du` shared by everyone asking; undefined when it could not be measured. */
  async function measured(directory: string, signal?: AbortSignal): Promise<number | undefined> {
    const known = cachedBytes(directory)
    if (known !== undefined) return known
    const key = normal(directory)
    const stamp = stampOf(directory)
    const bytes = await share(`size:${key}`, async (own) => {
      try { return await duBytes(directory, own) } catch { return walkBytes(directory, WALK_LIMIT, own) }
    }, signal)
    if (bytes !== undefined) {
      if (sizes.size >= SIZE_CACHE_LIMIT) sizes.delete(sizes.keys().next().value!)
      sizes.set(key, { bytes, at: input.now(), stamp })
    }
    return bytes
  }

  function lastTouched(directory: string): number {
    let latest = 0
    const touch = (file: string) => { try { latest = Math.max(latest, statSync(file).mtimeMs) } catch { /* absent */ } }
    touch(directory)
    const pointer = path.join(directory, ".git")
    touch(pointer)
    try {
      // A linked worktree's .git is a file naming its private git dir; HEAD and index move with every commit and checkout.
      const target = /^gitdir:\s*(.+)$/m.exec(readFileSync(pointer, "utf8"))?.[1]?.trim()
      if (target) { touch(path.join(target, "HEAD")); touch(path.join(target, "index")) }
    } catch { /* a missing or odd .git: the directory time stands */ }
    return Math.max(latest, input.lastSession(directory))
  }

  /** True when what the worktree has is kept elsewhere: its branch is merged, or (detached) its commit is on a branch or in the project's history. */
  async function integrated(candidate: Candidate, branch: string | null, base: { ref: string } | undefined, signal?: AbortSignal) {
    const heads = ["HEAD", ...(base ? [base.ref] : [])]
    const within = async (commit: string) => {
      for (const head of heads) if ((await projectGit(candidate.repo, ["merge-base", "--is-ancestor", commit, head], signal).catch(() => undefined))?.ok) return true
      return false
    }
    if (branch) return within(branch)
    const commit = await projectGit(candidate.directory, ["rev-parse", "--verify", "HEAD^{commit}"], signal).catch(() => undefined)
    if (!commit?.ok || !commit.out) return false
    if (await within(commit.out)) return true
    const held = await projectGit(candidate.repo, ["for-each-ref", "--contains", commit.out, "--count=1", "--format=%(refname)", "refs/heads", "refs/remotes", "refs/tags"], signal).catch(() => undefined)
    return held?.ok === true && held.out !== ""
  }

  async function inspect(candidate: Candidate, idleDays: number, bases: Map<string, ReturnType<typeof defaultBranch>>, signal?: AbortSignal): Promise<Target> {
    const { directory } = candidate
    const occupied = input.occupied(directory)
    const common = { candidate, kind: candidate.kind, directory, occupied }
    if (!existsSync(directory)) return { ...common, branch: null, bytes: 0, state: "missing", clean: true, idleDays: 0, removable: !occupied, idleOnly: false, ...(occupied ? { keep: "a session still lists it" } : {}) }
    const head = readGitBranch(directory)
    // A detached HEAD reports its short commit as the "branch": it is not one, and must not be merged or deleted as one.
    const branch = head.detached ? null : head.branch ?? null
    const status = await projectGit(directory, ["status", "--porcelain", "--untracked-files=normal"], signal).catch(() => undefined)
    const clean = status?.ok === true && status.out === ""
    // One question per repository in a scan, not one per worktree.
    if (!bases.has(candidate.repo)) bases.set(candidate.repo, defaultBranch(candidate.repo, signal))
    const base = await bases.get(candidate.repo)!.catch(() => undefined)
    const merged = await integrated(candidate, branch, base, signal)
    const idle = Math.max(0, Math.floor((input.now() - lastTouched(directory)) / DAY_MS))
    const keep = !existsSync(candidate.repo) ? "its repository is gone"
      : candidate.locked ? "locked with git worktree lock"
      : occupied ? "a session, loop or workflow works in it"
      : !clean ? "uncommitted or untracked changes"
      : !merged ? (branch ? "branch has commits that are not merged" : "detached HEAD with commits no branch holds")
      : idle < idleDays ? `used ${idle} day${idle === 1 ? "" : "s"} ago` : undefined
    // Sizes come from the cache here; `sizeTargets` measures the rest when the caller wants them.
    const known = cachedBytes(directory)
    return { ...common, branch, bytes: known ?? 0, ...(known === undefined ? { bytesKnown: false } : {}), state: merged ? "merged" : "unmerged", clean, idleDays: idle, removable: keep === undefined, idleOnly: keep?.startsWith("used ") === true, ...(keep ? { keep } : {}) }
  }

  /** The worktrees under the daemon's own roots. */
  function managedCandidates(): Candidate[] {
    const found: Candidate[] = []
    const children = (parent: string) => { try { return readdirSync(parent, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(parent, entry.name)) } catch { return [] } }
    for (const root of MANAGED_ROOTS) {
      const top = children(path.join(dir, ...root.parts))
      for (const directory of root.depth === 1 ? top : top.flatMap(children)) {
        const repo = repoOf(directory)
        if (repo) found.push({ directory, kind: root.kind, repo })
      }
    }
    return found
  }

  /** Worktrees `git worktree list` shows for the registered projects that MendCode did not make. */
  async function externalCandidates(known: Set<string>, signal?: AbortSignal): Promise<Candidate[]> {
    const found: Candidate[] = []
    const seen = new Set<string>()
    for (const project of input.projects()) {
      const repo = project.worktree
      if (seen.has(normal(repo)) || !existsSync(repo)) continue
      seen.add(normal(repo))
      const listed = await projectGit(repo, ["worktree", "list", "--porcelain"], signal).catch(() => undefined)
      if (!listed?.ok) continue
      const blocks = listed.out.split(/\n\n+/).map((block) => block.split("\n"))
      // The first entry is the main checkout.
      for (const lines of blocks.slice(1)) {
        const directory = lines.find((line) => line.startsWith("worktree "))?.slice(9)
        if (!directory || lines.includes("bare") || known.has(normal(directory))) continue
        found.push({ directory, kind: "external", repo, locked: lines.some((line) => line === "locked" || line.startsWith("locked ")) })
      }
    }
    return found
  }

  async function scan(idleDays: number, scope: WorktreeScope, signal?: AbortSignal): Promise<Target[]> {
    // A registered project's own checkout is never a candidate, whatever lists it.
    const known = new Set<string>(input.projects().map((project) => normal(project.worktree)))
    const candidates: Candidate[] = []
    const add = (candidate: Candidate) => {
      const key = normal(candidate.directory)
      if (candidates.length >= ARTIFACT_LIMIT || known.has(key)) return
      known.add(key)
      candidates.push(candidate)
    }
    for (const project of input.projects()) for (const directory of project.sandboxes) add({ directory, kind: "sandbox", repo: project.worktree, project })
    for (const candidate of managedCandidates()) add(candidate)
    if (scope.external) for (const candidate of await externalCandidates(known, signal)) add(candidate)
    // A few git questions at a time: enough to be quick, few enough not to starve the daemon.
    const bases = new Map<string, ReturnType<typeof defaultBranch>>()
    return pool(candidates, SCAN_CONCURRENCY, (candidate) => inspect(candidate, idleDays, bases, signal))
  }

  /** Measures the targets whose size is not known yet, a couple of `du` at a time; a tree that cannot be measured stays flagged. */
  async function sizeTargets(targets: Target[], signal?: AbortSignal) {
    await pool(targets.filter((target) => target.bytesKnown === false && target.state !== "missing" && existsSync(target.directory)), SIZE_CONCURRENCY, async (target) => {
      const bytes = await measured(target.directory, signal).catch(() => undefined)
      if (bytes === undefined) return
      target.bytes = bytes
      delete target.bytesKnown
    })
  }

  /** Marks idle-only worktrees removable, oldest first, while the managed ones still take more than the cap. */
  function enforceCap(targets: Target[], capBytes: number | undefined) {
    if (!capBytes) return
    const managed = targets.filter((target) => target.kind !== "external")
    let remaining = managed.reduce((sum, target) => sum + target.bytes, 0) - managed.filter((target) => target.removable).reduce((sum, target) => sum + target.bytes, 0)
    for (const target of managed.filter((item) => item.idleOnly).sort((a, b) => b.idleDays - a.idleDays)) {
      if (remaining <= capBytes) break
      target.removable = true
      delete target.keep
      remaining -= target.bytes
    }
  }

  /** Old safety copies `workspace-remove` leaves in `trash/worktrees`. */
  function trashEntries(): Array<{ file: string; mtimeMs: number }> {
    const root = path.join(dir, "trash", "worktrees")
    try {
      return readdirSync(root).flatMap((name) => {
        const file = path.join(root, name)
        try { return [{ file, mtimeMs: statSync(file).mtimeMs }] } catch { return [] }
      })
    } catch { return [] }
  }

  /** `cached` reads what is known (nothing is measured); otherwise every entry is measured. */
  async function trashBytes(mode: "cached" | "full" = "full", signal?: AbortSignal) {
    let total = 0
    for (const entry of trashEntries()) total += (mode === "cached" ? cachedBytes(entry.file) : await measured(entry.file, signal).catch(() => undefined)) ?? 0
    return total
  }

  async function loopBytes(mode: "cached" | "full" = "full", signal?: AbortSignal) {
    const root = path.join(dir, "loop-worktrees")
    if (!existsSync(root)) return 0
    return (mode === "cached" ? cachedBytes(root) : await measured(root, signal).catch(() => undefined)) ?? 0
  }

  /** What the project sandboxes and the daemon's own worktree roots take on disk; sizes only, no git. */
  async function managedBytes(signal?: AbortSignal) {
    const seen = new Set<string>()
    const directories = [...input.projects().flatMap((project) => project.sandboxes), ...managedCandidates().map((candidate) => candidate.directory)].filter((directory) => {
      const key = normal(directory)
      if (seen.has(key) || !existsSync(directory)) return false
      seen.add(key)
      return true
    })
    return (await pool(directories, SIZE_CONCURRENCY, (directory) => measured(directory, signal).catch(() => undefined))).reduce<number>((sum, bytes) => sum + (bytes ?? 0), 0)
  }

  /** `bun build --compile` temp files left in `root` (a few levels deep), skipping `skip` directories. */
  async function bunBuildLeftovers(root: string, skip: Set<string>): Promise<StorageArtifact[]> {
    const found: StorageArtifact[] = []
    const pending: Array<{ directory: string; depth: number }> = [{ directory: root, depth: 0 }]
    let seen = 0
    while (pending.length && seen < 5_000 && found.length < ARTIFACT_LIMIT) {
      const { directory, depth } = pending.pop()!
      let entries
      try { entries = await readdir(directory, { withFileTypes: true }) } catch { continue }
      for (const entry of entries) {
        seen++
        const full = path.join(directory, entry.name)
        if (entry.isDirectory()) {
          if (depth < 4 && !SKIPPED_WALK.has(entry.name) && !skip.has(full)) pending.push({ directory: full, depth: depth + 1 })
        } else if (BUN_BUILD_FILE.test(entry.name)) {
          try {
            const stat = await lstat(full)
            if (stat.isFile() && input.now() - stat.mtimeMs > STALE_BUN_BUILD_MS) found.push({ directory: root, path: path.relative(root, full), bytes: stat.blocks > 0 ? stat.blocks * 512 : stat.size, kind: "bun-build" })
          } catch { /* vanished */ }
        }
      }
    }
    return found
  }

  /** Heavy ignored directories of `directory`: git must ignore them and track nothing inside. */
  async function artifactDirectories(directory: string, signal?: AbortSignal): Promise<StorageArtifact[]> {
    const names = ARTIFACT_DIRS.flatMap((name) => [name, ...ARTIFACT_PARENTS.flatMap((parent) => { try { return readdirSync(path.join(directory, parent)).map((child) => path.join(parent, child, name)) } catch { return [] } })])
    const found: StorageArtifact[] = []
    for (const relative of names) {
      const full = path.join(directory, relative)
      let stat
      try { stat = lstatSync(full) } catch { continue }
      if (!stat.isDirectory()) continue
      const ignored = await projectGit(directory, ["check-ignore", "-q", "--", relative], signal).catch(() => undefined)
      if (!ignored?.ok) continue
      const tracked = await projectGit(directory, ["ls-files", "--", relative], signal).catch(() => undefined)
      if (!tracked?.ok || tracked.out !== "") continue
      found.push({ directory, path: relative, bytes: (await measured(full, signal).catch(() => undefined)) ?? 0, kind: "directory" })
    }
    return found
  }

  /** Heavy ignored output of idle worktrees, and stale build temp files in them and in the projects' own checkouts. */
  async function artifacts(targets: Target[], idleDays: number, signal?: AbortSignal): Promise<StorageArtifact[]> {
    const found: StorageArtifact[] = []
    const covered = new Set<string>()
    for (const target of targets) {
      if (target.kind === "external" || target.state === "missing" || target.occupied || target.idleDays < idleDays || !existsSync(target.directory)) continue
      const heavy = await artifactDirectories(target.directory, signal)
      covered.add(normal(target.directory))
      found.push(...heavy, ...await bunBuildLeftovers(target.directory, new Set(heavy.map((item) => path.join(target.directory, item.path)))))
    }
    for (const project of input.projects()) {
      if (covered.has(normal(project.worktree)) || !existsSync(project.worktree)) continue
      covered.add(normal(project.worktree))
      found.push(...await bunBuildLeftovers(project.worktree, new Set()))
    }
    return found.slice(0, ARTIFACT_LIMIT)
  }

  /** Identical requests at the same time share one scan; it stops when the last client waiting for it goes away. */
  function report(idleDays = DEFAULT_WORKTREE_IDLE_DAYS, signal?: AbortSignal, scope: WorktreeScope = {}): Promise<StorageWorktreesReport> {
    return share(`report:${JSON.stringify([idleDays, scope])}`, (own) => buildReport(idleDays, own, scope), signal)
  }

  async function buildReport(idleDays: number, signal: AbortSignal, scope: WorktreeScope): Promise<StorageWorktreesReport> {
    const mode = scope.measure ?? "full"
    const targets = await scan(idleDays, scope, signal)
    // The cap needs real sizes for what MendCode manages, whatever the mode.
    await sizeTargets(mode === "full" ? targets : scope.capBytes ? targets.filter((target) => target.kind !== "external") : [], signal)
    enforceCap(targets, scope.capBytes)
    const worktrees = targets.map(({ candidate: _candidate, idleOnly: _idleOnly, ...rest }): StorageWorktree => rest)
    const managedBytes = targets.filter((target) => target.kind !== "external").reduce((sum, target) => sum + target.bytes, 0)
    const found = scope.artifacts ? await artifacts(targets, idleDays, signal) : undefined
    return {
      worktrees,
      totalBytes: worktrees.reduce((sum, item) => sum + item.bytes, 0),
      removableBytes: worktrees.filter((item) => item.removable).reduce((sum, item) => sum + item.bytes, 0),
      trashBytes: await trashBytes(mode, signal),
      loopBytes: await loopBytes(mode, signal),
      managedBytes,
      ...(targets.some((target) => target.bytesKnown === false) ? { unmeasured: targets.filter((target) => target.bytesKnown === false).length } : {}),
      ...(scope.capBytes ? { capBytes: scope.capBytes } : {}),
      ...(found ? { artifacts: found, artifactBytes: found.reduce((sum, item) => sum + item.bytes, 0) } : {}),
    }
  }

  async function removeArtifact(item: StorageArtifact): Promise<boolean> {
    const full = path.resolve(item.directory, item.path)
    if (!full.startsWith(`${path.resolve(item.directory)}${path.sep}`)) return false
    try {
      const stat = lstatSync(full)
      if (item.kind === "bun-build" ? !stat.isFile() || input.now() - stat.mtimeMs <= STALE_BUN_BUILD_MS : !stat.isDirectory()) return false
      rmSync(full, { recursive: true, force: true })
      return true
    } catch { return false }
  }

  /**
   * Removes what `report` marks removable (and trash older than the window). `dryRun` only counts. `artifacts` removes
   * heavy ignored output instead and never a worktree; `external` also covers worktrees MendCode did not make; `capBytes`
   * frees idle-only worktrees until the managed ones fit.
   */
  function clean(options: WorktreeScope & { idleDays?: number; dryRun?: boolean; signal?: AbortSignal }) {
    // A preview is read-only and can be shared; a real clean runs once and checks the signal only between worktrees.
    if (!options.dryRun) return cleanNow(options, options.signal)
    const { signal, ...rest } = options
    return share(`clean:${JSON.stringify(rest)}`, (own) => cleanNow(rest, own), signal)
  }

  async function cleanNow(options: WorktreeScope & { idleDays?: number; dryRun?: boolean }, signal?: AbortSignal) {
    const idleDays = options.idleDays ?? DEFAULT_WORKTREE_IDLE_DAYS
    const targets = await scan(idleDays, options, signal)
    let removed = 0
    let bytes = 0
    if (options.artifacts) {
      for (const item of await artifacts(targets, idleDays, signal)) {
        if (signal?.aborted) break
        if (!options.dryRun && !await removeArtifact(item)) continue
        removed++
        bytes += item.bytes
      }
      return { removed, bytes }
    }
    if (options.capBytes) await sizeTargets(targets.filter((target) => target.kind !== "external"), signal)
    enforceCap(targets, options.capBytes)
    // Only what goes is measured, for the total.
    await sizeTargets(targets.filter((target) => target.removable), signal)
    for (const target of targets) {
      if (signal?.aborted) return { removed, bytes }
      if (!target.removable) continue
      const { candidate } = target
      if (!options.dryRun) {
        // git runs without the signal: a removal that has started finishes whole.
        if (target.state === "missing") await projectGit(candidate.repo, ["worktree", "prune"]).catch(() => undefined)
        else {
          const gone = await projectGit(candidate.repo, ["worktree", "remove", target.directory], undefined, 180_000, REMOVE_TIMEOUT_MS).catch(() => undefined)
          // git refuses unclean work itself: whatever it keeps was not safe to remove.
          if (!gone?.ok || existsSync(target.directory)) continue
          if (target.branch) await projectGit(candidate.repo, ["branch", "-d", "--", target.branch]).catch(() => undefined)
        }
        if (candidate.project) input.forget(candidate.project, target.directory)
      }
      removed++
      bytes += target.bytes
    }
    const cutoff = input.now() - idleDays * DAY_MS
    for (const entry of trashEntries()) {
      if (entry.mtimeMs > cutoff) continue
      bytes += (await measured(entry.file, signal).catch(() => undefined)) ?? 0
      if (!options.dryRun) rmSync(entry.file, { recursive: true, force: true })
      removed++
    }
    return { removed, bytes }
  }

  return { report, clean, trashBytes, managedBytes, treeBytes }
}

export type WorktreeGc = ReturnType<typeof createWorktreeGc>
