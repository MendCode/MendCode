// Attribution A/B for two MendCode builds: what changed, by part, with metrics that are deterministic or nearly so (docs/performance.md,
// "Attribution A/B"). One faux-engine session per run (a daemon process and a terminal process, throwaway HOME and data; no login, no network)
// measured at ready, after one reply and at rest, for each process: physical footprint, JS heap by object type (`heapStats`) and by
// constructor (heap snapshot), native memory by region (`vmmap --summary` on macOS, `smaps_rollup` on Linux), modules loaded, CPU per phase;
// plus the binary's size and the session's bytes per table.
//   bun scripts/perf-attrib.ts --base REF|BINARY --cand REF|BINARY [--rounds 2] [--rest 20] [--json] [--markdown] [--out DIR] [--keep] [--cache DIR]
//   bun scripts/perf-attrib.ts --calibrate BINARY [--rounds 3]     (the same build on both sides; writes scripts/perf-attrib-noise.json)
// REF is a commit-ish: it is built in a temporary worktree that is removed at the end. BINARY is a compiled mendcode (copied, never touched).
// --cache DIR keeps the binary built for each REF (one file per full commit id, platform and arch) and reuses it next time, so measuring the same
// commit again builds nothing; the caller bounds the directory (the PR reviewer evicts the oldest).
// Exit code 1 when a metric rose above its measured noise threshold, so CI or a reviewer can treat it as a finding.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { Database } from "bun:sqlite"
import { tmpdir } from "node:os"
import path from "node:path"
import { openStore } from "@mendcode/store"
import { TIER_BUNDLES, type Tier } from "@mendcode/protocol/wire"
import { LEAN_JIT } from "../apps/cli/src/launcher"
import { seedDataDir } from "./perf"
import { processStats, spread } from "./perf-proc"
import { createPtyScreen } from "./pty-screen"

export const SCHEMA_VERSION = 1
const REPO = path.resolve(import.meta.dir, "..")
const PRELOAD = path.join(import.meta.dir, "perf-attrib-preload.ts")
const NOISE_FILE = path.join(import.meta.dir, "perf-attrib-noise.json")
/** The 2026-11-03 record in the mendcode-no-regressions skill (real model, tui + daemon summed); the faux engine differs, so this line is a reference, not a gate. */
export const REFERENCE = { readyFootprintMB: 64, afterFootprintMB: 66, peakFootprintMB: 80, bytesPerSession: 2600, readyRssMB: 130, afterRssMB: 139 }

export type Flat = Record<string, number>
type Role = "tui" | "daemon"
const PHASES = ["ready", "after", "rest"] as const

/** Sizes in `vmmap` text (`512.0M`, `3760K`, `1.6G`, `0K`) as MB. */
export function toMB(text: string) {
  const number = parseFloat(text)
  const unit = text.replace(/[0-9.]/g, "")
  return number * (unit === "G" ? 1024 : unit === "M" ? 1 : unit === "K" ? 1 / 1024 : 1 / 1048576)
}

/** Dirty plus swapped MB per region type, from `vmmap --summary` output. */
export function parseVmmap(text: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const line of text.split("\n")) {
    if (line.startsWith("MALLOC ZONE")) break
    const match = /^(\S.*?)\s{2,}(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)\b/.exec(line)
    if (!match || /^(REGION TYPE|TOTAL|MALLOC ZONE)/.test(match[1]!) || match[1]!.includes("(reserved)")) continue
    out[match[1]!.trim().replace(/\s+/g, "_")] = +(toMB(match[4]!) + toMB(match[5]!)).toFixed(2)
  }
  return out
}

/** Linux: private dirty, swap and PSS from `smaps_rollup`, as MB. */
export function parseSmaps(text: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [, key, kb] of text.matchAll(/^(Pss|Private_Dirty|Private_Clean|Swap|Anonymous):\s+(\d+) kB/gm)) out[key!] = +(Number(kb) / 1024).toFixed(2)
  return out
}

function nativeRegions(pid: number): Record<string, number> {
  if (process.platform === "darwin") return parseVmmap(Bun.spawnSync(["vmmap", "--summary", String(pid)], { stdout: "pipe", stderr: "ignore" }).stdout.toString())
  try { return parseSmaps(readFileSync(`/proc/${pid}/smaps_rollup`, "utf8")) } catch { return {} }
}

type Rig = { root: string; dir: string; home: string; directory: string; env: Record<string, string>; dump: string }

async function startDaemon(binary: string, rig: Rig) {
  const daemon = Bun.spawn([binary, "__daemon", "--dir", rig.dir, "--engine", "faux", "--cwd", rig.directory, "--local-only", "--pure"], { cwd: rig.directory, env: { ...rig.env, ...LEAN_JIT.daemon }, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
  const reader = daemon.stdout.getReader()
  const decoder = new TextDecoder()
  let seen = ""
  while (!seen.includes("\n")) {
    const chunk = await reader.read()
    if (chunk.done) throw new Error(`daemon exited before it was ready: ${(await new Response(daemon.stderr).text()).slice(0, 500)}`)
    seen += decoder.decode(chunk.value)
  }
  reader.releaseLock()
  return daemon
}

/** Asks a process (through the preload) for its heap; resolves with the parsed dump. */
async function heapDump(pid: number, rig: Rig, label: string, snapshot: boolean) {
  writeFileSync(path.join(rig.dump, "request"), `${label}${snapshot ? " snapshot" : ""}`)
  const file = path.join(rig.dump, `${pid}-${label}.json`)
  process.kill(pid, "SIGUSR2")
  for (let i = 0; i < 400 && !existsSync(file); i++) await Bun.sleep(50)
  if (!existsSync(file)) throw new Error(`perf-attrib: pid ${pid} wrote no heap dump (is the preload loaded? BUN_OPTIONS is read by the compiled binary)`)
  return JSON.parse(readFileSync(file, "utf8")) as { heap: { heapSize: number; heapCapacity: number; extraMemorySize: number; objectCount: number; protectedObjectCount: number; globalObjectCount: number; objectTypeCounts: Record<string, number>; protectedObjectTypeCounts: Record<string, number> }; modules?: Array<[string, number]>; embedded?: Array<{ name: string; size: number }>; byConstructor?: Record<string, { count: number; bytes: number }> }
}

const key = (text: string) => text.replace(/[^A-Za-z0-9_:.$ -]/g, "?").replace(/\s+/g, "_")

/** One session on `binary`: every metric of this run as a flat name -> number map, and the lists that are not numbers. */
export async function measureRun(input: { binary: string; restSeconds: number; streamBytes?: number; tier?: Tier; /** `solo`: one process hosts the daemon, as a user's terminal does (the skill's baseline); `split`: a daemon process of its own. */ layout?: "solo" | "split" }) {
  const split = input.layout === "split"
  const roles: Role[] = split ? ["tui", "daemon"] : ["tui"]
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-attrib-")))
  const dir = path.join(root, "data"), home = path.join(root, "home"), directory = path.join(root, "project"), dump = path.join(root, "dump")
  for (const folder of [dir, home, directory, dump]) mkdirSync(folder, { recursive: true })
  const tier = input.tier ?? "balanced"
  seedDataDir({ dir, directory, messages: 0 })
  const store = openStore({ dir })
  try { store.settings.set({ onboarded: true, tier, view: TIER_BUNDLES[tier].view }) } finally { store.close() }
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: root, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, TERM: "xterm-256color", LANG: "en_US.UTF-8", MENDCODE_TERMINAL_MODE: "0", MENDCODE_IMAGES: "off", MENDCODE_GLYPHS: "unicode", BUN_OPTIONS: `--preload ${PRELOAD}`, PERF_ATTRIB_DIR: dump }
  const rig: Rig = { root, dir, home, directory, env, dump }
  const flat: Flat = {}
  const lists: { modules: Record<string, Array<[string, number]>>; embedded: Record<string, Array<{ name: string; size: number }>> } = { modules: {}, embedded: {} }
  const daemon = split ? await startDaemon(input.binary, rig) : undefined
  const screen = createPtyScreen(120, 40)
  const decoder = new TextDecoder()
  const terminal = new Bun.Terminal({ cols: 120, rows: 40, name: "xterm-256color", data: (_t, bytes) => { screen.feed(decoder.decode(bytes, { stream: true })) } })
  const cli = Bun.spawn([input.binary, "--dir", dir, "--engine", "faux", ...(split ? ["--pure"] : [])], { cwd: directory, env: { ...env, ...LEAN_JIT.client }, terminal })
  const pids: Record<Role, number> = { tui: cli.pid, daemon: daemon?.pid ?? 0 }
  const until = async (check: () => boolean, label: string, ms = 60_000) => { const end = performance.now() + ms; while (!check()) { if (performance.now() > end) throw new Error(`perf-attrib timed out: ${label}\n${screen.text()}`); await Bun.sleep(100) } }
  try {
    // Ready: a key sent shows in the prompt (as perf-real does).
    await until(() => screen.text().trim().length > 0, "first frame")
    terminal.write("Z")
    await until(() => screen.text().includes("Z"), "first keystroke")
    terminal.write("\x7f")
    await Bun.sleep(3000)
    const cpuMark: Record<Role, number> = { tui: 0, daemon: 0 }
    const measure = async (phase: (typeof PHASES)[number]) => {
      // Footprint and regions first, the heap dump (a collection, and a snapshot at rest) after, so a phase is never measured through its own probe.
      const peaks: number[] = []
      for (const role of roles) {
        const s = processStats(pids[role])
        if (!s) throw new Error(`perf-attrib: ${role} process is gone`)
        flat[`${role}.${phase}.fp_mb`] = s.footprintMB ?? s.rssMB
        flat[`${role}.${phase}.rss_mb`] = s.rssMB
        if (s.peakFootprintMB !== undefined) { flat[`${role}.${phase}.peak_mb`] = s.peakFootprintMB; peaks.push(s.peakFootprintMB) }
        for (const [region, mb] of Object.entries(nativeRegions(pids[role]))) flat[`${role}.${phase}.region.${key(region)}`] = mb
        flat[`${role}.cpu_ms.${phase}`] = +(s.cpuMs - cpuMark[role]).toFixed(0)
        cpuMark[role] = s.cpuMs
      }
      for (const role of roles) {
        const dumped = await heapDump(pids[role], rig, `${role}-${phase}`, phase === "rest")
        const h = dumped.heap
        const p = `${role}.${phase}.heap`
        Object.assign(flat, { [`${p}.size_b`]: h.heapSize, [`${p}.extra_b`]: h.extraMemorySize, [`${p}.capacity_b`]: h.heapCapacity, [`${p}.objects`]: h.objectCount, [`${p}.protected`]: h.protectedObjectCount, [`${p}.globals`]: h.globalObjectCount })
        for (const [name, count] of Object.entries(h.objectTypeCounts)) flat[`${p}.type.${key(name)}`] = count
        for (const [name, count] of Object.entries(dumped.byConstructor ?? {})) { flat[`${role}.${phase}.ctor.${key(name)}.bytes`] = count.bytes; flat[`${role}.${phase}.ctor.${key(name)}.count`] = count.count }
        if (phase === "ready") { lists.modules[role] = dumped.modules ?? []; lists.embedded[role] = dumped.embedded ?? [] }
      }
      for (const phaseKey of ["fp_mb", "rss_mb"]) flat[`total.${phase}.${phaseKey}`] = +(roles.reduce((sum, role) => sum + (flat[`${role}.${phase}.${phaseKey}`] ?? 0), 0)).toFixed(1)
      if (peaks.length) flat[`total.${phase}.peak_mb`] = +peaks.reduce((a, b) => a + b, 0).toFixed(1)
    }
    await measure("ready")
    // One reply: the faux engine streams what `/say` is given.
    const sentence = "The daemon owns the session log and the client only draws what the events describe, so a frame stays cheap while text streams in. "
    let text = ""
    while (text.length < (input.streamBytes ?? 18_000)) text += sentence.repeat(3) + "\n\n"
    terminal.write("/say ")
    await Bun.sleep(100)
    terminal.write(`\x1b[200~${text.trim()} ENDMARKER\x1b[201~`)
    await Bun.sleep(300)
    terminal.write("\r")
    await until(() => screen.text().includes("ENDMARKER"), "reply marker", 120_000)
    await Bun.sleep(3000)
    await measure("after")
    await Bun.sleep(input.restSeconds * 1000)
    await measure("rest")
  } finally {
    const live = roles.map((role) => pids[role])
    for (const pid of live) try { process.kill(pid, "SIGTERM") } catch {}
    await Promise.race([Promise.all([cli.exited, daemon?.exited]), Bun.sleep(5000)])
    for (const pid of live) try { process.kill(pid, "SIGKILL") } catch {}
    terminal.close()
  }
  Object.assign(flat, diskBytes(dir))
  derive(flat)
  flat["binary.bytes"] = statSync(input.binary).size
  rmSync(root, { recursive: true, force: true })
  return { flat, lists }
}

/** Metrics computed from the others: the snapshot's bytes without compiled code (which moves with the JIT's timing) are the stable measure of what the program holds. */
export function derive(flat: Flat): Flat {
  for (const role of ["tui", "daemon"]) {
    for (const phase of PHASES) {
      const prefix = `${role}.${phase}.ctor.`
      const keys = Object.keys(flat).filter((name) => name.startsWith(prefix) && name.endsWith(".bytes"))
      if (!keys.length) continue
      flat[`${role}.${phase}.js_live_b`] = keys.filter((name) => !name.startsWith(`${prefix}code:`)).reduce((sum, name) => sum + flat[name]!, 0)
      flat[`${role}.${phase}.js_code_b`] = keys.filter((name) => name.startsWith(`${prefix}code:`)).reduce((sum, name) => sum + flat[name]!, 0)
    }
  }
  return flat
}

/** Every column of every row of the sessions, per table (the README's metric; the same sum as bench/real.ts). */
export function diskBytes(dir: string): Flat {
  const out: Flat = {}
  const db = new Database(path.join(dir, "mendd.db"), { readonly: true })
  try {
    const ids = db.query<{ id: string }, []>("SELECT id FROM sessions").all().map((row) => row.id)
    let total = 0
    for (const { name } of db.query<{ name: string }, []>("select name from sqlite_master where type='table' and name not like 'sqlite_%'").all()) {
      const cols = db.query<{ name: string }, []>(`pragma table_info("${name}")`).all().map((c) => c.name)
      const expr = cols.map((c) => `coalesce(length(cast("${c}" as blob)),0)`).join("+")
      if (name === "sessions") { const b = db.query<{ b: number }, []>(`select coalesce(sum(${expr}),0) b from sessions`).get()!.b; out["disk.table.sessions"] = b; total += b; continue }
      if (!cols.includes("session_id") || !ids.length) continue
      const b = db.query<{ b: number }, []>(`select coalesce(sum(${expr}),0) b from "${name}"`).get()!.b
      if (b) { out[`disk.table.${name}`] = b; total += b }
    }
    out["disk.bytes"] = total
    out["disk.bytes_per_session"] = ids.length ? Math.round(total / ids.length) : total
  } finally { db.close() }
  return out
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Comparison

export type Noise = { schema: number; runs: number; measuredAt: string; build: string; range: Record<string, number> }

const unitOf = (name: string) => /_mb$|\.region\./.test(name) ? "MB" : /_b$|\.bytes|\.bytes_per_session|bytes$/.test(name) ? "B" : /cpu_ms/.test(name) ? "ms" : "n"
/** Noise to expect for a metric when calibration has not seen it: a fraction of its value and a floor in its unit. */
function fallbackNoise(name: string, a: number, b: number) {
  const unit = unitOf(name)
  const floor = unit === "MB" ? 0.5 : unit === "B" ? 4096 : unit === "ms" ? 150 : 20
  return Math.max(floor, 0.05 * Math.max(Math.abs(a), Math.abs(b)))
}

export type Row = { name: string; base: number; cand: number; delta: number; threshold: number; status: "up" | "down" | "same" }

export function compare(base: Flat[], cand: Flat[], noise: Noise | undefined): Row[] {
  const names = new Set([...base.flatMap(Object.keys), ...cand.flatMap(Object.keys)])
  const median = (runs: Flat[], name: string) => { const values = runs.map((run) => run[name] ?? 0); return spread(values).median }
  const rows: Row[] = []
  for (const name of names) {
    const a = median(base, name), b = median(cand, name)
    const seen = noise?.range[name]
    const threshold = seen === undefined ? fallbackNoise(name, a, b) : Math.max(seen * 1.5, unitOf(name) === "MB" ? 0.2 : 0)
    const delta = +(b - a).toFixed(2)
    rows.push({ name, base: a, cand: b, delta, threshold: +threshold.toFixed(2), status: Math.abs(delta) <= threshold ? "same" : delta > 0 ? "up" : "down" })
  }
  return rows
}

/** Range (max - min) of each metric across the runs of one build, maximum over the builds given. */
export function noiseFrom(sides: Flat[][]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const runs of sides) for (const name of new Set(runs.flatMap(Object.keys))) { const v = runs.map((run) => run[name] ?? 0); out[name] = Math.max(out[name] ?? 0, Math.max(...v) - Math.min(...v)) }
  return out
}

/** The metric families of the report, in order. */
const SUMMARY: Array<[string, RegExp]> = [
  ["footprint", /^(total|tui|daemon)\.(ready|after|rest)\.(fp_mb|peak_mb)$/],
  ["rss", /^(total|tui|daemon)\.(ready|after|rest)\.rss_mb$/],
  ["js heap", /^(tui|daemon)\.(ready|after|rest)\.heap\.(size_b|extra_b|objects|protected)$|^(tui|daemon)\.rest\.js_(live|code)_b$/],
  ["cpu", /\.cpu_ms\./],
  ["disk and binary", /^(disk\.bytes|disk\.bytes_per_session|binary\.bytes)$/],
]

function explain(rows: Row[]) {
  const up = (re: RegExp, limit: number) => rows.filter((r) => re.test(r.name) && r.status === "up").sort((a, b) => b.delta - a.delta).slice(0, limit)
  return {
    regions: up(/\.region\./, 4),
    types: up(/\.heap\.type\./, 4),
    constructors: up(/\.ctor\..*\.bytes$/, 4),
    tables: up(/^disk\.table\./, 3),
  }
}

/**
 * What a user pays for, and so what can make a change `sube`: each process's physical footprint, CPU per phase and the bytes a
 * session stores. The JS heap's inner counts and the binary's size are the parts that explain those totals: a rise there with no
 * total above the noise is a `nota` (shown, never a blocker). The binary may grow with new code (the owner's rule).
 */
const TOTALS = /^(total|tui|daemon)\.(ready|after|rest)\.(fp_mb|peak_mb)$|\.cpu_ms\.|^disk\.bytes(_per_session)?$/

export function verdict(rows: Row[]) {
  // RSS is shown, never judged: macOS reclaims pages, so it moves 10 MB or more between identical runs (docs/performance.md).
  const judged = (row: Row) => !row.name.includes("rss_mb") && SUMMARY.some(([, re]) => re.test(row.name))
  const ups = rows.filter((row) => row.status === "up" && judged(row))
  const reds = ups.filter((row) => TOTALS.test(row.name))
  const downs = rows.filter((row) => row.status === "down" && judged(row))
  const why = explain(rows)
  const fmt = (r: Row) => `${r.name} ${r.delta > 0 ? "+" : ""}${r.delta}${unitOf(r.name) === "n" ? "" : unitOf(r.name)}`
  const causes = () => [...why.regions, ...why.types, ...why.constructors, ...why.tables].map(fmt).join("; ") || "none above noise"
  const top = (list: Row[]) => [...list].sort((a, b) => b.delta / b.threshold - a.delta / a.threshold).slice(0, 3)
  if (reds.length) return { word: "sube" as const, text: `sube: ${top(reds).map(fmt).join("; ")}. Causes: ${causes()}` }
  if (ups.length) return { word: "nota" as const, text: `nota: no total rose; inside, ${top(ups).map(fmt).join("; ")}${downs.length ? `; lower: ${downs.slice(0, 3).map(fmt).join("; ")}` : ""}` }
  if (downs.length) return { word: "baja" as const, text: `baja: ${downs.slice(0, 3).map(fmt).join("; ")}` }
  return { word: "igual" as const, text: "igual: nothing above the measured noise" }
}

export function toJson(input: { base: string; cand: string; rounds: number; rows: Row[]; noise: Noise | undefined; extra: Record<string, unknown> }) {
  return { schema: SCHEMA_VERSION, base: input.base, cand: input.cand, rounds: input.rounds, noise: input.noise ? { runs: input.noise.runs, measuredAt: input.noise.measuredAt } : null, verdict: verdict(input.rows), reference: REFERENCE, ...input.extra, metrics: Object.fromEntries(input.rows.map((r) => [r.name, { base: r.base, cand: r.cand, delta: r.delta, threshold: r.threshold, status: r.status }])) }
}

export function toMarkdown(input: { base: string; cand: string; rounds: number; rows: Row[]; noise: Noise | undefined; extra?: { modules?: ReturnType<typeof moduleDiff> } }) {
  const v = verdict(input.rows)
  const hasDaemon = input.rows.some((row) => row.name.startsWith("daemon."))
  const get = (name: string) => input.rows.find((r) => r.name === name)
  const cell = (r: Row | undefined) => r ? `${r.base} | ${r.cand} | ${r.delta > 0 ? "+" : ""}${r.delta}${r.status === "up" ? " **UP**" : r.status === "down" ? " down" : ""}` : "- | - | -"
  const lines = [`**perf-attrib: ${v.text}**`, "", `base \`${input.base}\` vs cand \`${input.cand}\`, median of ${input.rounds} faux-engine session(s) per side; flagged = beyond ${input.noise ? `the noise measured on ${input.noise.runs} base-vs-base runs (x1.5)` : "a default threshold (no calibration file)"}.`, "", "| metric | base | cand | diff |", "|---|---:|---:|---:|"]
  for (const [, re] of SUMMARY) for (const r of input.rows.filter((row) => re.test(row.name) && (hasDaemon || !row.name.startsWith("total."))).sort((a, b) => a.name.localeCompare(b.name))) lines.push(`| ${r.name} | ${cell(r)} |`)
  const why = explain(input.rows)
  const block = (title: string, rows: Row[]) => { if (rows.length) { lines.push("", `${title}:`, ...rows.map((r) => `- ${r.name}: ${r.base} -> ${r.cand} (${r.delta > 0 ? "+" : ""}${r.delta})`)) } }
  block("Native regions that rose", why.regions); block("JS object types that rose (count)", why.types); block("JS heap bytes by constructor that rose", why.constructors); block("Disk tables that rose", why.tables)
  if (input.extra?.modules) { const m = input.extra.modules; lines.push("", `Modules loaded at start: ${m.baseCount} -> ${m.candCount}, ${m.baseBytes} -> ${m.candBytes} bytes of chunks${m.addedChunkSizes.length || m.removedChunkSizes.length ? `; chunk sizes only in cand: [${m.addedChunkSizes.slice(0, 8).join(", ")}], only in base: [${m.removedChunkSizes.slice(0, 8).join(", ")}]` : ""} (chunk names are hashes: the list says which changed in size, not by what name)`) }
  const g = (n: string) => get(n)?.cand
  lines.push("", `Reference (skill, 2026-11-03, real model): footprint 64 ready / 66 after / peak 80 MB, 2.6 KB per session. This run (faux engine, whole process tree): ${g("total.ready.fp_mb")} / ${g("total.after.fp_mb")} / peak ${g("total.rest.peak_mb")} MB, ${g("disk.bytes_per_session")} B per session.`)
  void get
  return lines.join("\n")
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Inputs: a compiled binary, or a commit built in a temporary worktree

/** Where `--cache` keeps the build of commit `sha`: one file per commit, platform and arch. */
export const cacheFile = (cache: string, sha: string) => path.join(cache, `${sha}-${process.platform}-${process.arch}`)

/** A cached build of `sha` copied to `into`, or undefined when there is none. */
export function takeCached(cache: string | undefined, sha: string, into: string): string | undefined {
  if (!cache) return undefined
  const file = cacheFile(cache, sha)
  if (!existsSync(file) || !statSync(file).isFile()) return undefined
  copyFileSync(file, into)
  return into
}

/** Keeps a fresh build in the cache; written beside its name and renamed, so a killed run never leaves half a binary under the real name. */
export function keepBuilt(cache: string | undefined, sha: string, binary: string) {
  if (!cache) return
  mkdirSync(cache, { recursive: true })
  const file = cacheFile(cache, sha)
  const partial = `${file}.part-${process.pid}`
  copyFileSync(binary, partial)
  renameSync(partial, file)
}

async function resolveBuild(spec: string, scratch: string, label: string, cleanups: Array<() => void>, cache?: string) {
  const asFile = path.resolve(spec)
  if (existsSync(asFile) && statSync(asFile).isFile()) { const copy = path.join(scratch, label); copyFileSync(asFile, copy); return { binary: copy, name: spec } }
  const sha = Bun.spawnSync(["git", "-C", REPO, "rev-parse", "--verify", `${spec}^{commit}`]).stdout.toString().trim()
  if (!sha) throw new Error(`perf-attrib: ${spec} is neither a file nor a commit`)
  const hit = takeCached(cache, sha, path.join(scratch, label))
  if (hit) return { binary: hit, name: `${spec} (${sha.slice(0, 8)}, cached build)` }
  const tree = path.join(scratch, `tree-${label}`)
  const added = Bun.spawnSync(["git", "-C", REPO, "worktree", "add", "--detach", tree, sha])
  if (added.exitCode !== 0) throw new Error(`git worktree add failed: ${added.stderr.toString()}`)
  cleanups.push(() => { Bun.spawnSync(["git", "-C", REPO, "worktree", "remove", "--force", tree]) })
  for (const argv of [["bun", "install", "--frozen-lockfile"], ["bun", "scripts/build.ts", "--outfile", path.join(scratch, label)]]) {
    const run = Bun.spawnSync(argv, { cwd: tree, stdout: "ignore", stderr: "pipe" })
    if (run.exitCode !== 0) throw new Error(`${argv.join(" ")} failed in ${spec}: ${run.stderr.toString().slice(-500)}`)
  }
  keepBuilt(cache, sha, path.join(scratch, label))
  return { binary: path.join(scratch, label), name: `${spec} (${sha.slice(0, 8)})` }
}

/** Modules loaded when the process is ready. A compiled build splits into hash-named chunks, so chunks are told apart by size: those whose size has no match on the other side are the ones that changed. */
export function moduleDiff(base: Array<[string, number]> | undefined, cand: Array<[string, number]> | undefined) {
  if (!base?.length || !cand?.length) return null
  const sizes = (list: Array<[string, number]>) => { const m = new Map<number, number>(); for (const [, size] of list) if (size) m.set(size, (m.get(size) ?? 0) + 1); return m }
  const unmatched = (a: Map<number, number>, b: Map<number, number>) => [...a].flatMap(([size, n]) => Array(Math.max(0, n - (b.get(size) ?? 0))).fill(size) as number[]).sort((x, y) => y - x)
  const a = sizes(base), b = sizes(cand)
  const bytes = (list: Array<[string, number]>) => list.reduce((sum, [, size]) => sum + size, 0)
  return { baseCount: base.length, candCount: cand.length, baseBytes: bytes(base), candBytes: bytes(cand), addedChunkSizes: unmatched(b, a), removedChunkSizes: unmatched(a, b) }
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const flag = (name: string) => { const at = argv.indexOf(`--${name}`); return at >= 0 ? argv[at + 1] : undefined }
  const has = (name: string) => argv.includes(`--${name}`)
  const rounds = Number(flag("rounds") ?? (flag("calibrate") ? 3 : 2))
  const restSeconds = Number(flag("rest") ?? 20)
  const layout = (flag("layout") ?? "solo") as "solo" | "split"
  const scratch = realpathSync(mkdtempSync(path.join(tmpdir(), "perf-attrib-")))
  const cleanups: Array<() => void> = []
  const out = flag("out") ? path.resolve(flag("out")!) : undefined
  const cache = flag("cache") ? path.resolve(flag("cache")!) : undefined
  if (out) mkdirSync(out, { recursive: true })
  let exit = 0
  try {
    const calibrate = flag("calibrate")
    const baseSpec = calibrate ?? flag("base") ?? flag("rescore") ?? (() => { throw new Error("usage: perf-attrib --base REF|BINARY --cand REF|BINARY | --calibrate BINARY") })()
    const candSpec = calibrate ?? flag("cand") ?? flag("rescore") ?? (() => { throw new Error("perf-attrib: --cand is required") })()
    const rescore = flag("rescore")
    const base = rescore ? { binary: "", name: baseSpec } : await resolveBuild(baseSpec, scratch, "base", cleanups, cache)
    const cand = rescore ? { binary: "", name: candSpec } : calibrate ? { binary: base.binary, name: base.name } : await resolveBuild(candSpec, scratch, "cand", cleanups, cache)
    const runs: { base: Flat[]; cand: Flat[] } = { base: [], cand: [] }
    let modules: ReturnType<typeof moduleDiff> = null
    const firstLists: Record<string, Awaited<ReturnType<typeof measureRun>>["lists"]> = {}
    // Alternate the sides within each round so a drifting machine hits both alike.
    if (rescore) for (const side of ["base", "cand"] as const) for (let i = 0; existsSync(path.join(rescore, `run-${side}-${i}.json`)); i++) runs[side].push(derive(JSON.parse(readFileSync(path.join(rescore, `run-${side}-${i}.json`), "utf8")) as Flat))
    for (let round = 0; !rescore && round < rounds; round++) {
      for (const side of (round % 2 ? ["cand", "base"] : ["base", "cand"]) as Array<"base" | "cand">) {
        const result = await measureRun({ binary: side === "base" ? base.binary : cand.binary, restSeconds, layout })
        runs[side].push(result.flat)
        firstLists[side] ??= result.lists
        console.error(`round ${round + 1}/${rounds} ${side}: total fp ready ${result.flat["total.ready.fp_mb"]} after ${result.flat["total.after.fp_mb"]} rest ${result.flat["total.rest.fp_mb"]} MB`)
        if (out) writeFileSync(path.join(out, `run-${side}-${round}.json`), JSON.stringify(result.flat))
      }
    }
    modules = moduleDiff(firstLists.base?.modules.tui, firstLists.cand?.modules.tui)
    if (calibrate || has("write-noise")) {
      const noise: Noise = { schema: SCHEMA_VERSION, runs: runs.base.length + runs.cand.length, measuredAt: new Date().toISOString(), build: path.basename(base.name), range: noiseFrom([runs.base, runs.cand]) }
      writeFileSync(NOISE_FILE, JSON.stringify(noise))
      const cmp = compare(runs.base, runs.cand, noise)
      const pick = ["total.ready.fp_mb", "total.after.fp_mb", "total.rest.fp_mb", "tui.rest.fp_mb", "daemon.rest.fp_mb", "tui.rest.heap.size_b", "daemon.rest.heap.size_b", "tui.rest.heap.objects", "daemon.rest.heap.objects", "tui.rest.heap.extra_b", "daemon.rest.heap.extra_b"]
      const table = pick.map((name) => { const values = [...runs.base, ...runs.cand].map((run) => run[name] ?? 0); const med = spread(values).median; return { name, median: med, range: noise.range[name], relativePct: +((noise.range[name]! / (med || 1)) * 100).toFixed(2) } })
      console.log(JSON.stringify({ schema: SCHEMA_VERSION, calibratedOn: base.name, runs: noise.runs, noiseFile: path.relative(REPO, NOISE_FILE), keyMetrics: table, baseVsBaseReds: cmp.filter((r) => r.status !== "same").map((r) => r.name) }, null, 2))
    } else {
      const noise = existsSync(NOISE_FILE) ? JSON.parse(readFileSync(NOISE_FILE, "utf8")) as Noise : undefined
      const rows = compare(runs.base, runs.cand, noise)
      const info = { base: base.name, cand: cand.name, rounds: runs.base.length, rows, noise, extra: { modules } }
      if (has("markdown")) console.log(toMarkdown({ ...info, extra: { modules } }))
      if (has("json") || !has("markdown")) console.log(JSON.stringify(toJson({ ...info, extra: { modules } }), null, has("json") ? 0 : 2))
      if (out) { writeFileSync(path.join(out, "report.md"), toMarkdown({ ...info, extra: { modules } })); writeFileSync(path.join(out, "report.json"), JSON.stringify(toJson({ ...info, extra: { modules } }))) }
      if (verdict(rows).word === "sube") exit = 1
    }
  } finally {
    for (const cleanup of cleanups) try { cleanup() } catch {}
    if (!has("keep")) rmSync(scratch, { recursive: true, force: true })
  }
  process.exit(exit)
}
