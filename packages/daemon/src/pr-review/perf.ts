import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync } from "node:fs"
import path from "node:path"
import type { PrFinding } from "@mendcode/protocol"
import type { GitRun, ReviewContext } from "./context"
import { findingId } from "./findings"

/**
 * The cost phase of a review of the MendCode repository itself (docs/pr-review.md, "Performance of MendCode's own pull requests").
 * The owner's no-regressions rule: a change may hold, store, spend or ship less, never more. The review model reads and does not
 * build, so the daemon runs `scripts/perf-attrib.ts` (base against head, on the offline faux engine, no model and no login) as a
 * separate subprocess before the model pass, and hands the table to the model as input and to the review's body. It costs the model
 * only the table's text. It never blocks a review: a timeout or an error is a line in the review saying why nothing was measured.
 *
 * It runs only when the checkout is MendCode (a root package named `mendcode` that holds `scripts/perf-attrib.ts`), the diff
 * touches code that can change what MendCode costs (not docs or tests alone), and the PR's head is in the repository itself (the
 * build and the measured binary run the head's code). `prReview.perfAttrib: false` turns it off.
 */

export const PERF_TIMEOUT_MS = 20 * 60_000
/** Built binaries kept per commit: about 70 MB each, so the cache holds two reviews' base and head. */
export const PERF_CACHE_KEEP = 2
export const PERF_CACHE_MAX_AGE_MS = 3 * 24 * 60 * 60_000
const OUTPUT_LIMIT = 64 * 1024

export type PerfRunInput = { directory: string; base: string; head: string; cacheDir: string; tmpDir: string; timeoutMs: number }
export type PerfRunResult = { code: number | null; out: string; err: string; timedOut: boolean }
/** Runs `scripts/perf-attrib.ts` for one pair of commits; tests stand in a fake. */
export type PerfRunner = (input: PerfRunInput) => Promise<PerfRunResult>

export type PerfOptions = {
  /** Where the cached builds and the scratch directories live (`<data dir>/pr-review/perf`). */
  dir: string
  run?: PerfRunner | undefined
  timeoutMs?: number | undefined
  now?: () => number
  /** Whether `bun` can be found; tests pin it. */
  hasBun?: () => boolean
}

export type PerfOutcome =
  | { status: "measured"; rose: boolean; markdown: string; verdict: string; base: string; head: string }
  | { status: "not-measured"; reason: string }

/** The checkout is the MendCode repository: its monorepo root and the attribution script are there. */
export function isMendCodeCheckout(directory: string): boolean {
  try {
    const manifest = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8")) as { name?: unknown }
    return manifest.name === "mendcode" && existsSync(path.join(directory, "scripts", "perf-attrib.ts"))
  } catch { return false }
}

const TEST_OR_DOC = /(^|\/)(test|tests|__tests__|fixtures|docs|task-evidence|specs|examples|benchmarks)\/|\.(test|spec)\.[cm]?[jt]sx?$|\.mdx?$/
const COSTLY = /^(apps|packages|features)\/|^(package\.json|bun\.lock|pnpm-lock\.yaml|bunfig\.toml)$|^scripts\/build/
/** Code that can change start-up, a turn, a frame, a stored row, the install size or the memory: not docs, tests or fixtures alone. */
export const canAffectCost = (file: string) => COSTLY.test(file) && !TEST_OR_DOC.test(file)

/** The files the whole PR changes (merge base to head), whatever range this review looks at. */
async function pullRequestFiles({ git, directory, base, head }: { git: GitRun; directory: string; base: string; head: string }): Promise<{ files: string[]; from: string } | undefined> {
  const merged = await git(["merge-base", base, head], directory)
  const from = merged.code === 0 && /^[0-9a-f]{40}$/.test(merged.out.trim()) ? merged.out.trim() : base
  const listed = await git(["diff", "--name-only", "--no-renames", from, head, "--"], directory)
  return listed.code === 0 ? { files: listed.out.split("\n").map((line) => line.trim()).filter(Boolean), from } : undefined
}

/** The line that says why: an `error:` line when there is one (bun ends an uncaught error with its version, which says nothing), else the last. */
const firstLine = (text: string) => {
  const lines = text.split("\n").map((line) => line.trim()).filter((line) => line && !/^Bun v\d+\.\d+\.\d+ \(/.test(line))
  return (lines.findLast((line) => /^(error|\w*Error)\b/.test(line)) ?? lines.at(-1))?.slice(0, 200)
}

/** The run's result as an outcome: the markdown and its verdict, or why the table does not exist. */
export function perfOutcome({ result, from, head, timeoutMs }: { result: PerfRunResult; from: string; head: string; timeoutMs: number }): PerfOutcome {
  if (result.timedOut) return { status: "not-measured", reason: `perf-attrib did not finish in ${Math.round(timeoutMs / 60_000)} minutes` }
  const markdown = result.out.trim()
  const headline = /^\*\*perf-attrib: (.*)\*\*$/m.exec(markdown)?.[1]
  // Exit 0: nothing rose (same or lower). Exit 1: a metric rose above the measured noise. Anything else is the script failing.
  if ((result.code === 0 || result.code === 1) && headline) return { status: "measured", rose: result.code === 1, markdown, verdict: headline, base: from, head }
  const why = firstLine(result.err) ?? firstLine(result.out)
  return { status: "not-measured", reason: `perf-attrib failed${result.code === null ? "" : ` (exit ${result.code})`}${why ? `: ${why}` : ""}` }
}

/** Removes stale partial builds and old binaries, then all but the newest `PERF_CACHE_KEEP`. Never throws. */
export function pruneCache({ cacheDir, now, keep = PERF_CACHE_KEEP, maxAgeMs = PERF_CACHE_MAX_AGE_MS }: { cacheDir: string; now: number; keep?: number; maxAgeMs?: number }) {
  try {
    const entries = readdirSync(cacheDir).flatMap((name) => { try { return [{ name, file: path.join(cacheDir, name), time: statSync(path.join(cacheDir, name)).mtimeMs }] } catch { return [] } })
    const partial = entries.filter((entry) => entry.name.includes(".part-"))
    const builds = entries.filter((entry) => !entry.name.includes(".part-")).sort((a, b) => b.time - a.time)
    for (const entry of partial) if (now - entry.time > 60 * 60_000) rmSync(entry.file, { force: true })
    for (const [index, entry] of builds.entries()) if (index >= keep || now - entry.time > maxAgeMs) rmSync(entry.file, { force: true })
  } catch { /* a cache that cannot be read is rebuilt */ }
}

/** Marks the builds of these commits as just used, so eviction keeps the newest work. */
function touchBuilds({ cacheDir, commits, now }: { cacheDir: string; commits: readonly string[]; now: number }) {
  try {
    const stamp = new Date(now)
    for (const name of readdirSync(cacheDir)) if (!name.includes(".part-") && commits.some((commit) => name.startsWith(`${commit}-`))) utimesSync(path.join(cacheDir, name), stamp, stamp)
  } catch { /* eviction then follows the build time */ }
}

/**
 * The cost table of this PR, or undefined when the phase does not apply (not MendCode, nothing that can change cost, a fork).
 * A phase that applies but cannot produce a table says so (`not-measured`); this never throws.
 */
export async function measurePerf({ directory, base, head, git, options, fork = false }: { directory: string; base: string; head: string; git: GitRun; options: PerfOptions; fork?: boolean }): Promise<PerfOutcome | undefined> {
  try {
    if (!isMendCodeCheckout(directory)) return undefined
    const changed = await pullRequestFiles({ git, directory, base, head })
    if (!changed || !changed.files.some(canAffectCost)) return undefined
    if (fork) return { status: "not-measured", reason: "the head is in a fork, and measuring it would build and run the fork's code on this machine" }
    const hasBun = options.hasBun ?? (() => !!Bun.which("bun"))
    if (!options.run && !hasBun()) return { status: "not-measured", reason: "bun is not installed on this machine, and perf-attrib runs on it" }
    const now = options.now ?? Date.now
    const cacheDir = path.join(options.dir, "cache")
    mkdirSync(cacheDir, { recursive: true, mode: 0o700 })
    pruneCache({ cacheDir, now: now() })
    mkdirSync(path.join(options.dir, "tmp"), { recursive: true, mode: 0o700 })
    const tmpDir = mkdtempSync(path.join(options.dir, "tmp", "run-"))
    const timeoutMs = options.timeoutMs ?? PERF_TIMEOUT_MS
    try {
      const result = await (options.run ?? perfAttribProcess)({ directory, base: changed.from, head, cacheDir, tmpDir, timeoutMs })
      touchBuilds({ cacheDir, commits: [changed.from, head], now: now() })
      pruneCache({ cacheDir, now: now() })
      return perfOutcome({ result, from: changed.from, head, timeoutMs })
    } finally { rmSync(tmpDir, { recursive: true, force: true }) }
  } catch (error) {
    return { status: "not-measured", reason: `perf-attrib could not run: ${(error instanceof Error ? error.message : String(error)).slice(0, 200)}` }
  }
}

/**
 * The real runner: `bun scripts/perf-attrib.ts --base BASE --cand HEAD --markdown --cache DIR` from the PR's checkout, in a process
 * group of its own (a timeout kills the daemon and terminal processes the script started too), with a scratch directory under
 * the reviewer's data and an environment of its own: no tokens, no API keys.
 */
export const perfAttribProcess: PerfRunner = async ({ directory, base, head, cacheDir, tmpDir, timeoutMs }) => {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: tmpDir, CI: "1" }
  for (const name of ["HOME", "BUN_INSTALL", "LANG"]) if (process.env[name]) env[name] = process.env[name]!
  // A review checkout has no dependencies installed, and the script imports the workspace packages: without them it stops at its
  // first import (exit 1, "Cannot find module"). They are installed from the lockfile, as the script does for each build, and
  // removed afterwards so the checkout keeps no extra weight on disk.
  const modules = path.join(directory, "node_modules")
  const installed = !existsSync(modules)
  const started = Date.now()
  try {
    if (installed) {
      const install = await runBun({ argv: ["install", "--frozen-lockfile"], directory, env, timeoutMs })
      if (install.timedOut || install.code !== 0) return { ...install, out: "", err: `dependencies could not be installed (bun install --frozen-lockfile, exit ${install.code ?? "none"}): ${firstLine(install.err) ?? ""}` }
    }
    return await runBun({ argv: ["scripts/perf-attrib.ts", "--base", base, "--cand", head, "--markdown", "--cache", cacheDir], directory, env, timeoutMs: Math.max(1_000, timeoutMs - (Date.now() - started)) })
  } finally { if (installed) rmSync(modules, { recursive: true, force: true }) }
}

/** One `bun` process in a group of its own, killed with everything it started when the time runs out. */
const runBun = ({ argv, directory, env, timeoutMs }: { argv: string[]; directory: string; env: Record<string, string>; timeoutMs: number }) => new Promise<PerfRunResult>((resolve) => {
  const child = spawn("bun", argv, { cwd: directory, env, detached: true, stdio: ["ignore", "pipe", "pipe"] })
  let out = ""
  let err = ""
  let timedOut = false
  const stop = () => { try { if (child.pid) process.kill(-child.pid, "SIGKILL") } catch { /* already gone */ } }
  const timer = setTimeout(() => { timedOut = true; stop() }, timeoutMs)
  child.stdout.on("data", (chunk: Buffer) => { if (out.length < OUTPUT_LIMIT) out += chunk.toString() })
  child.stderr.on("data", (chunk: Buffer) => { err = (err + chunk.toString()).slice(-8 * 1024) })
  child.on("error", (error) => { clearTimeout(timer); resolve({ code: null, out, err: error.message, timedOut }) })
  child.on("close", (code) => { clearTimeout(timer); stop(); resolve({ code, out, err, timedOut }) })
})

// ── What the review does with the outcome ───────────────────────────────────────────────────────────────────────────────

const RULE = "MendCode's no-regressions rule: a change may hold, store, spend or ship less, never more. A difference within the measured noise is no difference."

/** The model's input: the table (or the absence of one) and the rule it applies. The model builds and runs nothing. */
export function perfPrompt(outcome: PerfOutcome): string {
  if (outcome.status === "measured") {
    return [
      "This is a pull request of the MendCode repository. Its cost was measured for you (the daemon ran scripts/perf-attrib.ts, base against head, on the offline faux engine); do not build or run anything yourself.",
      `${RULE} A measured rise above the noise is reported as a critical finding by the system: do not report it again. Use the table when a finding is about start-up, per-turn or per-frame work, a timer, a stored row or column, a dependency or an embedded asset; cite its numbers.`,
      "<perf_attrib>", outcome.markdown, "</perf_attrib>",
    ].join("\n")
  }
  return [
    "This is a pull request of the MendCode repository. Its cost was NOT measured (see Notes).",
    `${RULE} If this change adds start-up work, per-turn or per-frame work, a timer, a stored row or column, a dependency or an embedded asset and the pull request gives no before/after numbers, report a major performance finding that asks for them.`,
  ].join("\n")
}

/** The review's body: the table under the details, and a line in the notes when there is none. */
export const perfBody = (outcome: PerfOutcome) => outcome.status === "measured" ? `**Performance (perf-attrib, base ${outcome.base.slice(0, 12)} against head ${outcome.head.slice(0, 12)})**\n\n${outcome.markdown}` : undefined
export const perfNote = (outcome: PerfOutcome) => outcome.status === "not-measured" ? `Performance was not measured: ${outcome.reason}.` : undefined

/**
 * The finding for a measured rise (critical: a rise the owner did not approve is a blocker, the same as a failing test). It sits on
 * the first changed line of the first file that can change cost, so it shows inline; undefined when the diff shows no such line.
 */
export function perfFinding({ outcome, context }: { outcome: PerfOutcome; context: ReviewContext }): PrFinding | undefined {
  if (outcome.status !== "measured" || !outcome.rose) return undefined
  const file = context.files.find((entry) => !entry.deleted && canAffectCost(entry.path) && (entry.touched[0] !== undefined || entry.right.size)) ?? context.files.find((entry) => !entry.deleted && (entry.touched[0] !== undefined || entry.right.size))
  if (!file) return undefined
  const line = file.touched[0] ?? Math.min(...file.right)
  const metrics = outcome.verdict.replace(/^sube:\s*/, "").split(/\.\s*Causes:/)[0]!.trim()
  const summary = `Measured rise above the noise: ${metrics}`.slice(0, 160)
  const detail = `perf-attrib measured this pull request (base ${outcome.base.slice(0, 12)}, head ${outcome.head.slice(0, 12)}) and ${outcome.verdict.slice(0, 700)}. A measured rise without the owner's approval is a blocker: remove the cost, or get the owner to approve this number. The full table is in the review details.`.slice(0, 1200)
  return { id: findingId({ path: file.path, line, category: "performance", summary }), path: file.path, line, side: "RIGHT", severity: "critical", category: "performance", summary, detail, evidence: [`${file.path}:${line}`], verdict: "confirmed" }
}
