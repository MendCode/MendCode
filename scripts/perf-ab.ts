// Alternating A/B comparison of two prebuilt builds (`bun scripts/perf.ts --build-to DIR`): per pair it runs the real CLI in a
// PTY (scripts/perf-real.ts) and the in-process probe (scripts/perf.ts), A then B on even pairs and B then A on odd ones, so a
// drifting machine hits both. The table gives each metric's median and range per build; a build whose median or worst value is
// above the other's range is flagged. Raw runs go to --out as JSON (keep that outside the repository).
//   bun scripts/perf-ab.ts --a BASE_DIR --b CANDIDATE_DIR --out DIR [--pairs 5] [--idle-seconds 60] [--focus none|unfocused]
//        [--messages 0,10000] [--no-session] [--no-probe] [--clients]
import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { spread } from "./perf-proc"
import type { RealResult } from "./perf-real"

const ROOT = path.join(import.meta.dir, "..")

/** Numeric leaves of a result as `a.b.c` paths. */
export function flatten(value: unknown, prefix = "", out: Record<string, number> = {}): Record<string, number> {
  if (typeof value === "number") out[prefix] = value
  else if (Array.isArray(value)) value.forEach((item, index) => flatten(item, `${prefix}[${index}]`, out))
  else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) flatten(item, prefix ? `${prefix}.${key}` : key, out)
  return out
}

/** One row per metric: both builds' median and range, and whether B's median is outside A's range on the worse side (`lowerIsBetter` is true for every metric here). */
export function compare(a: readonly Record<string, number>[], b: readonly Record<string, number>[]) {
  const keys = [...new Set([...a.flatMap(Object.keys), ...b.flatMap(Object.keys)])].filter((key) => !/(^|\.)(samples|seconds)$/.test(key))
  return keys.map((key) => {
    const left = spread(a.map((run) => run[key]).filter((value): value is number => value !== undefined))
    const right = spread(b.map((run) => run[key]).filter((value): value is number => value !== undefined))
    const change = left.median === 0 ? 0 : (right.median - left.median) / left.median * 100
    return { key, a: left, b: right, changePct: +change.toFixed(1), worse: right.median > left.max, better: right.median < left.min }
  })
}

export function table(rows: ReturnType<typeof compare>) {
  const fmt = (s: { median: number; min: number; max: number }) => `${s.median} [${s.min}-${s.max}]`
  return rows.map((row) => `${row.worse ? "WORSE " : row.better ? "better" : "      "} ${row.key.padEnd(46)} ${fmt(row.a).padStart(28)} ${fmt(row.b).padStart(28)} ${String(row.changePct).padStart(7)}%`).join("\n")
}

async function json(command: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn(command, { cwd: ROOT, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(`${command.join(" ")} exited ${code}: ${err.slice(0, 400)}`)
  return JSON.parse(out) as unknown
}

if (import.meta.main) {
  const flag = (name: string) => { const at = process.argv.indexOf(`--${name}`); return at >= 0 ? process.argv[at + 1] : undefined }
  const has = (name: string) => process.argv.includes(`--${name}`)
  const need = (name: string) => path.resolve(flag(name) ?? (() => { throw new Error(`perf-ab: --${name} is required`) })())
  const builds = { a: need("a"), b: need("b") }
  const out = need("out")
  /** The real-CLI rig starts its daemon itself, without the launcher's JIT environment; these are the options each build's launcher would give it (JSON object, `--a-daemon-env` / `--b-daemon-env`). */
  const daemonEnv = { a: flag("a-daemon-env"), b: flag("b-daemon-env") }
  mkdirSync(out, { recursive: true })
  const pairs = Number(flag("pairs") ?? 5)
  const results = { a: [] as Record<string, number>[], b: [] as Record<string, number>[] }
  for (let pair = 0; pair < pairs; pair++) {
    for (const side of (pair % 2 === 0 ? ["a", "b"] : ["b", "a"]) as Array<"a" | "b">) {
      const dir = builds[side]
      const flat: Record<string, number> = {}
      if (!has("no-session")) {
        const session = (await json(["bun", "scripts/perf-real.ts", "--binary", path.join(dir, "mendcode"), "--idle-seconds", flag("idle-seconds") ?? "60", ...(flag("focus") ? ["--focus", flag("focus")!] : [])], daemonEnv[side] ? { PERF_DAEMON_ENV: daemonEnv[side]! } : {}) as { runs: RealResult[] }).runs[0]!
        writeFileSync(path.join(out, `session-${side}-${pair}.json`), JSON.stringify(session, null, 1))
        Object.assign(flat, Object.fromEntries(Object.entries(flatten(session)).map(([key, value]) => [`real.${key}`, value])))
      }
      if (!has("no-probe")) {
        const probe = await json(["bun", "scripts/perf.ts", "--prebuilt", dir, "--mode", "daemon", "--messages", flag("messages") ?? "0,10000"]) as { results: unknown[]; cliHelpStartupMs: number }
        writeFileSync(path.join(out, `probe-${side}-${pair}.json`), JSON.stringify(probe, null, 1))
        Object.assign(flat, Object.fromEntries(Object.entries(flatten(probe.results)).map(([key, value]) => [`probe.${key}`, value])), { "probe.cliHelpMs": probe.cliHelpStartupMs })
      }
      if (has("clients")) {
        const clients = await json(["bun", "scripts/perf-real.ts", "--binary", path.join(dir, "mendcode"), "--scenario", "clients"])
        writeFileSync(path.join(out, `clients-${side}-${pair}.json`), JSON.stringify(clients, null, 1))
        Object.assign(flat, Object.fromEntries(Object.entries(flatten((clients as { results: unknown }).results)).map(([key, value]) => [`clients.${key}`, value])))
      }
      results[side].push(flat)
      console.error(`pair ${pair + 1}/${pairs} ${side} done`)
    }
  }
  const rows = compare(results.a, results.b)
  writeFileSync(path.join(out, "compare.json"), JSON.stringify(rows, null, 1))
  const text = table(rows)
  writeFileSync(path.join(out, "compare.txt"), text)
  console.log(text)
}
