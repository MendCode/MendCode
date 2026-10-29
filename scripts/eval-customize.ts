// Live eval: does a model change what the user sees in MendCode's terminal from a plain-language request, on the first try?
//
// Each case runs the source CLI headless (`mendcode run … --approve`) against a daemon of its own: a fresh temp data dir, a fresh
// temp HOME and a fresh temp project, so nothing of the operator's install is read or written. The only link to the operator's
// machine is the ChatGPT login: `~/.codex/auth.json` (and the model catalog cache) is symlinked into the temp HOME, the way the
// harness eval kit does it (.agents/evals/harness/adapters/common.ts); this script never reads it. A `mendcode` on PATH runs the
// same source CLI, so `mendcode docs …` from the model's shell reads this checkout's cards and the temp data dir.
// The check reads <data dir>/tui/profile.json after the turn: the request passes when the keys it names hold the expected values.
//
//   bun scripts/eval-customize.ts [--model chatgpt/gpt-6-luna] [--tier balanced] [--set main|heldout|all] [--cases id,id] [--parallel 4] [--runs 1] [--out DIR] [--keep]
import { spawn, type ChildProcess } from "node:child_process"
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { TUI_DEFAULTS } from "../packages/protocol/src/tui-data"
import { THEMES } from "../apps/cli/src/themes"

type Profile = Record<string, unknown>
export type EvalCase = { id: string; prompt: string; expect: string; check: (profile: Profile) => boolean }

const LIGHT_THEMES = new Set(THEMES.filter((theme) => theme.dark === false).map((theme) => theme.name))
const is = (key: string, value: unknown) => (profile: Profile) => JSON.stringify(profile[key]) === JSON.stringify(value)
const all = (...checks: Array<(profile: Profile) => boolean>) => (profile: Profile) => checks.every((check) => check(profile))

/** Twenty requests a user types, half in Spanish; each names something on screen, never a key. */
export const CASES: readonly EvalCase[] = [
  { id: "topbar-panel", prompt: "quita la barra de arriba de la sesión y el header del panel", expect: "showTopbar false, panelHeader false", check: all(is("showTopbar", false), is("panelHeader", false)) },
  { id: "footer", prompt: "hide the footer under the prompt", expect: "showStatus false", check: is("showStatus", false) },
  { id: "rounded", prompt: "make the prompt box border rounded", expect: "promptBorder rounded", check: is("promptBorder", "rounded") },
  { id: "light-theme", prompt: "cambia el tema a uno claro", expect: "theme: a light theme", check: (profile) => LIGHT_THEMES.has(String(profile.theme)) },
  { id: "timestamps", prompt: "muestra la hora en cada mensaje", expect: "timestamps true", check: is("timestamps", true) },
  { id: "sidebar-right", prompt: "move the sessions sidebar to the right side", expect: "sidebarSide right", check: is("sidebarSide", "right") },
  { id: "user-label", prompt: "change the label on my messages to 'yo'", expect: "username \"yo\" shown (showUsername true)", check: (profile) => String(profile.username).toLowerCase() === "yo" && profile.showUsername === true },
  { id: "scrollbar", prompt: "quiero ver siempre la barra de desplazamiento del chat", expect: "scrollbar always", check: is("scrollbar", "always") },
  { id: "model-name", prompt: "oculta el nombre del modelo y el proveedor de la barra de estado", expect: "showModel false, showProvider false", check: all(is("showModel", false), is("showProvider", false)) },
  { id: "compact", prompt: "make everything more compact, less spacing", expect: "density compact", check: is("density", "compact") },
  { id: "session-title", prompt: "no quiero ver el título de la sesión arriba", expect: "showSessionTitle false (or showTopbar false)", check: (profile) => profile.showSessionTitle === false || profile.showTopbar === false },
  { id: "home-logo", prompt: "remove the big MENDCODE logo from the start screen", expect: "logoKind none", check: is("logoKind", "none") },
  { id: "product-name", prompt: "en la pantalla de inicio cambia el nombre MendCode por 'Forge'", expect: "productName Forge", check: is("productName", "Forge") },
  { id: "reasoning", prompt: "hide the model's thinking/reasoning blocks in the chat", expect: "reasoning hidden", check: is("reasoning", "hidden") },
  { id: "activity", prompt: "quita la línea de actividad que dice qué está haciendo mientras trabaja", expect: "showActivity false or activityPlacement off", check: (profile) => profile.showActivity === false || profile.activityPlacement === "off" },
  { id: "assistant-label", prompt: "put the label 'Mend' in front of the assistant's answers", expect: "assistantName \"Mend\"", check: is("assistantName", "Mend") },
  { id: "prompt-lead", prompt: "cambia el símbolo ❭ del prompt por >", expect: "promptLead \">\"", check: is("promptLead", ">") },
  { id: "context-bar", prompt: "hide the context usage bar at the top", expect: "contextBar off (or showContext false)", check: (profile) => profile.contextBar === "off" || profile.showContext === false },
  { id: "pinned-prompt", prompt: "deja de fijar mi último mensaje arriba cuando hago scroll", expect: "stickyPrompt false", check: is("stickyPrompt", false) },
  { id: "jump-pill", prompt: "hide the 'jump to latest' button that appears when I scroll up", expect: "jumpHint off", check: is("jumpHint", "off") },
]

/**
 * Ten more, written after the descriptions, cards and keys were tuned on the twenty above and never used to tune them: `--set heldout`
 * measures whether the tuning carries over to requests it did not see.
 */
export const HELDOUT: readonly EvalCase[] = [
  { id: "sidebar-title", prompt: "quita el título 'Sessions' de la lista de sesiones de la izquierda", expect: "sidebarHeader false", check: is("sidebarHeader", false) },
  { id: "placeholder-off", prompt: "remove the example text that shows in the empty prompt", expect: "showPlaceholder false", check: is("showPlaceholder", false) },
  { id: "home-sessions", prompt: "en la pantalla de inicio no muestres la lista de sesiones, solo el logo", expect: "homePanel false", check: is("homePanel", false) },
  { id: "tasks-off", prompt: "hide the list of running background commands above the input box", expect: "showTasks false", check: is("showTasks", false) },
  { id: "double-border", prompt: "pon el borde del cuadro de texto doble", expect: "promptBorder double", check: is("promptBorder", "double") },
  { id: "permission-footer", prompt: "don't show the permission mode in the status line", expect: "showPermission false", check: is("showPermission", false) },
  { id: "home-header", prompt: "quita la primera fila de la pantalla de inicio con la carpeta y la versión", expect: "homeHeader false", check: is("homeHeader", false) },
  { id: "placeholder-text", prompt: "set the empty prompt hint to 'What are we building?'", expect: "placeholderText", check: (profile) => String(profile.placeholderText).replace(/[.'"]/g, "") === "What are we building?" },
  { id: "tagline", prompt: "agrega el texto 'hecho en Panamá' debajo del logo de inicio", expect: "tagline", check: (profile) => String(profile.tagline).toLowerCase().includes("panamá") },
  { id: "elapsed-off", prompt: "while you work, stop showing how many seconds have passed", expect: "showElapsed false (or activityParts without elapsed)", check: (profile) => profile.showElapsed === false || !String(profile.activityParts).split(",").includes("elapsed") },
]

type Flags = { model: string; tier: string; set: string; cases: string[]; parallel: number; runs: number; out: string; keep: boolean; timeoutMs: number }

function flags(argv: string[]): Flags {
  const value = (name: string) => {
    const at = argv.indexOf(`--${name}`)
    return at >= 0 ? argv[at + 1] : undefined
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  return {
    model: value("model") ?? "chatgpt/gpt-6-luna",
    tier: value("tier") ?? "balanced",
    set: value("set") ?? "main",
    cases: value("cases")?.split(",").filter(Boolean) ?? [],
    parallel: Math.max(1, Number(value("parallel") ?? 4)),
    runs: Math.max(1, Number(value("runs") ?? 1)),
    out: path.resolve(value("out") ?? path.join(tmpdir(), `mendcode-eval-customize-${stamp}`)),
    keep: argv.includes("--keep"),
    timeoutMs: Number(value("timeout") ?? 300) * 1000,
  }
}

const REPO = path.resolve(import.meta.dir, "..")
const CLI = path.join(REPO, "apps/cli/src/main.ts")
const DAEMON = path.join(REPO, "packages/daemon/src/main.ts")
const PASSTHROUGH = ["TMPDIR", "LANG", "LC_ALL", "USER", "LOGNAME", "TZ"] as const

/** The environment of one case: no operator HOME, no API keys, no installed `mendcode`; the temp dirs and a PATH with the source CLI. */
function caseEnv(root: string, home: string, dataDir: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of PASSTHROUGH) if (process.env[key] !== undefined) env[key] = process.env[key]!
  const bin = path.join(root, "bin")
  mkdirSync(bin, { recursive: true })
  writeFileSync(path.join(bin, "mendcode"), `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`, { mode: 0o755 })
  return {
    ...env,
    HOME: home,
    SHELL: "/bin/sh",
    PATH: [bin, path.dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin", "/opt/homebrew/bin"].join(":"),
    MENDCODE_V2_DIR: dataDir,
    TERM: "dumb",
    NO_COLOR: "1",
    CI: "1",
    MENDCODE_CLAUDE: "0",
    MENDCODE_WEB_SEARCH: "0",
    MENDCODE_IMAGE_GEN: "0",
    MENDCODE_COMPUTER: "0",
    MENDCODE_BROWSER: "0",
    MENDCODE_TRACE: "0",
  }
}

/** Links the ChatGPT login into the temp HOME (symlinks, never a read or a copy). */
function linkLogin(home: string) {
  const source = path.join(homedir(), ".codex")
  const target = path.join(home, ".codex")
  mkdirSync(target, { recursive: true, mode: 0o700 })
  if (!existsSync(path.join(source, "auth.json"))) throw new Error("[EVAL]: no ChatGPT login in ~/.codex (auth.json); log in with Codex first")
  for (const name of ["auth.json", "models_cache.json"]) if (existsSync(path.join(source, name))) symlinkSync(path.join(source, name), path.join(target, name))
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

async function stop(child: ChildProcess | undefined) {
  const pid = child?.pid
  if (!pid) return
  const signal = (name: NodeJS.Signals) => { try { process.kill(-pid, name) } catch { /* gone */ } }
  signal("SIGTERM")
  for (let waited = 0; waited < 10_000 && alive(pid); waited += 100) await Bun.sleep(100)
  if (alive(pid)) signal("SIGKILL")
}

async function listening(socket: string) {
  try { const s = await Bun.connect({ unix: socket, socket: { data() {} } }); s.end(); return true } catch { return false }
}

type ToolCall = { name: string; input?: string; status?: string; error?: string }
export type CaseResult = { id: string; run: number; prompt: string; expect: string; pass: boolean; changed: Profile; tools: ToolCall[]; exitCode: number | null; timedOut: boolean; ms: number; input: number; output: number; calls: number; answer: string; note?: string }

/** The tool calls, token totals and last answer of a `run --format json` stream. */
export function readStream(text: string) {
  const tools = new Map<string, ToolCall>()
  let input = 0, output = 0, calls = 0, answer = ""
  for (const line of text.split("\n")) {
    let event: Record<string, unknown>
    try { event = JSON.parse(line) } catch { continue }
    if (event.type === "usage.recorded") { calls++; input += Number(event.input ?? 0) + Number(event.cacheRead ?? 0) + Number(event.cacheWrite ?? 0); output += Number(event.output ?? 0) }
    if (event.type === "item.started" && event.kind === "tool_call") tools.set(String(event.itemId), { name: String((event.meta as Record<string, unknown> | undefined)?.tool ?? (event.meta as Record<string, unknown> | undefined)?.name ?? "?") })
    if (event.type === "item.completed" && tools.has(String(event.itemId))) {
      const call = tools.get(String(event.itemId))!
      call.status = String(event.status)
      if (typeof event.toolInput === "string") call.input = event.toolInput.slice(0, 600)
      if (event.status !== "ok" && typeof event.text === "string") call.error = event.text.slice(0, 400)
    }
    if (event.type === "item.completed" && typeof event.text === "string" && !tools.has(String(event.itemId))) answer = event.text.slice(0, 600)
  }
  return { tools: [...tools.values()], input, output, calls, answer }
}

/** The keys whose value differs from the default: what the turn changed in a fresh profile. */
export function changedKeys(profile: Profile): Profile {
  return Object.fromEntries(Object.entries(profile).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(TUI_DEFAULTS[key])))
}

async function runCase(test: EvalCase, run: number, options: Flags): Promise<CaseResult> {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "mce-")))
  const dataDir = path.join(root, "d")
  const home = path.join(root, "h")
  const project = path.join(root, "p")
  for (const dir of [dataDir, home, project]) mkdirSync(dir, { recursive: true, mode: 0o700 })
  writeFileSync(path.join(project, "README.md"), "# notes\n\nA small notes project.\n")
  linkLogin(home)
  const env = caseEnv(root, home, dataDir)
  const logs = path.join(options.out, `${test.id}.${run}`)
  mkdirSync(logs, { recursive: true })
  let daemon: ChildProcess | undefined
  const started = Date.now()
  try {
    const log = openSync(path.join(logs, "daemon.log"), "w")
    daemon = spawn(process.execPath, [DAEMON, "--dir", dataDir, "--cwd", project, "--engine", "native", "--local-transport", "unix", "--local-only"], { cwd: project, env, detached: true, stdio: ["ignore", log, log] })
    closeSync(log)
    daemon.on("error", () => {})
    const socket = path.join(dataDir, "mendd.sock")
    for (let waited = 0; !(await listening(socket)); waited += 100) {
      if (waited > 30_000 || daemon.exitCode !== null) throw new Error("[EVAL]: the daemon did not listen; see daemon.log")
      await Bun.sleep(100)
    }
    const client = createClient({ socketPath: socket, name: "eval-customize", timeoutMs: 20_000 })
    await client.connect()
    const reply = await client.send({ type: "settings.set", patch: { tier: options.tier } })
    client.close()
    if (!reply.ok) throw new Error(`[EVAL]: settings.set refused: ${JSON.stringify(reply.error)}`)
    const child = Bun.spawn([process.execPath, CLI, "run", test.prompt, "--format", "json", "--approve", "--cwd", project, "--model", options.model, "--dir", dataDir], { cwd: project, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" })
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM") }, options.timeoutMs)
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    const exitCode = await child.exited
    clearTimeout(timer)
    writeFileSync(path.join(logs, "events.jsonl"), stdout)
    writeFileSync(path.join(logs, "stderr.log"), stderr)
    const file = path.join(dataDir, "tui", "profile.json")
    const saved: Profile = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {}
    const profile = { ...TUI_DEFAULTS, ...saved }
    const stream = readStream(stdout)
    return { id: test.id, run, prompt: test.prompt, expect: test.expect, pass: test.check(profile), changed: changedKeys(profile), ...stream, exitCode, timedOut, ms: Date.now() - started }
  } catch (error) {
    return { id: test.id, run, prompt: test.prompt, expect: test.expect, pass: false, changed: {}, tools: [], exitCode: null, timedOut: false, ms: Date.now() - started, input: 0, output: 0, calls: 0, answer: "", note: String(error) }
  } finally {
    await stop(daemon)
    if (!options.keep) rmSync(root, { recursive: true, force: true })
  }
}

async function main() {
  const options = flags(process.argv.slice(2))
  const pool = options.set === "heldout" ? HELDOUT : options.set === "all" ? [...CASES, ...HELDOUT] : CASES
  const chosen = options.cases.length ? pool.filter((test) => options.cases.includes(test.id)) : pool
  if (!chosen.length) throw new Error(`[EVAL]: no case matches ${options.cases.join(",")}; cases: ${pool.map((test) => test.id).join(", ")}`)
  mkdirSync(options.out, { recursive: true })
  const jobs = Array.from({ length: options.runs }, (_, run) => chosen.map((test) => ({ test, run }))).flat()
  const results: CaseResult[] = []
  let next = 0
  const worker = async () => {
    while (next < jobs.length) {
      const job = jobs[next++]!
      const result = await runCase(job.test, job.run, options)
      results.push(result)
      const tools = result.tools.map((call) => `${call.name}${call.status && call.status !== "ok" ? `(${call.status})` : ""}`).join(" ")
      console.log(`${result.pass ? "PASS" : "FAIL"} ${result.id}#${result.run} ${Math.round(result.ms / 1000)}s calls=${result.calls} in=${result.input} out=${result.output} tools=[${tools}] changed=${JSON.stringify(result.changed)}${result.note ? ` note=${result.note}` : ""}`)
    }
  }
  await Promise.all(Array.from({ length: Math.min(options.parallel, jobs.length) }, worker))
  results.sort((a, b) => pool.findIndex((test) => test.id === a.id) - pool.findIndex((test) => test.id === b.id) || a.run - b.run)
  const passed = results.filter((result) => result.pass).length
  const summary = { model: options.model, tier: options.tier, set: options.set, at: new Date().toISOString(), passed, total: results.length, input: results.reduce((sum, r) => sum + r.input, 0), output: results.reduce((sum, r) => sum + r.output, 0), calls: results.reduce((sum, r) => sum + r.calls, 0), results }
  writeFileSync(path.join(options.out, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`)
  console.log(`\n${passed}/${results.length} passed · ${options.model} · tier ${options.tier} · ${summary.calls} model calls · ${summary.input} input / ${summary.output} output tokens`)
  for (const result of results.filter((r) => !r.pass)) console.log(`  FAIL ${result.id}#${result.run}: expected ${result.expect}; changed ${JSON.stringify(result.changed)}; answer: ${result.answer.replace(/\s+/g, " ").slice(0, 200)}`)
  console.log(`logs: ${options.out}`)
}

if (import.meta.main) await main()
