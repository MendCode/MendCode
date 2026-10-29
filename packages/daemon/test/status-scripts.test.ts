import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { realClock } from "@mendcode/kernel"
import type { ExtensionLayer } from "@mendcode/packages"
import type { GlobalEvent } from "@mendcode/protocol"
import { startDaemon } from "../src"
import { createStatusScripts, parseStatusOutput, parseStatusRows, statusScripts, usageJson, type StatusLine } from "../src/status-scripts"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function temp(prefix: string) {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function write(file: string, text: string, executable = false) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
  if (executable) chmodSync(file, 0o755)
}

async function until(check: () => boolean, ms = 5_000) {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timeout waiting for condition")
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe("status script output", () => {
  test("JSON segments keep valid hex colors and bold; bad entries are skipped", () => {
    expect(parseStatusOutput('{"segments":[{"text":"dev","fg":"#86efac","bold":true},{"text":" · clean","fg":"red"},{"nope":1}]}')).toEqual([
      { text: "dev", fg: "#86efac", bold: true },
      { text: " · clean" },
    ])
  })
  test("TSV lines are fg, bold, text; legacy plain text stays one row", () => {
    expect(parseStatusOutput("#86efac\ttrue\tdev\n#a3a3a3\tfalse\t · clean\n")).toEqual([
      { text: "dev", fg: "#86efac", bold: true },
      { text: " · clean", fg: "#a3a3a3" },
    ])
    expect(parseStatusOutput("dev · clean · package:team\nsecond line")).toEqual([{ text: "dev · clean · package:team · second line" }])
    expect(parseStatusOutput("   ")).toEqual([])
  })
  test("escape sequences and control characters are stripped, long text is cut", () => {
    expect(parseStatusOutput("\x1b[31mred\x1b[0m\x07 ok")).toEqual([{ text: "red ok" }])
    expect(parseStatusOutput("x".repeat(500))[0]!.text).toHaveLength(120)
  })
  test("explicit rows preserve segment spacing, colors and bold without empty rows", () => {
    expect(parseStatusRows(JSON.stringify({ rows: [[{ text: "main", fg: "#70ffaf", bold: true }, { text: " · clean" }], [], null, [{ text: "checks", fg: "red" }, { nope: true }]] }))).toEqual([
      [{ text: "main", fg: "#70ffaf", bold: true }, { text: " · clean" }], [{ text: "checks" }],
    ])
    for (const output of ["hello\nworld", '[{"text":"legacy"}]', '{"segments":[{"text":"legacy"}]}', '{"rows":null}', "null"]) expect(parseStatusRows(output)).toBeUndefined()
    expect(parseStatusRows('{"rows":[[],[{"text":" "}]]}')).toEqual([])
  })
  test("rows enforce v1's 4 rows, 32 segments and 240 characters; terminal controls cannot create rows", () => {
    const rows = parseStatusRows(JSON.stringify({ rows: Array.from({ length: 5 }, () => Array.from({ length: 33 }, () => ({ text: "x".repeat(300), fg: "#fff", bold: true }))) }))!
    expect(rows).toHaveLength(4)
    expect(rows.every((row) => row.length === 32 && row.every((segment) => segment.text.length === 240))).toBe(true)
    expect(parseStatusRows(JSON.stringify({ rows: [[{ text: "a\n\t\rb\x1b[31mred\x1b[0m\x1b]0;title\x1b\\\x07" }]] }))).toEqual([[{ text: "a   bred" }]])
  })
  test("legacy arrays, JSON with embedded newlines and TSV bold 1 remain single-line", () => {
    expect(parseStatusOutput('[{"text":"a\\nb","bold":true}]')).toEqual([{ text: "a b", bold: true }])
    expect(parseStatusOutput("#fff\t1\tchecks")).toEqual([{ text: "checks", fg: "#fff", bold: true }])
  })
})

describe("statusline.json layers", () => {
  test("project layers can disable inherited scripts and prepend a side", () => {
    const user = temp("status-user-")
    const project = temp("status-proj-")
    write(path.join(user, "statusline.json"), JSON.stringify({ left: { command: ["echo", "user"] } }))
    write(path.join(project, "statusline.json"), JSON.stringify({ left: { enabled: false }, right: { command: ["echo", "checks"], prepend: true } }))
    const report = statusScripts([{ dir: user, source: "user" }, { dir: project, source: "project" }])
    expect(report.problems).toEqual([])
    expect(report.scripts).toHaveLength(1)
    expect(report.scripts[0]).toMatchObject({ side: "right", prepend: true, command: ["echo", "checks"] })
  })
  test("a later layer replaces a side; ./ parts resolve to the layer folder; invalid files are problems", () => {
    const user = temp("status-user-")
    const project = temp("status-proj-")
    write(path.join(user, "statusline.json"), JSON.stringify({ left: { command: ["./left.sh"] }, right: { command: ["echo", "user"], refreshMs: 2_000 } }))
    write(path.join(project, ".mendcode", "statusline.json"), JSON.stringify({ right: { command: ["echo", "project"] } }))
    const layers: ExtensionLayer[] = [
      { dir: user, source: "user" },
      { dir: path.join(project, ".mendcode"), source: "project" },
    ]
    const { scripts, problems } = statusScripts(layers)
    expect(problems).toEqual([])
    expect(scripts.map((s) => [s.side, s.command, s.source])).toEqual([
      ["left", [path.join(user, "left.sh")], "user"],
      ["right", ["echo", "project"], "project"],
    ])
    write(path.join(project, ".mendcode", "statusline.json"), JSON.stringify({ right: { command: [], refreshMs: 10 } }))
    expect(statusScripts(layers).problems[0]).toContain("right.command")
  })
})

describe("status script runner", () => {
  const collect = () => {
    const lines: StatusLine[] = []
    return { lines, publish: (line: StatusLine) => void lines.push(line) }
  }

  test("runs while watched, publishes changes only, and stops when the last watcher leaves", async () => {
    const user = temp("status-run-")
    const project = temp("status-run-proj-")
    const counter = path.join(user, "count")
    write(path.join(user, "status.sh"), `#!/bin/sh\necho x >> "${counter}"\nprintf 'dev'\n`, true)
    write(path.join(user, "statusline.json"), JSON.stringify({ left: { command: ["./status.sh"], refreshMs: 1_000 } }))
    const { lines, publish } = collect()
    const runner = createStatusScripts({ clock: realClock, layersFor: () => [{ dir: user, source: "user" }], isTrusted: () => false, publish })
    cleanups.push(() => runner.stop())
    const unwatch = runner.watch(project)
    const second = runner.watch(project)
    await until(() => lines.some((line) => line.left.length > 0))
    expect(lines.filter((line) => line.left.length)[0]).toEqual({ directory: project, left: [{ text: "dev" }], right: [], problems: [] })
    unwatch()
    expect(runner.active()).toEqual([project])
    second()
    expect(runner.active()).toEqual([])
  })

  test("project scripts wait for trust and say so", async () => {
    const project = temp("status-trust-")
    write(path.join(project, ".mendcode", "statusline.json"), JSON.stringify({ right: { command: ["echo", "branch"] } }))
    const { lines, publish } = collect()
    const layers = () => [{ dir: path.join(project, ".mendcode"), source: "project" as const }]
    const untrusted = createStatusScripts({ clock: realClock, layersFor: layers, isTrusted: () => false, publish })
    cleanups.push(() => untrusted.stop())
    untrusted.watch(project)
    expect(lines[0]!.problems).toEqual(["project status scripts run once the project is trusted in /tools"])
    const trusted = createStatusScripts({ clock: realClock, layersFor: layers, isTrusted: () => true, publish })
    cleanups.push(() => trusted.stop())
    trusted.watch(project)
    await until(() => lines.some((line) => line.right.length > 0))
    expect(lines.find((line) => line.right.length)!.right).toEqual([{ text: "branch" }])
  })
  test("a watched script advertises rows-v1 and clears rows after legacy output or failure", async () => {
    const user = temp("status-rows-")
    const output = path.join(user, "output")
    write(output, JSON.stringify({ rows: [[{ text: "main" }], [{ text: "checks" }]] }))
    write(path.join(user, "status.sh"), `#!/bin/sh\n[ "$MEND_TUI_STATUS_FORMAT" = rows-v1 ] || exit 1\n[ "$MENDCODE_STATUS_FORMAT" = rows-v1 ] || exit 1\ncat "${output}"\n`, true)
    write(path.join(user, "statusline.json"), JSON.stringify({ left: { command: ["./status.sh"], refreshMs: 1_000, prepend: true } }))
    const { lines, publish } = collect()
    const runner = createStatusScripts({ clock: realClock, layersFor: () => [{ dir: user, source: "user" }], isTrusted: () => false, publish })
    cleanups.push(() => runner.stop())
    runner.watch(user)
    await until(() => lines.some((line) => line.leftRows?.length === 2))
    expect(lines.at(-1)?.leftRows).toEqual([[{ text: "main", prepend: true }], [{ text: "checks", prepend: true }]])
    write(output, "legacy\nsecond")
    await until(() => lines.at(-1)?.left[0]?.text === "legacy · second")
    expect(lines.at(-1)?.leftRows).toBeUndefined()
    write(path.join(user, "status.sh"), "#!/bin/sh\nexit 2\n", true)
    await until(() => lines.at(-1)?.left.length === 0)
    expect(lines.at(-1)?.leftRows).toBeUndefined()
  })
})

describe("usage for scripts", () => {
  const NOW = 1_800_000_000_000
  const snapshots = [
    { provider: "codex", windows: [{ id: "secondary", label: "7d", usedPercent: 8, resetsAt: NOW + 86_400_000 }], fetchedAt: NOW - 1_000, source: "t" },
    { provider: "claude", windows: [{ id: "five_hour", label: "5h", usedPercent: 4 }], fetchedAt: NOW - 3 * 3_600_000, source: "t" },
  ]

  test("MENDCODE_USAGE_JSON names used and left apart, the age, and leaves an unreported window out", () => {
    const parsed = JSON.parse(usageJson(snapshots, NOW))
    expect(parsed.now).toBe(NOW)
    expect(parsed.quota).toEqual([
      { provider: "codex", window: "7d", usedPercent: 8, leftPercent: 92, resetsAt: NOW + 86_400_000, observedAt: NOW - 1_000, ageMs: 1_000, stale: false },
      { provider: "claude", window: "5h", usedPercent: 4, leftPercent: 96, observedAt: NOW - 3 * 3_600_000, ageMs: 3 * 3_600_000, stale: true },
    ])
    expect(JSON.parse(usageJson([], NOW)).quota).toEqual([])
  })

  test("a running script reads it from the environment", async () => {
    const user = temp("status-usage-")
    write(path.join(user, "status.sh"), `#!/bin/sh\nprintf '%s' "$MENDCODE_USAGE_JSON" | grep -o '"leftPercent":[0-9]*' | head -1\n`, true)
    write(path.join(user, "statusline.json"), JSON.stringify({ right: { command: ["./status.sh"], refreshMs: 1_000 } }))
    const lines: StatusLine[] = []
    const runner = createStatusScripts({ clock: realClock, layersFor: () => [{ dir: user, source: "user" }], isTrusted: () => false, publish: (line) => void lines.push(line), quotas: () => snapshots.map((snapshot) => ({ ...snapshot, fetchedAt: Date.now() })) })
    cleanups.push(() => runner.stop())
    runner.watch(user)
    await until(() => lines.some((line) => line.right.length > 0))
    expect(lines.at(-1)?.right[0]?.text).toBe('"leftPercent":92')
  })
})

describe("status.watch over the protocol", () => {
  test("only the watching connection gets status.line, and closing it stops the scripts", async () => {
    const dir = temp("mendd-status-")
    const project = temp("mendd-status-proj-")
    write(path.join(dir, "statusline.json"), JSON.stringify({ right: { command: ["echo", JSON.stringify({ rows: [[{ text: "main · clean" }], [{ text: "checks", fg: "#fff", bold: true }]] })] } }))
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }) })
    cleanups.push(() => daemon.stop())
    const seen: { a: GlobalEvent[]; b: GlobalEvent[] } = { a: [], b: [] }
    const a = createClient({ socketPath: daemon.socketPath, name: "a", reconnect: false, onGlobal: (e) => void seen.a.push(e) })
    const b = createClient({ socketPath: daemon.socketPath, name: "b", reconnect: false, onGlobal: (e) => void seen.b.push(e) })
    await a.connect()
    await b.connect()
    cleanups.push(() => b.close())
    expect(await a.send({ type: "status.watch", directory: project, watching: true })).toMatchObject({ ok: true })
    await until(() => seen.a.some((e) => e.type === "status.line"))
    expect(seen.a.find((e) => e.type === "status.line")).toMatchObject({ directory: project, right: [{ text: "main · clean" }], rightRows: [[{ text: "main · clean" }], [{ text: "checks", fg: "#fff", bold: true }]], gseq: 0 })
    expect(seen.b.some((e) => e.type === "status.line")).toBe(false)
    // Unwatching is acknowledged; the runner's own lifecycle is covered above.
    expect(await a.send({ type: "status.watch", directory: project, watching: false })).toMatchObject({ ok: true })
    a.close()
  })
})
