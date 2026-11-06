// The real CLI in a pseudo-terminal against a real daemon on the offline faux engine (throwaway HOME and data), measuring what
// the in-process probe (scripts/perf-client.ts) cannot: time to the first frame and until the prompt takes typing, keystroke
// to frame latency, CPU at rest and while streaming, memory settling after a reply, exit time, and memory per extra client.
//   bun scripts/perf-real.ts --binary PATH [--scenario session|clients] [--runs 1] [--messages 200] [--idle-seconds 60]
//        [--stream-bytes 18000] [--focus none|unfocused] [--tier balanced] [--clients 1,2,4,8]
// JSON goes to stdout. Memory is macOS physical footprint beside RSS (scripts/perf-proc.ts). Nothing touches ~/.mendcode*.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { openStore } from "@mendcode/store"
import { TIER_BUNDLES, type Tier } from "@mendcode/protocol/wire"
import { seedDataDir } from "./perf"
import { processStats, spread, type ProcessStats } from "./perf-proc"
import { createPtyScreen } from "./pty-screen"

const SYNC_START = "\x1b[?2026h"

export type RealOptions = {
  binary: string
  messages?: number
  idleSeconds?: number
  streamBytes?: number
  focus?: "none" | "unfocused"
  tier?: Tier
  cols?: number
  rows?: number
  keystrokes?: number
}

export type RealResult = {
  startupMs: { firstFrame: number; ready: number }
  keystrokeMs: { warm: { median: number; p95: number }; afterIdle: { median: number; p95: number } }
  stream: { wallMs: number; frames: number; bytes: number; clientCpuMs: number; daemonCpuMs: number }
  client: { afterBoot: ProcessStats; afterStream: ProcessStats; afterIdle: ProcessStats }
  daemon: { afterBoot: ProcessStats; afterIdle: ProcessStats }
  rest: { seconds: number; clientCpuMs: number; daemonCpuMs: number }
  exitMs: number
}

type Rig = Awaited<ReturnType<typeof startRig>>

/** A daemon (its own process, as a second terminal would find it) plus a data directory seeded with one session. */
async function startRig(options: { binary: string; messages: number; tier: Tier }) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-perf-real-")))
  const dir = path.join(root, "data")
  const home = path.join(root, "home")
  for (const folder of [dir, home]) mkdirSync(folder, { recursive: true })
  const project = (name: string) => { const folder = path.join(root, name); mkdirSync(folder, { recursive: true }); return folder }
  const directory = project("project")
  seedDataDir({ dir, directory, messages: options.messages })
  const store = openStore({ dir })
  try { store.settings.set({ onboarded: true, tier: options.tier, view: TIER_BUNDLES[options.tier].view }) } finally { store.close() }
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: root, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, TERM: "xterm-256color", LANG: "en_US.UTF-8", MENDCODE_TERMINAL_MODE: "0", MENDCODE_IMAGES: "off", MENDCODE_GLYPHS: "unicode" }
  const began = performance.now()
  // PERF_DAEMON_ENV (a JSON object) adds the JIT options a build's launcher would start its daemon with (launcher.ts LEAN_JIT.daemon); the rig starts it directly.
  const daemon = Bun.spawn([options.binary, "__daemon", "--dir", dir, "--engine", "faux", "--cwd", directory, "--local-only", "--pure"], { cwd: directory, env: { ...env, ...(process.env.PERF_DAEMON_ENV ? JSON.parse(process.env.PERF_DAEMON_ENV) as Record<string, string> : {}) }, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const reader = daemon.stdout.getReader()
  const decoder = new TextDecoder()
  let seen = ""
  while (!seen.includes("\n")) {
    const chunk = await reader.read()
    if (chunk.done) throw new Error(`daemon exited before it was ready: ${(await new Response(daemon.stderr).text()).slice(0, 500)}`)
    seen += decoder.decode(chunk.value)
  }
  reader.releaseLock()
  return {
    root, dir, directory, env, project, daemonPid: daemon.pid, daemonReadyMs: +(performance.now() - began).toFixed(1),
    async stop() { daemon.kill("SIGTERM"); await daemon.exited; rmSync(root, { recursive: true, force: true }) },
  }
}

/** One real CLI in a PTY, with a screen model of what it drew. */
function openCli(rig: Rig, input: { binary: string; directory: string; cols: number; rows: number }) {
  const screen = createPtyScreen(input.cols, input.rows)
  const decoder = new TextDecoder()
  const waiters = new Set<() => void>()
  const marks: { firstFrame?: number } = {}
  /** What the CLI wrote to the terminal so far: bytes, and synchronized-output frames (one per drawn frame). */
  const written = { bytes: 0, frames: 0 }
  const began = performance.now()
  const terminal = new Bun.Terminal({
    cols: input.cols, rows: input.rows, name: "xterm-256color",
    data: (_terminal, bytes) => {
      const text = decoder.decode(bytes, { stream: true })
      written.bytes += bytes.length
      written.frames += text.split(SYNC_START).length - 1
      if (marks.firstFrame === undefined && text.includes(SYNC_START)) marks.firstFrame = performance.now()
      screen.feed(text)
      for (const wake of [...waiters]) wake()
    },
  })
  // `--pure` keeps extensions out (the PTY smoke does the same); a user does not pass it, and it adds a `daemon.info` round trip to the start, so `--no-pure` measures the usual launch.
  // PERF_CLIENT_ENV (a JSON object) adds JIT options to the terminal, as PERF_DAEMON_ENV does to the daemon.
  const clientEnv = { ...rig.env, ...(process.env.PERF_CLIENT_ENV ? JSON.parse(process.env.PERF_CLIENT_ENV) as Record<string, string> : {}) }
  const cli = Bun.spawn([input.binary, "--dir", rig.dir, "--engine", "faux", ...(process.argv.includes("--no-pure") ? [] : ["--pure"])], { cwd: input.directory, env: clientEnv, terminal })
  const count = (char: string) => screen.text().split(char).length - 1
  /** Resolves when `check()` holds, checked on every chunk of output; rejects after `timeoutMs`. */
  const until = (check: () => boolean, label: string, timeoutMs = 20_000) => new Promise<number>((resolve, reject) => {
    const done = () => { if (check()) { waiters.delete(done); clearTimeout(timer); resolve(performance.now()) } }
    const timer = setTimeout(() => { waiters.delete(done); reject(new Error(`perf-real timed out: ${label}\n${screen.text()}`)) }, timeoutMs)
    waiters.add(done)
    done()
  })
  return { cli, screen, terminal, marks, written, began, count, until, write: (data: string) => terminal.write(data) }
}
type Cli = ReturnType<typeof openCli>

/** Types a character and waits for it to show in the prompt, then removes it; returns the echo latency in ms. */
async function keystroke(cli: Cli, char: string) {
  const before = cli.count(char)
  const sent = performance.now()
  cli.write(char)
  const shown = await cli.until(() => cli.count(char) > before, "keystroke echo")
  cli.write("\x7f")
  await cli.until(() => cli.count(char) === before, "keystroke erase")
  return shown - sent
}

async function keystrokes(cli: Cli, samples: number) {
  const times: number[] = []
  for (let i = 0; i < samples; i++) {
    times.push(await keystroke(cli, "Z"))
    await Bun.sleep(40)
  }
  times.sort((a, b) => a - b)
  return { median: +times[Math.floor(times.length / 2)]!.toFixed(1), p95: +times[Math.min(times.length - 1, Math.floor(times.length * 0.95))]!.toFixed(1) }
}

/** The reply the faux engine streams for `/say`: markdown paragraphs of about `bytes` characters ending in a marker word. */
function replyText(bytes: number, marker: string) {
  const sentence = "The daemon owns the session log and the client only draws what the events describe, so a frame stays cheap while text streams in. "
  let text = ""
  while (text.length < bytes) text += sentence.repeat(3) + "\n\n"
  return `${text.trim()} ${marker}`
}

const stats = (pid: number) => processStats(pid) ?? { rssMB: 0, cpuMs: 0 }

async function quit(cli: Cli) {
  cli.write("\x18")
  await Bun.sleep(80)
  const sent = performance.now()
  cli.write("q")
  await Promise.race([cli.cli.exited, Bun.sleep(10_000)])
  if (cli.cli.exitCode === null) { cli.cli.kill("SIGKILL"); throw new Error("perf-real: the CLI did not exit after Ctrl+X q") }
  return +(performance.now() - sent).toFixed(1)
}

/** One session: boot, type, stream a reply, rest, type again, exit. */
export async function measureSession(options: RealOptions): Promise<RealResult> {
  const cols = options.cols ?? 120
  const rows = options.rows ?? 40
  const rig = await startRig({ binary: options.binary, messages: options.messages ?? 200, tier: options.tier ?? "balanced" })
  try {
    const cli = openCli(rig, { binary: options.binary, directory: rig.directory, cols, rows })
    const pid = cli.cli.pid
    await cli.until(() => cli.marks.firstFrame !== undefined, "first frame")
    const firstFrame = cli.marks.firstFrame! - cli.began
    // Ready to type: a key sent at the first frame shows up in the prompt.
    const echoed = performance.now()
    const before = cli.count("Z")
    cli.write("Z")
    const shown = await cli.until(() => cli.count("Z") > before, "first keystroke")
    const ready = shown - cli.began
    void echoed
    cli.write("\x7f")
    await cli.until(() => cli.count("Z") === before, "erase first keystroke")
    await Bun.sleep(1500)
    const afterBoot = stats(pid)
    const daemonBoot = stats(rig.daemonPid)
    const warm = await keystrokes(cli, options.keystrokes ?? 20)

    if (options.focus === "unfocused") cli.write("\x1b[O")
    await Bun.sleep(300)
    const marker = "ENDMARKER"
    const clientBefore = stats(pid)
    const daemonBefore = stats(rig.daemonPid)
    const writtenBefore = { ...cli.written }
    const streamStart = performance.now()
    // With PERF_TIMELINE set, CPU of both processes each second of the reply goes to stderr (finding where time goes, not a metric).
    const timeline = process.env.PERF_TIMELINE ? setInterval(() => console.error(`t=${((performance.now() - streamStart) / 1000).toFixed(1)}s client=${(stats(pid).cpuMs - clientBefore.cpuMs).toFixed(0)}ms daemon=${(stats(rig.daemonPid).cpuMs - daemonBefore.cpuMs).toFixed(0)}ms frames=${cli.written.frames - writtenBefore.frames}`), 1000) : undefined
    cli.write("/say ")
    await Bun.sleep(100)
    cli.write(`\x1b[200~${replyText(options.streamBytes ?? 18_000, marker)}\x1b[201~`)
    await Bun.sleep(300)
    cli.write("\r")
    // The reply is over when the daemon has no turn: the last paragraph's marker is drawn while unfocused frames may lag, so also wait for the CPU to settle.
    if (options.focus === "unfocused") {
      await Bun.sleep(100)
      const deadline = performance.now() + 60_000
      let last = stats(rig.daemonPid).cpuMs
      let quiet = 0
      while (performance.now() < deadline && quiet < 4) {
        await Bun.sleep(500)
        const now = stats(rig.daemonPid).cpuMs
        quiet = now - last < 5 ? quiet + 1 : 0
        last = now
      }
    } else await cli.until(() => cli.count(marker) > 0, "reply marker", 120_000)
    const streamWall = performance.now() - streamStart
    clearInterval(timeline)
    const clientStreamEnd = stats(pid)
    const daemonStreamEnd = stats(rig.daemonPid)
    const streamed = { frames: cli.written.frames - writtenBefore.frames, bytes: cli.written.bytes - writtenBefore.bytes }
    if (options.focus === "unfocused") {
      cli.write("\x1b[I")
      await cli.until(() => cli.count(marker) > 0, "reply visible after focus returns", 10_000)
    }
    await Bun.sleep(1000)
    const afterStream = stats(pid)

    const restStart = { client: stats(pid), daemon: stats(rig.daemonPid) }
    const seconds = options.idleSeconds ?? 60
    await Bun.sleep(seconds * 1000)
    const afterIdle = stats(pid)
    const daemonIdle = stats(rig.daemonPid)
    const late = await keystrokes(cli, options.keystrokes ?? 20)
    const exitMs = await quit(cli)
    return {
      startupMs: { firstFrame: +firstFrame.toFixed(1), ready: +ready.toFixed(1) },
      keystrokeMs: { warm, afterIdle: late },
      stream: { wallMs: +streamWall.toFixed(0), frames: streamed.frames, bytes: streamed.bytes, clientCpuMs: +(clientStreamEnd.cpuMs - clientBefore.cpuMs).toFixed(1), daemonCpuMs: +(daemonStreamEnd.cpuMs - daemonBefore.cpuMs).toFixed(1) },
      client: { afterBoot, afterStream, afterIdle },
      daemon: { afterBoot: daemonBoot, afterIdle: daemonIdle },
      rest: { seconds, clientCpuMs: +(afterIdle.cpuMs - restStart.client.cpuMs).toFixed(1), daemonCpuMs: +(daemonIdle.cpuMs - restStart.daemon.cpuMs).toFixed(1) },
      exitMs,
    }
  } finally { await rig.stop() }
}

export type StartupResult = { firstFrame: number; ready: number; exitMs: number; phases?: Record<string, number> }

/**
 * Cold launches of the real CLI against one running daemon: `runs` fresh processes, each timed to the first frame and until a key shows in
 * the prompt, then closed. With `phasesFile` the build under test writes `pid name ms epoch` lines (a temporary instrumentation, not part of
 * the product); the result then also carries the milliseconds from the spawn to each mark of the final process.
 */
export async function measureStartup(options: { binary: string; runs: number; messages?: number; tier?: Tier; cols?: number; rows?: number; phasesFile?: string }) {
  const rig = await startRig({ binary: options.binary, messages: options.messages ?? 200, tier: options.tier ?? "balanced" })
  const results: StartupResult[] = []
  try {
    for (let run = 0; run < options.runs; run++) {
      if (options.phasesFile) rmSync(options.phasesFile, { force: true })
      const env = options.phasesFile ? { ...rig.env, MENDCODE_PHASES: options.phasesFile } : rig.env
      const cli = openCli({ ...rig, env }, { binary: options.binary, directory: rig.directory, cols: options.cols ?? 120, rows: options.rows ?? 40 })
      const spawnedAt = Date.now()
      await cli.until(() => cli.marks.firstFrame !== undefined, "first frame")
      const firstFrame = cli.marks.firstFrame! - cli.began
      const before = cli.count("Z")
      cli.write("Z")
      const shown = await cli.until(() => cli.count("Z") > before, "first keystroke")
      const result: StartupResult = { firstFrame: +firstFrame.toFixed(1), ready: +(shown - cli.began).toFixed(1), exitMs: 0 }
      cli.write("\x7f")
      await Bun.sleep(100)
      result.exitMs = await quit(cli)
      if (options.phasesFile) {
        const lines = (await Bun.file(options.phasesFile).text()).trim().split("\n").map((line) => line.split(" ")).filter((parts) => parts.length === 4)
        const lastBoot = lines.map((parts) => parts[1]).lastIndexOf("boot")
        const phases: Record<string, number> = {}
        for (const [, name, , epoch] of lines.slice(lastBoot)) phases[name!] = Number(epoch) - spawnedAt
        result.phases = phases
      }
      results.push(result)
      await Bun.sleep(300)
    }
    return results
  } finally { await rig.stop() }
}

export type ClientsResult ={ clients: number; clientFootprintMB: number; clientRssMB: number; daemonFootprintMB: number; daemonRssMB: number }[]

/** N real terminals attached to one daemon, each in its own project (so its own session): total memory per count and the delta per extra client. */
export async function measureClients(options: { binary: string; counts: number[]; tier?: Tier; cols?: number; rows?: number }) {
  const rig = await startRig({ binary: options.binary, messages: 0, tier: options.tier ?? "balanced" })
  const open: Cli[] = []
  const results: ClientsResult = []
  try {
    const baseline = stats(rig.daemonPid)
    for (const target of options.counts) {
      while (open.length < target) {
        const cli = openCli(rig, { binary: options.binary, directory: rig.project(`project-${open.length}`), cols: options.cols ?? 120, rows: options.rows ?? 40 })
        await cli.until(() => cli.marks.firstFrame !== undefined, "first frame")
        open.push(cli)
        await Bun.sleep(1500)
      }
      await Bun.sleep(2500)
      const clients = open.map((cli) => stats(cli.cli.pid))
      const daemon = stats(rig.daemonPid)
      results.push({
        clients: target,
        clientFootprintMB: +clients.reduce((sum, item) => sum + (item.footprintMB ?? 0), 0).toFixed(1),
        clientRssMB: +clients.reduce((sum, item) => sum + item.rssMB, 0).toFixed(1),
        daemonFootprintMB: daemon.footprintMB ?? 0,
        daemonRssMB: daemon.rssMB,
      })
    }
    for (const cli of open) cli.cli.kill("SIGTERM")
    return { daemonBaseline: baseline, results }
  } finally {
    for (const cli of open) cli.cli.kill("SIGKILL")
    await rig.stop()
  }
}

/** Medians and ranges over several sessions, flattened to `path: {median,min,max}` for A/B tables. */
export function summarize(runs: readonly RealResult[]) {
  const out: Record<string, { median: number; min: number; max: number }> = {}
  const walk = (prefix: string, values: unknown[]) => {
    const first = values[0]
    if (typeof first === "number") { out[prefix] = spread(values as number[]); return }
    if (first && typeof first === "object") for (const key of Object.keys(first)) walk(prefix ? `${prefix}.${key}` : key, values.map((value) => (value as Record<string, unknown>)[key]).filter((value) => value !== undefined))
  }
  walk("", runs as unknown[])
  return out
}

if (import.meta.main) {
  const flag = (name: string) => { const at = process.argv.indexOf(`--${name}`); return at >= 0 ? process.argv[at + 1] : undefined }
  const binary = path.resolve(flag("binary") ?? (() => { throw new Error("perf-real: --binary PATH is required") })())
  const tier = (flag("tier") ?? "balanced") as Tier
  if (flag("scenario") === "startup") {
    const runs = await measureStartup({ binary, tier, runs: Number(flag("runs") ?? 10), ...(flag("messages") ? { messages: Number(flag("messages")) } : {}), ...(flag("phases") ? { phasesFile: path.resolve(flag("phases")!) } : {}) })
    const flat = (pick: (run: StartupResult) => number | undefined) => spread(runs.map(pick).filter((value): value is number => value !== undefined))
    const names = [...new Set(runs.flatMap((run) => Object.keys(run.phases ?? {})))]
    console.log(JSON.stringify({ runs, summary: { firstFrame: flat((run) => run.firstFrame), ready: flat((run) => run.ready), exitMs: flat((run) => run.exitMs), phases: Object.fromEntries(names.map((name) => [name, flat((run) => run.phases?.[name])])) } }, null, 2))
  } else if ((flag("scenario") ?? "session") === "clients") {
    console.log(JSON.stringify(await measureClients({ binary, tier, counts: (flag("clients") ?? "1,2,4,8").split(",").map(Number) }), null, 2))
  } else {
    const runs: RealResult[] = []
    for (let i = 0; i < Number(flag("runs") ?? 1); i++) {
      runs.push(await measureSession({
        binary, tier,
        ...(flag("messages") ? { messages: Number(flag("messages")) } : {}),
        ...(flag("idle-seconds") ? { idleSeconds: Number(flag("idle-seconds")) } : {}),
        ...(flag("stream-bytes") ? { streamBytes: Number(flag("stream-bytes")) } : {}),
        ...(flag("focus") === "unfocused" ? { focus: "unfocused" as const } : {}),
      }))
    }
    console.log(JSON.stringify({ runs, summary: summarize(runs) }, null, 2))
  }
  // The PTYs keep the event loop alive after the CLIs are gone.
  process.exit(0)
}
