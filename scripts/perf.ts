// Repeatable performance benchmark of the v2 terminal client and daemon (docs/performance.md).
//   bun scripts/perf.ts [--messages 0,1000,10000] [--runs 1] [--check]
// Everything runs on temporary directories with the offline faux engine and a throwaway HOME: no network, no provider,
// nothing of the user's data. It never launches pi or Codex; their numbers are a documented manual step.
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from "node:fs"
import { loadavg, tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory, type SessionId } from "@mendcode/protocol"
import { openStore } from "@mendcode/store"

type SessionEventDraft = Parameters<ReturnType<typeof openStore>["sessionSink"]["append"]>[0]
import { soloViolations, violations, type PerfResult, type SoloPerfResult } from "./perf-budgets"

const ROOT = path.join(import.meta.dir, "..")
const ENTRY = path.join(ROOT, "apps/cli/src/entry.ts")
const CLIENT = path.join(import.meta.dir, "perf-client.ts")

/**
 * What is measured, as argument arrays. `compiled` is the shipped artifact (`bun build --compile --minify`, the flags of
 * scripts/build.ts): the bundler drops what the process never reaches, so its memory is what users get. `source` runs
 * the same code under `bun` for quick comparison; it loads every zod locale and reads like a heavier process.
 */
export type Target = { label: "compiled" | "source"; daemon: string[]; client: string[]; cli: string[] }

export function sourceTarget(): Target {
  return { label: "source", daemon: ["bun", ENTRY, "__daemon"], client: ["bun", CLIENT], cli: ["bun", ENTRY] }
}

/** Builds the CLI (through scripts/build.ts) and the client probe with the same compile flags into `outDir`. */
export async function compiledTarget(outDir: string, options: { execArgv?: string | undefined } = {}): Promise<Target> {
  mkdirSync(outDir, { recursive: true })
  const cli = path.join(outDir, "mendcode")
  const probe = path.join(outDir, "perf-client")
  const execArgv = options.execArgv ? ["--exec-argv", options.execArgv] : []
  await run([process.execPath, path.join(ROOT, "scripts/build.ts"), "--outfile", cli, ...execArgv], {})
  const build = Bun.spawn([process.execPath, "build", "--compile", "--splitting", "--minify", "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig", ...(options.execArgv ? [`--compile-exec-argv=${options.execArgv}`] : []), CLIENT, "--outfile", probe], { cwd: outDir, stdout: "pipe", stderr: "pipe" })
  const [err, code] = await Promise.all([new Response(build.stderr).text(), build.exited])
  if (code !== 0) throw new Error(`probe build failed: ${err.slice(0, 500)}`)
  // Same stale-signature fix as scripts/build.ts: macOS kills an unsigned or half-signed binary.
  if (process.platform === "darwin") await run(["/usr/bin/codesign", "--force", "--sign", "-", probe], {})
  return { label: "compiled", daemon: [cli, "__daemon"], client: [probe], cli: [cli] }
}

const ANSWERS = [
  "The daemon owns the session log and the client only draws what the events describe. Here is the plan:\n\n- read the config\n- run the check\n- report the result\n\nThe change is small and the tests cover it.",
  "I looked at `src/store.ts` and found the cause: the cache key ignored the directory.\n\n```ts\nconst key = `${directory}:${name}`\nreturn cache.get(key) ?? load(key)\n```\n\nWith the directory in the key both sessions get their own entry.",
  "Done. Two files changed, one new test added. The suite passes and the type check is clean. Nothing else touched the public contract, so no migration is needed.",
]
const QUESTIONS = ["Why does the second session see the first one's config?", "Please run the tests again and summarize only the failures.", "Can you explain how the render cache is invalidated?"]

/** Runs `command` to completion; fails loudly with its stderr. */
async function run(command: string[], env: Record<string, string>) {
  const child = Bun.spawn(command, { cwd: ROOT, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(`${command.join(" ")} exited ${code}: ${err.slice(0, 500)}`)
  return out
}

/** Resident set size of a process in MB (ps works on macOS and Linux). */
async function processRssMB(pid: number) {
  const out = await new Response(Bun.spawn(["ps", "-o", "rss=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" }).stdout).text()
  return +(Number(out.trim()) / 1024).toFixed(1)
}

/** A data directory holding one session of `messages` finished messages (user and agent alternating), written through the store the daemon uses. */
export function seedDataDir(input: { dir: string; directory: string; messages: number }) {
  const ids = createIdFactory()
  const store = openStore({ dir: input.dir })
  const sessionId = ids("session") as SessionId
  store.createSession({ id: sessionId, directory: input.directory, title: "perf" })
  for (let i = 0; i < input.messages; i += 2) {
    const turnId = ids("turn")
    const append = (draft: Record<string, unknown>) => store.sessionSink.append({ sessionId, ...draft } as SessionEventDraft)
    append({ type: "turn.started", turnId, queueId: ids("queue") })
    for (const [kind, text] of [["user_message", `${QUESTIONS[(i / 2) % QUESTIONS.length]} (${i})`], ["agent_message", ANSWERS[(i / 2) % ANSWERS.length]!]] as const) {
      const itemId = ids("item")
      append({ type: "item.started", turnId, itemId, kind })
      append({ type: "item.completed", itemId, status: "ok", text })
    }
    append({ type: "turn.completed", turnId })
  }
  const lastSeq = store.lastSeq(sessionId) ?? 0
  store.close()
  return { sessionId, lastSeq }
}

/** The real daemon entry on the faux engine, with its own HOME so nothing of the user's is read. Resolves when it prints its socket. */
async function startDaemonProcess(target: Target, dir: string, directory: string) {
  const home = path.join(dir, "home")
  mkdirSync(home, { recursive: true })
  const begin = performance.now()
  const child = Bun.spawn([...target.daemon, "--dir", dir, "--engine", "faux", "--cwd", directory, "--local-only"], { cwd: ROOT, env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" })
  const reader = child.stdout.getReader()
  const decoder = new TextDecoder()
  let seen = ""
  while (!seen.includes("\n")) {
    const chunk = await reader.read()
    if (chunk.done) throw new Error(`daemon exited before it was ready: ${(await new Response(child.stderr).text()).slice(0, 500)}`)
    seen += decoder.decode(chunk.value)
  }
  const { socketPath } = JSON.parse(seen.split("\n")[0]!) as { socketPath: string }
  return { pid: child.pid, socketPath, home, readyMs: +(performance.now() - begin).toFixed(1), async stop() { child.kill("SIGTERM"); await child.exited } }
}

/** One scenario: a daemon on a session of `messages` messages, then the terminal client scrolling and streaming through it. */
export async function measureScenario(target: Target, messages: number, options: { scrollPresses?: number } = {}): Promise<PerfResult> {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-perf-")))
  const directory = path.join(dir, "project")
  mkdirSync(directory, { recursive: true })
  try {
    const seeded = seedDataDir({ dir, directory, messages })
    const daemon = await startDaemonProcess(target, dir, directory)
    try {
      await Bun.sleep(400)
      const daemonIdleMB = await processRssMB(daemon.pid)
      const out = await run([...target.client, "--socket", daemon.socketPath, "--session", seeded.sessionId, "--directory", directory, "--data-dir", dir, "--last-seq", String(seeded.lastSeq), ...(options.scrollPresses ? ["--scroll-presses", String(options.scrollPresses)] : [])], { HOME: daemon.home })
      const client = JSON.parse(out.trim().split("\n").at(-1)!) as Omit<PerfResult, "messages" | "daemon">
      return { messages, daemon: { rssIdleMB: daemonIdleMB, rssWithClientMB: await processRssMB(daemon.pid), readyMs: daemon.readyMs }, ...client }
    } finally { await daemon.stop() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

/** One scenario in solo mode: the client probe hosts the daemon in its own process (`--solo`), so there is one process to measure. */
export async function measureSoloScenario(target: Target, messages: number, options: { scrollPresses?: number } = {}): Promise<SoloPerfResult> {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-perf-solo-")))
  const directory = path.join(dir, "project")
  mkdirSync(directory, { recursive: true })
  const home = path.join(dir, "home")
  mkdirSync(home, { recursive: true })
  try {
    const seeded = seedDataDir({ dir, directory, messages })
    const out = await run([...target.client, "--solo", "--session", seeded.sessionId, "--directory", directory, "--data-dir", dir, "--last-seq", String(seeded.lastSeq), ...(options.scrollPresses ? ["--scroll-presses", String(options.scrollPresses)] : [])], { HOME: home, MENDCODE_BUILD_ID: "perf" })
    return { messages, ...(JSON.parse(out.trim().split("\n").at(-1)!) as Omit<SoloPerfResult, "messages">) }
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

/** Wall time of the real CLI entry printing help (process boot, module graph and exit), median of `runs`. */
export async function measureCliStartup(target: Target, runs = 5) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-perf-start-")))
  try {
    const times: number[] = []
    for (let i = 0; i < runs; i++) {
      const begin = performance.now()
      await run([...target.cli, "--dir", dir, "help"], { HOME: dir })
      times.push(performance.now() - begin)
    }
    return +times.sort((a, b) => a - b)[Math.floor(times.length / 2)]!.toFixed(1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

/** One table for people (the JSON on stdout is for tools): memory in MB, frames as p95 ms. */
export function summary(results: readonly PerfResult[], cliHelpMs: number) {
  const rows = results.map((r) => [String(r.messages).padStart(6), `${r.daemon.rssIdleMB}/${r.daemon.rssWithClientMB}`.padStart(11), `${r.rssMB.idle}/${r.rssMB.afterStream}`.padStart(11), `${r.startupMs.firstFrame}`.padStart(8), `${r.frameMs.scrollUp.p95}/${r.frameMs.scrollDown.p95}`.padStart(11), `${r.frameMs.stream.p95}`.padStart(8), `${r.daemon.readyMs}`.padStart(8)].join("  "))
  return [`messages  daemon MB    client MB   frame1  scroll p95  stream  daemon   (cli help ${cliHelpMs} ms)`, "          idle/client  idle/after  ms      up/down     p95     ready ms", ...rows].join("\n")
}

/** The solo table: one process, so one RSS series (boot is the bare runtime, hosted is after the daemon started in-process). */
export function soloSummary(results: readonly SoloPerfResult[]) {
  const rows = results.map((r) => [String(r.messages).padStart(6), `${r.rssMB.boot}/${r.rssMB.hosted}`.padStart(10), `${r.rssMB.idle}/${r.rssMB.afterStream}`.padStart(11), `${r.startupMs.firstFrame}`.padStart(8), `${r.startupMs.hosted}`.padStart(8), `${r.frameMs.scrollUp.p95}/${r.frameMs.scrollDown.p95}`.padStart(11), `${r.frameMs.stream.p95}`.padStart(8)].join("  "))
  return ["solo     process MB                   frame1  hosted  scroll p95  stream", "messages  boot/hosted  idle/after  ms      ms      up/down     p95", ...rows].join("\n")
}

if (import.meta.main) {
  const flag = (name: string) => { const at = process.argv.indexOf(`--${name}`); return at >= 0 ? process.argv[at + 1] : undefined }
  const sizes = (flag("messages") ?? "0,1000,10000").split(",").map(Number)
  const buildDir = mkdtempSync(path.join(tmpdir(), "mend-perf-build-"))
  try {
    const target = process.argv.includes("--source") ? sourceTarget() : await compiledTarget(buildDir, { execArgv: flag("exec-argv") })
    const modes = (flag("mode") ?? "daemon,solo").split(",")
    const results: PerfResult[] = []
    const soloResults: SoloPerfResult[] = []
    const scrollPresses = flag("scroll-presses") ? Number(flag("scroll-presses")) : undefined
    const loadBefore = loadavg()[0]!
    if (modes.includes("daemon")) for (const size of sizes) results.push(await measureScenario(target, size, scrollPresses ? { scrollPresses } : {}))
    if (modes.includes("solo")) for (const size of sizes) soloResults.push(await measureSoloScenario(target, size, scrollPresses ? { scrollPresses } : {}))
    const cliHelpStartupMs = await measureCliStartup(target)
    const load = { before: +loadBefore.toFixed(2), after: +loadavg()[0]!.toFixed(2) }
    console.log(JSON.stringify({ target: target.label, platform: `${process.platform}-${process.arch}`, bun: Bun.version, loadAverage: load, cliHelpStartupMs, results, soloResults }, null, 2))
    console.error(`load average (1 min): ${load.before} before, ${load.after} after${Math.max(load.before, load.after) > 3 ? " (above 3: repeat on an idle machine)" : ""}`)
    if (results.length) console.error(summary(results, cliHelpStartupMs))
    if (soloResults.length) console.error(soloSummary(soloResults))
    if (process.argv.includes("--check")) {
      const failed = [...(results.length ? violations(results, cliHelpStartupMs) : []), ...soloViolations(soloResults)]
      if (failed.length) { console.error(`over budget:\n${failed.join("\n")}`); process.exitCode = 1 }
    }
  } finally { rmSync(buildDir, { recursive: true, force: true }) }
}
