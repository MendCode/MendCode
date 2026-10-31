// Efficiency benchmark of the PR review repo watch (docs/pr-review.md, R11): what the watch costs at rest and under a burst of pushes.
//   bun scripts/bench-pr-review.ts [--repos 10] [--prs 30] [--idle-ticks 20] [--interval-ms 500] [--pushes 20] [--job-ms 1500]
//                                  [--gh process|inproc] [--base 9e41b080 | --no-base] [--json]
// No network and nothing of the user's: `gh` is a fake (a shell script on PATH that the watch's real `ghProcess` spawns, or an
// in-process function with `--gh inproc`), the data directory is a temp dir, the review "job" is a sleep, not a model call.
// The same harness runs against this worktree's `repo-watch.ts` and against the base commit's, exported read-only with
// `git archive` into a temp dir (the worktree is never touched). Each target runs in its own child process so memory is its own.
//
// Time: the watch polls on a short real interval (`--interval-ms`) instead of the production 60 s, and its injected clock runs
// 60 s per real interval, so cooldowns and backoffs see production-like time. Figures per tick are figures per minute in
// production (one poll a minute); absolute latencies are in real ms at the short interval, and also in ticks.
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const ROOT = path.join(import.meta.dir, "..")
const CURRENT_SRC = path.join(ROOT, "packages/daemon/src")
const PRODUCTION_INTERVAL_MS = 60_000

type Options = { repos: number; prs: number; idleTicks: number; intervalMs: number; pushes: number; jobMs: number; gh: "process" | "inproc"; base: string | undefined; json: boolean }

function parseArgs(argv: readonly string[]): Options & { child?: { src: string; label: string } } {
  const value = (name: string) => { const at = argv.indexOf(name); return at >= 0 ? argv[at + 1] : undefined }
  const int = (name: string, fallback: number) => { const raw = value(name); const parsed = raw === undefined ? fallback : Number(raw); if (!Number.isInteger(parsed) || parsed < 0) throw new RangeError(`[BENCH]: ${name} must be a non-negative integer`); return parsed }
  const gh = value("--gh") ?? "process"
  if (gh !== "process" && gh !== "inproc") throw new RangeError("[BENCH]: --gh is process or inproc")
  const src = value("--src")
  return {
    repos: int("--repos", 10), prs: int("--prs", 30), idleTicks: int("--idle-ticks", 20), intervalMs: Math.max(50, int("--interval-ms", 500)), pushes: int("--pushes", 20), jobMs: int("--job-ms", 1_500),
    gh, base: argv.includes("--no-base") ? undefined : value("--base") ?? "9e41b080", json: argv.includes("--json"),
    ...(argv.includes("--child") && src ? { child: { src, label: value("--label") ?? "target" } } : {}),
  }
}

// ── Child: one target ─────────────────────────────────────────────────────────────────────────────────────────────────────

type GhRun = (input: { argv: string[]; cwd: string }) => Promise<{ code: number; out: string; err: string }>
type Pr = { number: number; headRefOid: string; isDraft: boolean; updatedAt: string; reviewRequests: unknown[]; assignees: unknown[]; url: string; title: string; baseRefName: string; headRefName: string; author: { login: string } }
type WatchModule = { createRepoWatch(options: Record<string, unknown>): { watchRepo(sessionId: string, directory: string): Promise<{ ok: boolean; message?: string }>; stop(): void; pending?(): { running: number; queued: number } } }
type Memory = { rssMb: number; heapMb: number }
export type PhaseResult = { realMs: number; ticks: number; cpuMs: number; cpuMsPerTick: number; timerWakeups: number; wakeupsPerTick: number; ghCalls: number; ghCallsPerRepoPerTick: number; jobsStarted: number; fileRewritesPerTick: Record<string, number> }
export type TargetResult = {
  label: string; src: string; gh: Options["gh"]; repos: number; prs: number; intervalMs: number
  memory: { beforeImport: Memory; watching: Memory; afterIdle: Memory; peakLoad: Memory; afterLoad: Memory }
  control: { cpuMs: number; realMs: number }
  idle: PhaseResult
  single: { probes: number; latencyMs: { p50: number; max: number }; latencyTicks: { p50: number; max: number } }
  load: PhaseResult & { pushes: number; peakConcurrent: number; latencyMs: { p50: number; p95: number; max: number }; latencyTicks: { p50: number; p95: number; max: number }; unstarted: number }
  dataBytes: Record<string, number>
}

const sha = (n: number) => n.toString(16).padStart(40, "0")
const mb = (bytes: number) => Math.round(bytes / 1024 / 1024 * 10) / 10
const sleep = (ms: number, timer: typeof setTimeout) => new Promise<void>((resolve) => timer(resolve, ms))
function memory(): Memory {
  Bun.gc(true)
  const used = process.memoryUsage()
  return { rssMb: mb(used.rss), heapMb: mb(used.heapUsed) }
}
const quantile = (values: readonly number[], q: number) => { if (!values.length) return Number.NaN; const sorted = values.toSorted((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]! }
const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits

async function runChild(options: Options, src: string, label: string): Promise<TargetResult> {
  // Timers the harness itself uses are the originals; the watch's go through counters.
  const realSetTimeout = globalThis.setTimeout
  const realSetInterval = globalThis.setInterval
  const realClearInterval = globalThis.clearInterval
  let wakeups = 0
  const counted = <T extends (...args: never[]) => unknown>(original: T) => ((handler: unknown, ...rest: unknown[]) => (original as unknown as (...args: unknown[]) => unknown)(typeof handler === "function" ? (...args: unknown[]) => { wakeups++; return (handler as (...args: unknown[]) => unknown)(...args) } : handler, ...rest)) as unknown as T
  globalThis.setTimeout = counted(realSetTimeout)
  globalThis.setInterval = counted(realSetInterval)

  const work = realpathSync(mkdtempSync(path.join(tmpdir(), "mc-bench-pr-")))
  const dataDir = path.join(work, "data")
  const fakeBin = path.join(work, "bin")
  mkdirSync(dataDir, { recursive: true })
  mkdirSync(fakeBin, { recursive: true })
  try {
    // The control: this process doing nothing for as long as the idle phase, so the idle figure can be read against it.
    const controlStart = process.cpuUsage()
    const controlReal = performance.now()
    await sleep(options.idleTicks * options.intervalMs, realSetTimeout)
    const control = { cpuMs: round((process.cpuUsage(controlStart).user + process.cpuUsage(controlStart).system) / 1_000), realMs: Math.round(performance.now() - controlReal) }

    const beforeImport = memory()
    const watchModule = await import(path.join(src, "pr-review/repo-watch.ts")) as WatchModule

    // The fake repositories: N directories, M open PRs each.
    const start = Date.UTC(2026, 9, 30, 9)
    const realStart = performance.now()
    const speed = PRODUCTION_INTERVAL_MS / options.intervalMs
    const now = () => Math.floor(start + (performance.now() - realStart) * speed)
    const repos = Array.from({ length: options.repos }, (_, index) => {
      const directory = path.join(work, `repo-${index}`)
      mkdirSync(directory, { recursive: true })
      const prs: Pr[] = Array.from({ length: options.prs }, (_, n) => ({ number: n + 1, headRefOid: sha(index * 100_000 + n + 1), isDraft: false, updatedAt: new Date(start).toISOString(), reviewRequests: [], assignees: [], url: `https://github.com/bench/repo-${index}/pull/${n + 1}`, title: `PR ${n + 1}`, baseRefName: "main", headRefName: `topic-${n + 1}`, author: { login: "dev" } }))
      return { directory, prs, listJson: "", calls: 0 }
    })
    const byDirectory = new Map(repos.map((repo) => [repo.directory, repo]))
    const publish = (repo: (typeof repos)[number]) => { repo.listJson = JSON.stringify(repo.prs); if (options.gh === "process") writeFileSync(path.join(repo.directory, ".bench-prs.json"), repo.listJson) }
    for (const repo of repos) publish(repo)

    let run: GhRun
    if (options.gh === "inproc") {
      run = async ({ argv, cwd }) => {
        const repo = byDirectory.get(cwd)
        if (repo) repo.calls++
        if (argv[0] === "pr" && argv[1] === "list") return { code: 0, out: repo?.listJson ?? "[]", err: "" }
        if (argv[0] === "api" && argv[1] === "user") return { code: 0, out: "bench-bot\n", err: "" }
        return { code: 0, out: "", err: "" }
      }
    } else {
      // The watch's own `ghProcess` spawning a fake `gh`: the spawn, pipes and parsing are the daemon's real per-call cost.
      const script = path.join(fakeBin, "gh")
      writeFileSync(script, `#!/bin/sh\necho x >> .bench-calls\ncase "$1 $2" in\n  "pr list") cat .bench-prs.json ;;\n  "api user") echo bench-bot ;;\nesac\nexit 0\n`, { mode: 0o755 })
      process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH ?? ""}`
      const { ghProcess } = await import(path.join(src, "pr-watch.ts")) as { ghProcess: GhRun }
      run = ghProcess
    }
    const ghCalls = () => options.gh === "inproc" ? repos.reduce((sum, repo) => sum + repo.calls, 0) : repos.reduce((sum, repo) => { try { return sum + (Bun.file(path.join(repo.directory, ".bench-calls")).size / 2) } catch { return sum } }, 0)

    // Jobs: each a sleep of `jobMs`; latency is from the push that made its head to its start.
    const pushedAt = new Map<string, number>()
    const latencies: number[] = []
    let jobsStarted = 0
    let concurrent = 0
    let peakConcurrent = 0
    const watch = watchModule.createRepoWatch({
      dir: dataDir, run, now, intervalMs: options.intervalMs, enabled: () => true,
      triggers: async () => ({ opened: true, synchronize: true, ready_for_review: true, drafts: false }),
      limits: async () => ({ cooldown: { pr_minutes: 0, repo_per_hour: 1_000_000 }, reviewers: "all" }),
      async start(job: { head: string }) {
        jobsStarted++
        const at = pushedAt.get(job.head)
        if (at !== undefined) { latencies.push(performance.now() - at); pushedAt.delete(job.head) }
        concurrent++
        peakConcurrent = Math.max(peakConcurrent, concurrent)
        await sleep(options.jobMs, realSetTimeout)
        concurrent--
      },
      notify: () => undefined, sessionExists: () => true,
    })
    for (const repo of repos) {
      const done = await watch.watchRepo("bench-session", repo.directory)
      if (!done.ok) throw new Error(`[BENCH]: watchRepo ${repo.directory}: ${done.message ?? "refused"}`)
    }
    await sleep(2 * options.intervalMs, realSetTimeout)
    const watching = memory()

    async function phase(ticks: number, sample?: () => void): Promise<PhaseResult> {
      const calls0 = ghCalls()
      const wake0 = wakeups
      const jobs0 = jobsStarted
      const inodes = new Map<string, Set<number>>()
      // Each save is a temp file renamed over the old one: a new inode is a rewrite. Sampled 4× a tick, so it is a lower bound.
      const sampleFiles = () => { for (const name of ["watches.json", "jobs.json"]) { try { const ino = statSync(path.join(dataDir, "pr-review", name)).ino; const seen = inodes.get(name) ?? new Set(); seen.add(ino); inodes.set(name, seen) } catch { /* not written yet */ } } }
      sampleFiles()
      const cpu0 = process.cpuUsage()
      const real0 = performance.now()
      const sampler = realSetInterval(() => { sampleFiles(); sample?.() }, Math.max(25, options.intervalMs / 4))
      await sleep(ticks * options.intervalMs, realSetTimeout)
      realClearInterval(sampler)
      const cpu = process.cpuUsage(cpu0)
      const realMs = performance.now() - real0
      sampleFiles()
      const calls = ghCalls() - calls0
      const observedTicks = realMs / options.intervalMs
      const cpuMs = (cpu.user + cpu.system) / 1_000
      const rewrites = Object.fromEntries([...inodes].map(([name, seen]) => [name, round((seen.size - 1) / observedTicks, 2)]))
      return { realMs: Math.round(realMs), ticks: round(observedTicks), cpuMs: round(cpuMs), cpuMsPerTick: round(cpuMs / observedTicks, 2), timerWakeups: wakeups - wake0, wakeupsPerTick: round((wakeups - wake0) / observedTicks, 2), ghCalls: calls, ghCallsPerRepoPerTick: round(calls / options.repos / observedTicks, 2), jobsStarted: jobsStarted - jobs0, fileRewritesPerTick: rewrites }
    }

    const idle = await phase(options.idleTicks)
    const afterIdle = memory()

    // One push at a time, nothing queued: the latency of a head change alone (the poll interval plus the start), at staggered offsets in the tick.
    const single: number[] = []
    for (let probe = 0; probe < 5; probe++) {
      await sleep(Math.round(options.intervalMs * (0.15 + probe * 0.17)), realSetTimeout)
      const repo = repos[probe % repos.length]!
      const pr = repo.prs[probe % repo.prs.length]!
      pr.headRefOid = sha(8_000_000 + probe)
      pr.updatedAt = new Date(now()).toISOString()
      pushedAt.set(pr.headRefOid, performance.now())
      publish(repo)
      const before = latencies.length
      const deadline = performance.now() + 4 * options.intervalMs + options.jobMs
      while (latencies.length === before && performance.now() < deadline) await sleep(10, realSetTimeout)
      if (latencies.length > before) single.push(latencies.pop()!)
      await sleep(options.jobMs + options.intervalMs, realSetTimeout)
    }

    // The burst: K pushes at once across the repositories, then enough ticks for the queue to drain.
    let peak = { rssMb: 0, heapMb: 0 }
    const sample = () => { const used = process.memoryUsage(); peak = { rssMb: Math.max(peak.rssMb, mb(used.rss)), heapMb: Math.max(peak.heapMb, mb(used.heapUsed)) } }
    for (let k = 0; k < options.pushes; k++) {
      const repo = repos[k % repos.length]!
      const pr = repo.prs[(k * 7) % repo.prs.length]!
      pr.headRefOid = sha(9_000_000 + k)
      pr.updatedAt = new Date(now()).toISOString()
      pushedAt.set(pr.headRefOid, performance.now())
    }
    for (const repo of repos) publish(repo)
    const concurrency = 2
    const loadTicks = Math.ceil(2 + options.pushes / concurrency * options.jobMs / options.intervalMs + 2)
    const load = await phase(loadTicks, sample)
    const afterLoad = memory()
    watch.stop()

    const dataBytes: Record<string, number> = {}
    const prDir = path.join(dataDir, "pr-review")
    for (const name of (() => { try { return readdirSync(prDir) } catch { return [] } })()) dataBytes[name] = statSync(path.join(prDir, name)).size
    const lat = { p50: quantile(latencies, 0.5), p95: quantile(latencies, 0.95), max: latencies.length ? Math.max(...latencies) : Number.NaN }
    return {
      label, src, gh: options.gh, repos: options.repos, prs: options.prs, intervalMs: options.intervalMs,
      memory: { beforeImport, watching, afterIdle, peakLoad: peak, afterLoad }, control, idle,
      single: { probes: single.length, latencyMs: { p50: Math.round(quantile(single, 0.5)), max: Math.round(single.length ? Math.max(...single) : Number.NaN) }, latencyTicks: { p50: round(quantile(single, 0.5) / options.intervalMs, 2), max: round((single.length ? Math.max(...single) : Number.NaN) / options.intervalMs, 2) } },
      load: { ...load, pushes: options.pushes, peakConcurrent, latencyMs: { p50: Math.round(lat.p50), p95: Math.round(lat.p95), max: Math.round(lat.max) }, latencyTicks: { p50: round(lat.p50 / options.intervalMs, 2), p95: round(lat.p95 / options.intervalMs, 2), max: round(lat.max / options.intervalMs, 2) }, unstarted: pushedAt.size },
      dataBytes,
    }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

// ── Parent: export the baseline, run both targets, report ─────────────────────────────────────────────────────────────────

/** The base commit's daemon sources, exported read-only (`git archive`), resolving packages through this checkout's node_modules. */
async function exportBase(rev: string): Promise<{ src: string; cleanup(): void }> {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mc-bench-base-")))
  const archive = Bun.spawn(["git", "archive", rev, "packages/daemon/src"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" })
  const tar = Bun.spawn(["tar", "-x", "-C", dir], { stdin: archive.stdout, stdout: "ignore", stderr: "pipe" })
  const [archiveCode, tarCode, err] = await Promise.all([archive.exited, tar.exited, new Response(archive.stderr).text()])
  if (archiveCode !== 0 || tarCode !== 0) throw new Error(`[BENCH]: git archive ${rev} failed: ${err.slice(0, 300)}`)
  symlinkSync(path.join(ROOT, "packages/daemon/node_modules"), path.join(dir, "packages/daemon/node_modules"))
  symlinkSync(path.join(ROOT, "node_modules"), path.join(dir, "node_modules"))
  return { src: path.join(dir, "packages/daemon/src"), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

async function runTarget(options: Options, src: string, label: string): Promise<TargetResult> {
  const args = [process.execPath, import.meta.path, "--child", "--src", src, "--label", label, "--repos", String(options.repos), "--prs", String(options.prs), "--idle-ticks", String(options.idleTicks), "--interval-ms", String(options.intervalMs), "--pushes", String(options.pushes), "--job-ms", String(options.jobMs), "--gh", options.gh]
  const child = Bun.spawn(args, { cwd: ROOT, stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(`[BENCH]: ${label} exited ${code}: ${err.slice(-800)}`)
  const line = out.trim().split("\n").at(-1) ?? ""
  return JSON.parse(line) as TargetResult
}

function report(results: readonly TargetResult[]) {
  const rows: Array<[string, (result: TargetResult) => string]> = [
    ["control: idle process CPU (ms over the idle phase)", (r) => `${r.control.cpuMs} / ${r.control.realMs} ms`],
    ["idle: CPU ms per tick (= per production minute)", (r) => String(r.idle.cpuMsPerTick)],
    ["idle: timer wakeups per tick", (r) => String(r.idle.wakeupsPerTick)],
    ["idle: gh calls per repo per tick", (r) => String(r.idle.ghCallsPerRepoPerTick)],
    ["idle: jobs started", (r) => String(r.idle.jobsStarted)],
    ["idle: data file rewrites per tick (>=)", (r) => Object.entries(r.idle.fileRewritesPerTick).map(([name, n]) => `${name.replace(".json", "")} ${n}`).join(", ") || "none"],
    ["one push alone -> job start p50 / max (ms)", (r) => `${r.single.latencyMs.p50} / ${r.single.latencyMs.max} (${r.single.probes} probes)`],
    ["one push alone -> job start p50 / max (ticks)", (r) => `${r.single.latencyTicks.p50} / ${r.single.latencyTicks.max}`],
    ["RSS / heap before import (MB)", (r) => `${r.memory.beforeImport.rssMb} / ${r.memory.beforeImport.heapMb}`],
    ["RSS / heap watching, after GC (MB)", (r) => `${r.memory.watching.rssMb} / ${r.memory.watching.heapMb}`],
    ["RSS / heap after idle, after GC (MB)", (r) => `${r.memory.afterIdle.rssMb} / ${r.memory.afterIdle.heapMb}`],
    ["load: peak RSS / heap (MB)", (r) => `${r.memory.peakLoad.rssMb} / ${r.memory.peakLoad.heapMb}`],
    ["load: RSS / heap after, after GC (MB)", (r) => `${r.memory.afterLoad.rssMb} / ${r.memory.afterLoad.heapMb}`],
    ["load: CPU ms per tick", (r) => String(r.load.cpuMsPerTick)],
    ["load: timer wakeups per tick", (r) => String(r.load.wakeupsPerTick)],
    ["load: gh calls per repo per tick", (r) => String(r.load.ghCallsPerRepoPerTick)],
    ["load: jobs started / pushes / never started", (r) => `${r.load.jobsStarted} / ${r.load.pushes} / ${r.load.unstarted}`],
    ["load: peak concurrent jobs", (r) => String(r.load.peakConcurrent)],
    ["load: data file rewrites per tick (>=)", (r) => Object.entries(r.load.fileRewritesPerTick).map(([name, n]) => `${name.replace(".json", "")} ${n}`).join(", ") || "none"],
    ["burst: push -> job start p50 / p95 / max (ms)", (r) => `${r.load.latencyMs.p50} / ${r.load.latencyMs.p95} / ${r.load.latencyMs.max}`],
    ["burst: push -> job start p50 / p95 / max (ticks)", (r) => `${r.load.latencyTicks.p50} / ${r.load.latencyTicks.p95} / ${r.load.latencyTicks.max}`],
    ["data files (bytes)", (r) => Object.entries(r.dataBytes).map(([name, size]) => `${name} ${size}`).join(", ") || "none"],
  ]
  const width = Math.max(...rows.map(([name]) => name.length))
  const first = results[0]!
  console.log(`repo watch bench · ${first.repos} repos × ${first.prs} open PRs · interval ${first.intervalMs} ms real (clock 60 s per tick) · gh ${first.gh} · ${process.platform}/${process.arch} · bun ${Bun.version}`)
  console.log(`${"".padEnd(width)}  ${results.map((r) => r.label.padEnd(30)).join("")}`)
  for (const [name, cell] of rows) console.log(`${name.padEnd(width)}  ${results.map((r) => cell(r).padEnd(30)).join("")}`)
}

if (import.meta.main) {
  const options = parseArgs(process.argv.slice(2))
  if (options.child) {
    const result = await runChild(options, options.child.src, options.child.label)
    console.log(JSON.stringify(result))
    process.exit(0)
  }
  const results: TargetResult[] = []
  results.push(await runTarget(options, CURRENT_SRC, "worktree"))
  if (options.base) {
    const base = await exportBase(options.base)
    try { results.push(await runTarget(options, base.src, `base ${options.base}`)) } finally { base.cleanup() }
  }
  if (options.json) console.log(JSON.stringify(results, null, 2))
  else report(results)
}
