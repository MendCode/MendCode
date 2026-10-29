/**
 * PR-reviewer eval (README.md): runs the product's review and verify passes (packages/daemon/src/pr-review, T2 and T3) over
 * seeded-bug and clean pull requests, through a real daemon on a temp data dir, and scores what it would publish.
 *
 *   bun .agents/evals/pr-review/run.ts --dry-run                  # check the cases; no daemon, no model
 *   bun .agents/evals/pr-review/run.ts --self-test                # the scoring end to end with a scripted reviewer; no model
 *   bun .agents/evals/pr-review/run.ts --reps 3 --model gpt-6-luna --auth-from ~/.codex --data-dir /tmp/mcpr-data --out /tmp/mcpr-out
 *
 * Tokens are only the provider-reported `usage.recorded` events; a run with none is reported as unreadable, never estimated.
 */
import { spawn, type ChildProcess } from "node:child_process"
import { closeSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, writeFileSync, appendFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient, type Client } from "@mendcode/client"
import { createIndexer } from "../../../packages/codegraph/src/index"
import type { PrFinding, SessionEvent, SessionId } from "@mendcode/protocol"
import { buildReviewContext, gitRun } from "../../../packages/daemon/src/pr-review/context"
import { reviewPullRequest, type ReviewProfile, type ReviewSessionFactory } from "../../../packages/daemon/src/pr-review/engine"
import { linkAuth } from "../harness/adapters/common"
import { MENDCODE_EVAL_ENV } from "../harness/adapters/mendcode-settings"
import { cleanEnv } from "../harness/lib/env"
import { assertSafeStateRoot } from "../harness/lib/safety"
import { CLEAN } from "./cases/clean"
import { SEEDED } from "./cases/seeded"
import type { PrCase } from "./cases/types"

const REPO_ROOT = path.resolve(import.meta.dir, "../../..")
export const CASES: PrCase[] = [...SEEDED, ...CLEAN]
/** A finding counts for a seeded defect on the same file within this many lines. */
export const LINE_TOLERANCE = 2
const FORBIDDEN_MODEL = /claude|anthropic|opus|sonnet|haiku|fable/i

type Tokens = { input: number; uncached: number; output: number; events: number }
type Scored = { path: string; line: number; severity: string; category: string; verdict?: string | undefined; matched?: number }
export type CaseRun = { case: string; clean: boolean; profile: ReviewProfile; rep: number; status: "ok" | "timeout" | "failed"; error?: string; findings: Scored[]; candidates: number; verified: boolean; tokens: Tokens; ms: number }

// ---------- arguments ----------

function args(argv = process.argv.slice(2)) {
  const value = (name: string) => { const index = argv.indexOf(`--${name}`); return index >= 0 ? argv[index + 1] : undefined }
  const flag = (name: string) => argv.includes(`--${name}`)
  return {
    dryRun: flag("dry-run"), selfTest: flag("self-test"),
    reps: Number(value("reps") ?? 3), model: value("model"), effort: value("effort") ?? "medium",
    profiles: (value("profiles") ?? "normal").split(",") as ReviewProfile[],
    cases: value("cases")?.split(","), out: value("out"), dataDir: value("data-dir"), authFrom: value("auth-from"),
    timeoutMs: Number(value("timeout-ms") ?? 10 * 60_000),
  }
}

// ---------- cases ----------

/** A git repository at the case's head with the base as its parent commit. */
async function caseRepo(item: PrCase, root: string) {
  const dir = mkdtempSync(path.join(root, `${item.id}-`))
  const git = async (...argv: string[]) => { const done = await gitRun(["-c", "user.name=eval", "-c", "user.email=eval@example.invalid", "-c", "commit.gpgsign=false", ...argv], dir); if (done.code) throw new Error(`[EVAL]: git ${argv.join(" ")} failed in ${item.id}`); return done.out.trim() }
  const write = (files: Record<string, string | null>) => { for (const [file, text] of Object.entries(files)) { const target = path.join(dir, file); if (text === null) rmSync(target, { force: true }); else { mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, text) } } }
  await git("init", "-q", "-b", "main")
  write(item.base)
  await git("add", "-A")
  await git("commit", "-q", "-m", "base")
  const base = await git("rev-parse", "HEAD")
  write(item.head)
  await git("add", "-A")
  await git("commit", "-q", "-m", item.title)
  return { dir, base, head: await git("rev-parse", "HEAD") }
}

/** Every seeded line must be one the diff adds; a clean case seeds none. Returns the problems. */
export async function checkCases(cases: readonly PrCase[], root: string): Promise<string[]> {
  const problems: string[] = []
  const ids = new Set<string>()
  for (const item of cases) {
    if (ids.has(item.id)) problems.push(`${item.id}: duplicate id`)
    ids.add(item.id)
    const repo = await caseRepo(item, root)
    const context = await buildReviewContext({ directory: repo.dir, base: repo.base, head: repo.head, budgetTokens: 200_000 })
    for (const defect of item.defects) {
      const file = context.files.find((entry) => entry.path === defect.path)
      if (!file) problems.push(`${item.id}: ${defect.path} is not in the diff`)
      else if (!file.right.has(defect.line)) problems.push(`${item.id}: ${defect.path}:${defect.line} is not an added line (added: ${[...file.right].join(", ")})`)
    }
    if (!context.files.length) problems.push(`${item.id}: empty diff`)
  }
  return problems
}

// ---------- scoring ----------

/** Marks each finding with the index of the defect it hits (same file, within `LINE_TOLERANCE`), each defect at most once. */
export function score(item: PrCase, findings: readonly Pick<PrFinding, "path" | "line" | "severity" | "category" | "verdict">[]): Scored[] {
  const taken = new Set<number>()
  return findings.map((finding) => {
    const index = item.defects.findIndex((defect, at) => !taken.has(at) && defect.path === finding.path && Math.abs(defect.line - finding.line) <= LINE_TOLERANCE)
    if (index >= 0) taken.add(index)
    return { path: finding.path, line: finding.line, severity: finding.severity, category: finding.category, ...(finding.verdict ? { verdict: finding.verdict } : {}), ...(index >= 0 ? { matched: index } : {}) }
  })
}

const mean = (values: number[]) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : NaN
const stdev = (values: number[]) => { if (values.length < 2) return 0; const m = mean(values); return Math.sqrt(values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1)) }
const fmt = (values: number[], digits = 2) => Number.isNaN(mean(values)) ? "n/a" : `${mean(values).toFixed(digits)} ± ${stdev(values).toFixed(digits)}`

/** Per profile and repetition: precision and recall on seeded PRs, findings per clean PR, tokens per PR; then mean ± sd over reps. */
export function summarize(runs: readonly CaseRun[], cases: readonly PrCase[]) {
  const byId = new Map(cases.map((item) => [item.id, item]))
  const profiles = [...new Set(runs.map((run) => run.profile))]
  return profiles.map((profile) => {
    const reps = [...new Set(runs.filter((run) => run.profile === profile).map((run) => run.rep))]
    const per = reps.map((rep) => {
      const set = runs.filter((run) => run.profile === profile && run.rep === rep)
      const seeded = set.filter((run) => !run.clean), clean = set.filter((run) => run.clean)
      const published = seeded.flatMap((run) => run.findings)
      const hits = published.filter((finding) => finding.matched !== undefined).length
      const defects = seeded.reduce((sum, run) => sum + (byId.get(run.case)?.defects.length ?? 0), 0)
      const usageOk = set.every((run) => run.status !== "ok" || run.tokens.events > 0)
      return {
        precision: published.length ? hits / published.length : NaN,
        recall: defects ? hits / defects : NaN,
        cleanFindings: clean.length ? clean.reduce((sum, run) => sum + run.findings.length, 0) / clean.length : NaN,
        input: usageOk ? mean(set.map((run) => run.tokens.input)) : NaN,
        uncached: usageOk ? mean(set.map((run) => run.tokens.uncached)) : NaN,
        output: usageOk ? mean(set.map((run) => run.tokens.output)) : NaN,
        timeouts: set.filter((run) => run.status === "timeout").length,
        failures: set.filter((run) => run.status === "failed").length,
        usageOk,
      }
    })
    const pick = (key: keyof (typeof per)[number]) => per.map((item) => item[key] as number).filter((value) => !Number.isNaN(value))
    return { profile, reps: reps.length, precision: fmt(pick("precision")), recall: fmt(pick("recall")), cleanFindings: fmt(pick("cleanFindings")), input: fmt(pick("input"), 0), uncached: fmt(pick("uncached"), 0), output: fmt(pick("output"), 0), timeouts: per.reduce((sum, item) => sum + item.timeouts, 0), failures: per.reduce((sum, item) => sum + item.failures, 0), usageOk: per.every((item) => item.usageOk) }
  })
}

export function table(rows: ReturnType<typeof summarize>) {
  return [
    "| profile | reps | precision | recall | findings per clean PR | input tokens / PR | uncached input / PR | output / PR | timeouts | failures |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...rows.map((row) => `| ${row.profile} | ${row.reps} | ${row.precision} | ${row.recall} | ${row.cleanFindings} | ${row.usageOk ? row.input : "unreadable"} | ${row.usageOk ? row.uncached : "unreadable"} | ${row.usageOk ? row.output : "unreadable"} | ${row.timeouts} | ${row.failures} |`),
  ].join("\n")
}

// ---------- one case ----------

/** Runs T2 and T3 on one case: context from the diff and the code graph, the review pass, the verify pass. */
export async function runCase({ item, profile, rep, root, sessions, timeoutMs }: { item: PrCase; profile: ReviewProfile; rep: number; root: string; sessions: () => { factory: ReviewSessionFactory; tokens: Tokens }; timeoutMs: number }): Promise<CaseRun> {
  const started = Date.now()
  const repo = await caseRepo(item, root)
  const graph = await createIndexer({ cacheDir: `${repo.dir}.graph`, now: Date.now }).graph({ cwd: repo.dir, signal: AbortSignal.timeout(60_000) }).catch(() => undefined)
  const context = await buildReviewContext({ directory: repo.dir, base: repo.base, head: repo.head, budgetTokens: 200_000, graph })
  const { factory, tokens } = sessions()
  const base = { case: item.id, clean: item.defects.length === 0, profile, rep, tokens }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const outcome = await Promise.race([
      reviewPullRequest({ sessionFactory: factory, context, config: { profile, instructions: [], learnings: "", budgetTokens: 200_000 }, cap: 30 }),
      new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), timeoutMs) }),
    ])
    if (outcome === "timeout") return { ...base, status: "timeout", findings: [], candidates: 0, verified: false, ms: Date.now() - started }
    return { ...base, status: "ok", findings: score(item, outcome.result.findings), candidates: outcome.candidates.length, verified: outcome.verified, ms: Date.now() - started }
  } catch (error) {
    return { ...base, status: "failed", error: error instanceof Error ? error.message : String(error), findings: [], candidates: 0, verified: false, ms: Date.now() - started }
  } finally { if (timer) clearTimeout(timer) }
}

// ---------- sessions through a real daemon ----------

/** Review children over the daemon's socket: `explore` in plan mode on `model`, the turn's last message and its reported usage. */
function daemonSessions({ client, events, directory, model, effort }: { client: Client; events: Map<SessionId, (event: SessionEvent) => void>; directory: () => string; model: string; effort: string }) {
  return () => {
    const tokens: Tokens = { input: 0, uncached: 0, output: 0, events: 0 }
    const factory: ReviewSessionFactory = async ({ purpose }) => {
      const created = await client.send({ type: "session.create", directory: directory(), title: `eval ${purpose}`, agent: "explore", choice: { model, effort: effort as "medium" } })
      if (!created.ok) throw new Error(`[EVAL]: session.create: ${created.error.message}`)
      const sessionId = (created.result as { sessionId: SessionId }).sessionId
      await client.send({ type: "session.permission.set", sessionId, mode: "plan" })
      await client.subscribe(sessionId, 0)
      return {
        async send(prompt) {
          const messages = new Set<string>()
          let text = ""
          const done = new Promise<void>((resolve, reject) => events.set(sessionId, (event) => {
            if (event.type === "item.started" && event.kind === "agent_message") messages.add(event.itemId)
            else if (event.type === "item.completed" && messages.has(event.itemId) && typeof event.text === "string") text = event.text
            else if (event.type === "usage.recorded") { tokens.events++; tokens.input += event.input + event.cacheRead + event.cacheWrite; tokens.uncached += event.input; tokens.output += event.output }
            else if (event.type === "server.request") void client.send({ type: "request.resolve", sessionId, requestId: event.requestId, decision: { kind: "deny", reason: "A PR review cannot ask for approval." } })
            else if (event.type === "turn.completed") resolve()
            else if (event.type === "turn.failed") reject(new Error(`[EVAL]: turn failed: ${event.error.message}`))
            else if (event.type === "turn.cancelled" || event.type === "turn.interrupted") reject(new Error("[EVAL]: turn stopped"))
          }))
          const submitted = await client.send({ type: "user.submit", sessionId, text: prompt, attachments: [] })
          if (!submitted.ok) throw new Error(`[EVAL]: user.submit: ${submitted.error.message}`)
          await done
          return { text, tokens: { input: 0, output: 0 } }
        },
        async close() { events.delete(sessionId) },
      }
    }
    return { factory, tokens }
  }
}

async function startDaemon({ dataDir, home, cwd, log, authFrom }: { dataDir: string; home: string; cwd: string; log: string; authFrom?: string | undefined }) {
  mkdirSync(path.join(home, ".codex"), { recursive: true, mode: 0o700 })
  if (authFrom) linkAuth(authFrom, path.join(home, ".codex"), { modelsCache: true })
  const env = cleanEnv({ HOME: home, MENDCODE_V2_DIR: dataDir, MENDCODE_V2_ENGINE: "native", ...MENDCODE_EVAL_ENV })
  const out = openSync(log, "w")
  let child: ChildProcess
  try { child = spawn(process.execPath, [path.join(REPO_ROOT, "packages/daemon/src/main.ts"), "--dir", dataDir, "--cwd", cwd, "--engine", "native", "--local-transport", "unix", "--local-only"], { cwd, env, detached: true, stdio: ["ignore", out, out] }) } finally { closeSync(out) }
  const socketPath = path.join(dataDir, "mendd.sock")
  for (let waited = 0; waited < 30_000; waited += 100) {
    if (child.exitCode !== null) throw new Error(`[EVAL]: the daemon exited with ${child.exitCode}; see ${log}`)
    try { const socket = await Bun.connect({ unix: socketPath, socket: { data() {} } }); socket.end(); return { child, socketPath } } catch { await Bun.sleep(100) }
  }
  throw new Error(`[EVAL]: the daemon did not listen within 30 s; see ${log}`)
}

// ---------- self-test: a scripted reviewer with known answers ----------

/** Reports every seeded defect and one false finding on each clean case; the verifier confirms all. Expected: precision 1, recall 1, 1 finding per clean PR. */
function scriptedSessions(item: PrCase) {
  return () => {
    const tokens: Tokens = { input: 0, uncached: 0, output: 0, events: 1 }
    const factory: ReviewSessionFactory = async ({ purpose }) => ({
      async send(prompt) {
        if (purpose === "verify") return { text: JSON.stringify({ verdicts: [...prompt.matchAll(/"id":"([0-9a-f]{40})"/g)].map((match) => ({ id: match[1], verdict: "confirmed" })) }), tokens: { input: 10, output: 1 } }
        const first = Object.keys(item.head)[0]!
        const findings = item.defects.length
          ? item.defects.map((defect) => ({ path: defect.path, line: defect.line, severity: "major", category: defect.category, summary: defect.note.slice(0, 150), detail: defect.note, evidence: [`${defect.path}:${defect.line}`] }))
          : [{ path: first, line: (item.head[first] ?? "").split("\n").length - 2, severity: "major", category: "correctness", summary: "a false alarm", detail: "nothing is wrong here", evidence: [`${first}:1`] }]
        return { text: JSON.stringify({ summary: "scripted", findings }), tokens: { input: 10, output: 1 } }
      },
      async close() {},
    })
    return { factory, tokens }
  }
}

// ---------- main ----------

async function main() {
  const options = args()
  const cases = options.cases ? CASES.filter((item) => options.cases!.includes(item.id)) : CASES
  const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "mcpr-cases-")))
  try {
    const problems = await checkCases(cases, scratch)
    console.log(`${cases.length} cases (${cases.filter((item) => item.defects.length).length} seeded with ${cases.reduce((sum, item) => sum + item.defects.length, 0)} defects, ${cases.filter((item) => !item.defects.length).length} clean)`)
    if (problems.length) { for (const problem of problems) console.error(problem); process.exitCode = 1; return }
    if (options.dryRun) { console.log(`plan: ${options.profiles.join(",")} × ${options.reps} reps × ${cases.length} cases; every seeded line is an added line`); return }
    if (options.selfTest) {
      const runs: CaseRun[] = []
      for (const profile of options.profiles) for (let rep = 1; rep <= 2; rep++) for (const item of cases) runs.push(await runCase({ item, profile, rep, root: scratch, sessions: scriptedSessions(item), timeoutMs: 60_000 }))
      const rows = summarize(runs, cases)
      console.log(table(rows))
      const ok = rows.every((row) => row.precision.startsWith("1.00") && row.recall.startsWith("1.00") && row.cleanFindings.startsWith("1.00"))
      console.log(ok ? "self-test: scoring matches the scripted answers" : "self-test: FAILED")
      if (!ok) process.exitCode = 1
      return
    }
    if (!options.model) throw new Error("[EVAL]: --model is required (gpt-6-luna)")
    if (FORBIDDEN_MODEL.test(options.model)) throw new Error("[EVAL]: this eval never runs a Claude model")
    const out = assertSafeStateRoot(options.out ?? realpathSync(mkdtempSync(path.join(tmpdir(), "mcpr-out-"))))
    const root = assertSafeStateRoot(options.dataDir ?? realpathSync(mkdtempSync(path.join(tmpdir(), "mcpr-data-"))))
    const dataDir = path.join(root, "d"), home = path.join(root, "home")
    mkdirSync(dataDir, { recursive: true, mode: 0o700 })
    const model = options.model.includes("/") ? options.model : `chatgpt/${options.model}`
    const daemon = await startDaemon({ dataDir, home, cwd: scratch, log: path.join(out, "daemon.log"), authFrom: options.authFrom })
    const events = new Map<SessionId, (event: SessionEvent) => void>()
    const client = createClient({ socketPath: daemon.socketPath, name: "pr-review-eval", timeoutMs: 30_000, onEvent: (event) => events.get(event.sessionId)?.(event) })
    await client.connect()
    let current = scratch
    const sessions = daemonSessions({ client, events, directory: () => current, model, effort: options.effort })
    const runs: CaseRun[] = []
    const raw = path.join(out, "runs.jsonl")
    try {
      for (const profile of options.profiles) for (let rep = 1; rep <= options.reps; rep++) for (const item of cases) {
        const run = await runCase({ item, profile, rep, root: scratch, sessions: () => { current = scratch; return sessions() }, timeoutMs: options.timeoutMs })
        runs.push(run)
        appendFileSync(raw, `${JSON.stringify(run)}\n`)
        console.log(`${profile} r${rep} ${item.id}: ${run.status} · ${run.findings.length} published (${run.findings.filter((finding) => finding.matched !== undefined).length} hit) · ${run.tokens.input} in / ${run.tokens.output} out`)
      }
    } finally {
      client.close()
      if (daemon.child.pid) try { process.kill(-daemon.child.pid, "SIGTERM") } catch { /* already gone */ }
    }
    const rows = summarize(runs, cases)
    const report = [`# PR reviewer eval`, "", `model ${model}, effort ${options.effort}, ${options.reps} reps, ${cases.length} cases, line tolerance ±${LINE_TOLERANCE}`, "", table(rows), "", `raw runs: ${raw}`].join("\n")
    writeFileSync(path.join(out, "t9.md"), `${report}\n`)
    console.log(report)
    if (rows.some((row) => !row.usageOk)) { console.error("provider usage could not be read for some runs: token columns are reported as unreadable, not estimated"); process.exitCode = 2 }
  } finally { rmSync(scratch, { recursive: true, force: true }) }
}

if (import.meta.main) await main()
