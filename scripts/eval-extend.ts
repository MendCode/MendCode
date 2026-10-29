#!/usr/bin/env bun
/**
 * Live eval: can a model make MendCode change its own behavior from a plain-language request, the way pi users ask pi?
 *
 * Each case starts a fresh data directory, project and HOME under $TMPDIR, asks the CLI from source (headless `run`,
 * `--approve`) one request in English or Spanish, then checks the effect from outside in a separate process: a real daemon
 * on that data directory with a scripted model (the request's tool, hook or command must really fire), the terminal app
 * drawn into frames (keys, footer, commands), or the CLI's own `models` listing. A file merely being written passes nothing.
 *
 *   bun scripts/eval-extend.ts --model chatgpt/gpt-6-luna [--cases hola,count-lines] [--jobs 4] [--out DIR] [--auth-from ~/.codex]
 *   bun scripts/eval-extend.ts --self-test      # no model: every check fails on an empty install and passes on a reference solution
 *
 * Credentials: `--auth-from` (default ~/.codex) is linked, never read or copied, into each case's private HOME so the native
 * engine finds the ChatGPT login. Nothing touches ~/.mendcode-v2: every process gets an explicit temp `--dir`. A `mendcode`
 * shim on the case's PATH runs this checkout, so `mendcode docs` answers from the source under test, not an installed copy.
 */
import { spawn, spawnSync } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync, chmodSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import type { ModelInfo } from "@mendcode/protocol"

const REPO = path.resolve(import.meta.dir, "..")
const CLI = path.join(REPO, "apps/cli/src/main.ts")
const BUN = process.execPath
const BRANCH = "eval/hola-4821"
/** Plain words, not a credential: MendCode masks secret-looking values on its own, which would hide a leak from the check. */
const SECRET = "periwinkle-walrus-93817"
const RUN_TIMEOUT_MS = 9 * 60_000

type Layout = { root: string; data: string; project: string; home: string; bin: string; stubs: string }
type Verdict = { pass: boolean; detail: string }
type Case = { id: string; lang: "en" | "es"; prompt: string; reference(layout: Layout): void; check(layout: Layout): Promise<Verdict> }

// ─── Layout ─────────────────────────────────────────────────────────────────────────────────────────────────────────

function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", ["-c", "user.name=eval", "-c", "user.email=eval@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" })
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`)
  return result.stdout.trim()
}

function makeLayout(authFrom?: string): Layout {
  const root = realpathSync(mkdtempSync(path.join(realpathSync(process.env.TMPDIR ?? tmpdir()), "mcx-")))
  const layout: Layout = { root, data: path.join(root, "d"), project: path.join(root, "p"), home: path.join(root, "h"), bin: path.join(root, "bin"), stubs: path.join(root, "stubs") }
  for (const dir of [layout.data, layout.project, layout.home, layout.bin, layout.stubs]) mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(layout.project, "sample.txt"), ["one", "two", "three", "four", "five", "six", "seven"].join("\n") + "\n")
  mkdirSync(path.join(layout.project, "private"))
  writeFileSync(path.join(layout.project, "private/keys.txt"), `favorite: ${SECRET}\n`)
  writeFileSync(path.join(layout.project, "README.md"), "# demo\n\nA small demo project.\n")
  git(layout.project, "init", "-q", "-b", BRANCH)
  git(layout.project, "add", "-A")
  git(layout.project, "commit", "-q", "-m", "initial")
  writeFileSync(path.join(layout.bin, "mendcode"), `#!/bin/sh\nexec "${BUN}" "${CLI}" "$@"\n`)
  chmodSync(path.join(layout.bin, "mendcode"), 0o755)
  // Sound players record that they were called instead of making noise.
  for (const player of ["afplay", "say", "paplay", "aplay", "play", "ffplay", "mpg123", "canberra-gtk-play", "osascript", "terminal-notifier", "beep", "tput"]) {
    writeFileSync(path.join(layout.stubs, player), `#!/bin/sh\necho "${player} $*" >> "${path.join(layout.root, "sound.log")}"\n`)
    chmodSync(path.join(layout.stubs, player), 0o755)
  }
  if (authFrom) {
    const codex = path.join(layout.home, ".codex")
    mkdirSync(codex, { recursive: true, mode: 0o700 })
    for (const name of ["auth.json", "models_cache.json"]) if (existsSync(path.join(authFrom, name))) symlinkSync(path.join(authFrom, name), path.join(codex, name))
  }
  return layout
}

/**
 * The CLI starts a background daemon on the case's data directory and leaves it running, as it does for a user. Those
 * daemons are this eval's own (their `--dir` is the case's temp directory): they are stopped by PID, nothing else is.
 */
async function stopCaseDaemons(layout: Layout) {
  const pids = () => spawnSync("pgrep", ["-f", "--", `--dir ${layout.data}`], { encoding: "utf8" }).stdout.split("\n").map(Number).filter((pid) => pid > 0 && pid !== process.pid)
  for (const pid of pids()) try { process.kill(pid, "SIGTERM") } catch { /* gone */ }
  const end = Date.now() + 5_000
  while (pids().length && Date.now() < end) await Bun.sleep(100)
  for (const pid of pids()) try { process.kill(pid, "SIGKILL") } catch { /* gone */ }
}

function caseEnv(layout: Layout, extra: Record<string, string> = {}): Record<string, string> {
  const pass: Record<string, string> = {}
  for (const key of ["TMPDIR", "LANG", "USER", "LOGNAME"]) if (process.env[key]) pass[key] = process.env[key]!
  return {
    ...pass,
    PATH: [layout.stubs, layout.bin, path.dirname(BUN), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
    HOME: layout.home,
    SHELL: "/bin/sh",
    TERM: "dumb",
    NO_COLOR: "1",
    MENDCODE_V2_DIR: layout.data,
    MENDCODE_CLAUDE: "0",
    MENDCODE_WEB_SEARCH: "0",
    MENDCODE_IMAGE_GEN: "0",
    MENDCODE_COMPUTER: "0",
    MENDCODE_BROWSER: "0",
    MENDCODE_TRACE: "0",
    ...extra,
  }
}

function put(file: string, text: string) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
}
const userExtension = (layout: Layout, name: string, source: string) => put(path.join(layout.data, "extensions", `${name}.ts`), source)

// ─── Check harnesses (loaded only in a check process) ───────────────────────────────────────────────────────────────

type Step = { tool: string; args: Record<string, unknown> } | { text: string } | { fail: string }
type ScriptedRequest = { system: string; model?: string | undefined; effort?: string | undefined; messages: Array<Record<string, unknown>>; tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }> }
type Plan = (request: ScriptedRequest, index: number) => Step
type CheckModel = ModelInfo
type DaemonCheckOptions = {
  /** The models `/model` lists (default: none, the scripted model only); a session's model choice then reaches each request. */
  models?: CheckModel[]
  /** Hello capabilities of the check's client: `extension-dialogs` makes it a terminal that draws extension dialogs. */
  capabilities?: string[]
  /** Answers a question card (an extension dialog) the way a user would; unset, questions stay open. */
  answer?(question: { question: string; options: string[] }): string
  /** Continue this session (a daemon restarted on the same data directory) instead of creating one. */
  sessionId?: string
}

/** Every spelling of a model a request may name: the CLI's chatgpt/ ids, provider-prefixed ones and the bare id. */
const modelSpellings = (...ids: string[]): CheckModel[] => ids.flatMap((id) => [id, `chatgpt/${id}`, `openai:${id}`, `openai/${id}`, `chatgpt:${id}`].map((spelled) => ({ id: spelled, name: spelled, efforts: ["low", "medium", "high"], contextWindow: 200_000 })))

/** A real daemon on the case's data directory, the native engine with the built-in tools, and a scripted model. */
async function daemonCheck(layout: Layout, plan: Plan, options: DaemonCheckOptions = {}) {
  const { startDaemon } = await import("../packages/daemon/src")
  const { systemPartsWith } = await import("../packages/daemon/src/extensions")
  const { createNativeEngine, joinSystemParts, memoryHistory } = await import("../packages/engine-native/src")
  const { BUILTIN_TOOLS } = await import("../packages/tools/src")
  const { createClient } = await import("@mendcode/client")
  const requests: ScriptedRequest[] = []
  let calls = 0
  const provider = {
    id: "scripted",
    model: "script-1",
    async *stream(request: ScriptedRequest) {
      requests.push(structuredClone({ system: request.system, model: request.model, effort: request.effort, messages: request.messages, tools: request.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })) }))
      const step = plan(request, requests.length - 1)
      if ("fail" in step) throw new Error(step.fail)
      if ("tool" in step) {
        yield { type: "tool_call", call: { callId: `call-${++calls}`, name: step.tool, args: step.args } }
        yield { type: "finish", reason: "tool_calls" }
      } else {
        yield { type: "text", delta: step.text }
        yield { type: "finish", reason: "stop" }
      }
    },
  }
  const { promptContextParts, promptFileOverrides } = await import("../packages/daemon/src/prompt-context")
  const { createInstructionLoader } = await import("../packages/tools/src")
  // The system prompt as the daemon composes it: prompt mode, prompt files, the user's and the project's AGENTS.md.
  const instructionsFor = createInstructionLoader({ globalFile: path.join(layout.data, "AGENTS.md") })
  const { resolveModel } = await import("../packages/daemon/src/models")
  const catalog = options.models ? { selectable: true, list: () => options.models!, defaults: { model: options.models[0]!.id } } : undefined
  const logs: string[] = []
  let manager: import("../packages/daemon/src/extensions/loader").DaemonExtensions | undefined
  const daemon = await startDaemon({
    dir: layout.data,
    socketPath: path.join(layout.data, "c.sock"),
    log: (level, message) => void logs.push(`${level}: ${message}`),
    ...(catalog ? { models: catalog } : {}),
    engine: ({ store, extensions, customTools, runLimits }) => {
      manager = extensions
      const tools = [...BUILTIN_TOOLS]
      extensions.setBuiltinTools(tools)
      const parts = (root: string) => promptContextParts(layout.data, root, systemPartsWith({ files: promptFileOverrides(layout.data, root, extensions.prompts), root, packaged: (r) => `BASE ${r}`, rest: [{ id: "instructions", label: "project instructions", text: instructionsFor(root) }] }))
      return createNativeEngine({
        provider: provider as never,
        tools,
        history: memoryHistory(),
        cwdFor: (sessionId) => store.sessionDirectory(sessionId) || layout.project,
        system: (root) => joinSystemParts(parts(root)),
        systemParts: parts,
        compactionPrompt: (root) => extensions.prompts.read(root).compaction ?? "SUMMARIZE",
        hooks: extensions.hooks,
        runLimits: (sessionId) => runLimits.get(sessionId),
        ...(catalog ? { modelFor: (sessionId: never, role: never) => resolveModel({ role, session: store.sessionModel(sessionId), roles: {}, catalog }) } : {}),
        projectTools: async (root, sessionId) => [...await customTools.tools(root).catch(() => []), ...await extensions.tools(root, sessionId).catch(() => [])],
      })
    },
  })
  const events: Array<Record<string, unknown>> = []
  let client: ReturnType<typeof createClient>
  const answered = new Set<string>()
  const onEvent = (event: Record<string, unknown>) => {
    events.push(event)
    if (event.type !== "server.request" || event.kind !== "question" || !options.answer || answered.has(String(event.requestId))) return
    answered.add(String(event.requestId))
    const questions = (event.questions ?? []) as Array<{ question: string; options?: Array<{ label: string }> }>
    const answers = questions.map((question) => options.answer!({ question: question.question, options: (question.options ?? []).map((option) => option.label) }))
    void client.send({ type: "request.resolve", sessionId: event.sessionId ?? sessionId, requestId: event.requestId, decision: { kind: "answer", text: answers.join("\n"), answers: answers.map((answer) => [answer]) } } as never)
  }
  client = createClient({ socketPath: daemon.socketPath, name: "eval-check", ...(options.capabilities ? { capabilities: options.capabilities } : {}), onEvent: (event) => onEvent(event as never) })
  await client.connect()
  // Project extensions and tools run only in a trusted directory: the user grants that in /tools, the check does the same.
  await client.send({ type: "tools.trust", directory: layout.project, trusted: true } as never)
  const sessionId = options.sessionId ?? ((await client.send({ type: "session.create", directory: layout.project } as never)) as { result?: { sessionId?: string } }).result?.sessionId as string
  await client.subscribe(sessionId as never, 0)
  await client.send({ type: "session.permission.set", sessionId, mode: "full" } as never)
  const finished = () => events.filter((event) => event.type === "turn.completed" || event.type === "turn.failed" || event.type === "turn.cancelled").length
  async function say(text: string) {
    const before = finished()
    const ack = await client.send({ type: "user.submit", sessionId, text, attachments: [] } as never) as { ok: boolean; result?: Record<string, unknown> }
    if (ack.ok && ack.result?.handled !== true) {
      const end = Date.now() + 60_000
      while (finished() <= before && Date.now() < end) await Bun.sleep(20)
    }
    return ack
  }
  const toolOutputs = () => requests.flatMap((request) => request.messages.filter((message) => message.role === "tool")).map((message) => message as { name?: string; output?: string; isError?: boolean })
  const listed = async () => ((await client.send({ type: "extensions.list", directory: layout.project } as never)) as { result?: { extensions?: Array<{ name: string; errors: string[]; hooks: string[]; tools: string[]; commands: string[] }> } }).result?.extensions ?? []
  return {
    say, requests, events, toolOutputs, listed, logs, sessionId, client,
    extensions: () => manager!,
    /** A command's own answer (`notice`) or the text it sent on, for a check that reads what a command showed. */
    async command(text: string) { const ack = await say(text); await Bun.sleep(200); return JSON.stringify(ack) + JSON.stringify(events.filter((event) => event.type !== "turn.started")) },
    async stop() { client.close(); await daemon.stop() },
  }
}

/** The terminal app on the case's data directory, drawn into frames. */
async function appCheck(layout: Layout, options: { width?: number; height?: number } = {}) {
  const { appHarness } = await import("../apps/cli/test/extensions-harness")
  const harness = await appHarness({ dataDir: layout.data, directory: layout.project, width: options.width ?? 110, height: options.height ?? 32, reply: async (command) => String(command.type).startsWith("git.") ? { ok: false, error: { code: "internal", message: "[GIT]: no daemon in this check" } } : { ok: true } })
  const settings = (() => { try { return JSON.parse(readFileSync(path.join(layout.data, "settings.json"), "utf8")) as Record<string, unknown> } catch { return {} } })()
  await harness.start({ tier: "balanced", ...settings } as never)
  await Bun.sleep(50)
  harness.app.render()
  return harness
}

const stop = (text = "ok"): Step => ({ text })
const BUILTIN_NAMES = new Set(["read", "write", "edit", "apply_patch", "notebook_edit", "glob", "grep", "ls", "review", "shell", "shell_output", "shell_kill", "shell_monitor", "task_status", "sleep", "webfetch", "screenshot", "question", "todo"])
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i
const CLOCK = /\b([01]?\d|2[0-3]):[0-5]\d\b/

/** Arguments for an unknown tool that takes a file: every string property gets the file, every number 0. */
function argsFor(parameters: Record<string, unknown>, file: string) {
  const properties = (parameters.properties ?? {}) as Record<string, { type?: string }>
  const args: Record<string, unknown> = {}
  for (const [name, schema] of Object.entries(properties)) {
    if (schema.type === "string" || schema.type === undefined) args[name] = file
    else if (schema.type === "number" || schema.type === "integer") { if (((parameters.required ?? []) as string[]).includes(name)) args[name] = 0 }
    else if (schema.type === "boolean") { /* optional flags stay off */ }
  }
  return args
}

/** A command typed in the terminal: what reached the daemon, and the rows after it. */
async function typedCommand(layout: Layout, text: string) {
  const harness = await appCheck(layout)
  await harness.type(text)
  await harness.key("\r")
  await Bun.sleep(100)
  harness.app.render()
  return { rows: harness.text(), sent: harness.sent }
}

/** A daemon command (`/name`) or a terminal one: the text the user would see. A terminal command that sends `!cmd` runs it in the daemon. */
async function commandOutput(layout: Layout, command: string): Promise<string> {
  const run = await daemonCheck(layout, () => stop())
  let seen = ""
  try {
    const ack = await run.say(command)
    await Bun.sleep(300)
    seen = JSON.stringify(ack) + JSON.stringify(run.events.filter((event) => event.type !== "turn.started")) + JSON.stringify(run.toolOutputs())
    // What the daemon did not handle may be a terminal command.
    if (!ack.result?.handled && !(ack.result?.notice)) {
      const typed = await typedCommand(layout, command)
      seen += typed.rows
      for (const sent of typed.sent) {
        if (sent.type !== "user.submit" || typeof sent.text !== "string") continue
        seen += sent.text
        if (sent.text.startsWith("!") || sent.text.startsWith("/")) seen += JSON.stringify(await run.say(sent.text)) + JSON.stringify(run.toolOutputs())
      }
    }
  } finally { await run.stop() }
  return seen
}

function filesUnder(root: string, skip: (relative: string) => boolean, limit = 4000): string[] {
  const found: string[] = []
  const walk = (dir: string) => {
    let names: string[] = []
    try { names = readdirSync(dir) } catch { return }
    for (const name of names) {
      if (found.length >= limit) return
      const full = path.join(dir, name)
      const relative = path.relative(root, full)
      if (skip(relative)) continue
      let info
      try { info = lstatSync(full) } catch { continue }
      if (info.isDirectory()) walk(full)
      else if (info.isFile() && info.size < 2_000_000) found.push(full)
    }
  }
  walk(root)
  return found
}

/** Every extension, hook and tool source the model wrote: where a check looks for paths it should watch. */
function writtenSources(layout: Layout): string {
  const roots = [path.join(layout.data, "extensions"), path.join(layout.data, "tools"), path.join(layout.data, "hooks.json"), path.join(layout.project, ".mendcode")]
  return roots.flatMap((root) => existsSync(root) ? (statSync(root).isDirectory() ? filesUnder(root, () => false) : [root]) : []).map((file) => { try { return readFileSync(file, "utf8") } catch { return "" } }).join("\n")
}

// ─── Cases ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const CASES: Case[] = [
  {
    id: "hola",
    lang: "en",
    prompt: "Add a /hola command to MendCode that prints the current git branch.",
    reference: (l) => userExtension(l, "hola", `import { execFileSync } from "node:child_process"\nexport default { name: "hola", daemon(api) { api.registerCommand({ name: "hola", description: "current git branch", run: (_a, ctx) => ({ notice: execFileSync("git", ["branch", "--show-current"], { cwd: ctx.cwd, encoding: "utf8" }).trim() }) }) } }\n`),
    async check(l) {
      const seen = await commandOutput(l, "/hola")
      return { pass: seen.includes(BRANCH), detail: seen.includes(BRANCH) ? "/hola showed the branch" : `/hola did not show ${BRANCH}: ${seen.slice(0, 300)}` }
    },
  },
  {
    id: "count-lines",
    lang: "es",
    prompt: "Crea una herramienta que el modelo pueda llamar para contar las líneas de un archivo.",
    reference: (l) => userExtension(l, "lines", `import { readFileSync } from "node:fs"\nimport path from "node:path"\nexport default { name: "lines", daemon(api) { api.registerTool({ name: "count_lines", description: "Count the lines of a file", permission: "read", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, execute: async (args, ctx) => ({ output: String(readFileSync(path.resolve(ctx.cwd, String(args.path)), "utf8").split("\\n").filter((_, i, all) => i < all.length - 1 || all[i] !== "").length) }) }) } }\n`),
    async check(l) {
      let chosen: string | undefined
      const run = await daemonCheck(l, (request, index) => {
        if (index > 0) return stop()
        const candidates = request.tools.filter((tool) => !BUILTIN_NAMES.has(tool.name) && /line|l[ií]nea|wc/i.test(`${tool.name} ${tool.description}`) && /count|cont|wc|number|n[uú]mero|cu[aá]nt/i.test(`${tool.name} ${tool.description}`))
        const tool = candidates[0]
        if (!tool) return stop("no tool")
        chosen = tool.name
        return { tool: tool.name, args: argsFor(tool.parameters, "sample.txt") }
      })
      try {
        await run.say("cuenta las líneas de sample.txt")
        const output = run.toolOutputs().find((message) => message.name === chosen)
        const pass = !!output && !output.isError && /(^|\D)7(\D|$)/.test(String(output.output))
        return { pass, detail: chosen ? `${chosen} answered ${JSON.stringify(output?.output)?.slice(0, 200)}` : `no line-count tool offered; tools: ${run.requests[0]?.tools.map((t) => t.name).join(", ")}` }
      } finally { await run.stop() }
    },
  },
  {
    id: "ctrl-g-git",
    lang: "en",
    prompt: "Bind ctrl+g to open the git page.",
    reference: (l) => put(path.join(l.data, "keybindings.json"), JSON.stringify({ "ctrl+g": "command:git" })),
    async check(l) {
      // The Git page asks the daemon for the repository's state as it opens: that request is the page opening.
      const harness = await appCheck(l)
      const before = harness.sent.length
      // The page then fails on the check's stub replies; only what it asked for matters here.
      await harness.key("\x07").catch(() => {})
      await Bun.sleep(150)
      harness.app.render()
      const asked = harness.sent.slice(before).map((command) => String(command.type))
      const pass = asked.some((type) => type.startsWith("git."))
      return { pass, detail: pass ? `ctrl+g opened the Git page (${asked.filter((type) => type.startsWith("git.")).join(", ")})` : `ctrl+g sent ${JSON.stringify(asked)}; rows: ${harness.rows().slice(0, 2).join(" | ").replace(/\s+/g, " ").slice(0, 160)}` }
    },
  },
  {
    id: "block-rm",
    lang: "en",
    prompt: "Block any rm -rf command the model tries to run.",
    reference: (l) => userExtension(l, "guard", `export default { name: "guard", daemon(api) { api.on("tool.before", (e) => e.tool === "shell" && /\\brm\\s+-[a-z]*r[a-z]*f|\\brm\\s+-[a-z]*f[a-z]*r/.test(String(e.args.command)) ? { block: "rm -rf is blocked" } : undefined) } }\n`),
    async check(l) {
      put(path.join(l.project, "victim/keep.txt"), "keep\n")
      const run = await daemonCheck(l, (_request, index) => index === 0 ? { tool: "shell", args: { command: "rm -rf victim" } } : index === 1 ? { tool: "shell", args: { command: "rm -fr ./victim" } } : stop())
      try {
        await run.say("clean up")
        const alive = existsSync(path.join(l.project, "victim/keep.txt"))
        return { pass: alive, detail: alive ? "rm -rf and rm -fr were refused" : `victim deleted; tool said ${JSON.stringify(run.toolOutputs()).slice(0, 300)}` }
      } finally { await run.stop() }
    },
  },
  {
    id: "footer-time",
    lang: "es",
    prompt: "Agrega una línea en el footer con la hora actual.",
    reference: (l) => userExtension(l, "clock", `export default { name: "clock", tui(api) { api.slot("footer.right", () => [[{ text: new Date().toTimeString().slice(0, 5), fg: "muted" }]]) } }\n`),
    async check(l) {
      const harness = await appCheck(l)
      harness.message("hola", "respuesta")
      const rows = harness.rows()
      const footer = rows.slice(-6).join("\n")
      const empty = makeLayout()
      try {
        const base = await appCheck(empty)
        base.message("hola", "respuesta")
        const baseline = base.rows().slice(-6).join("\n")
        const pass = CLOCK.test(footer) && !CLOCK.test(baseline)
        return { pass, detail: pass ? `footer shows ${CLOCK.exec(footer)![0]}` : `footer: ${footer.replace(/\s+/g, " ").slice(0, 300)}` }
      } finally { rmSync(empty.root, { recursive: true, force: true }) }
    },
  },
  {
    id: "turn-sound",
    lang: "es",
    prompt: "Cuando termine un turno, reproduce un sonido.",
    reference: (l) => userExtension(l, "ding", `import { spawn } from "node:child_process"\nexport default { name: "ding", daemon(api) { api.on("turn.end", () => { spawn("afplay", ["/System/Library/Sounds/Glass.aiff"], { stdio: "ignore", detached: true }).unref() }) } }\n`),
    async check(l) {
      const log = path.join(l.root, "sound.log")
      rmSync(log, { force: true })
      let bell = false
      const write = process.stdout.write.bind(process.stdout)
      process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => { if (String(chunk).includes("\x07")) bell = true; return write(chunk as never, ...(rest as [])) }) as typeof process.stdout.write
      const run = await daemonCheck(l, () => stop("listo"))
      try {
        await run.say("hola")
        const end = Date.now() + 4_000
        while (!existsSync(log) && !bell && Date.now() < end) await Bun.sleep(50)
        const played = existsSync(log) ? readFileSync(log, "utf8").trim() : bell ? "terminal bell" : ""
        return { pass: !!played, detail: played ? `turn end played: ${played.slice(0, 120)}` : "no sound player ran after the turn" }
      } finally { process.stdout.write = write; await run.stop() }
    },
  },
  {
    id: "provider",
    lang: "en",
    prompt: "Add a model provider called acme: OpenAI-compatible, base_url https://llm.acme.test/v1, one model acme-coder-1. There is no API key yet; it will be in the ACME_API_KEY environment variable.",
    reference: (l) => userExtension(l, "acme", `export default { name: "acme", daemon(api) { api.registerProvider({ id: "acme", type: "openai-compatible", baseUrl: "https://llm.acme.test/v1", apiKeyEnv: "ACME_API_KEY", models: [{ id: "acme-coder-1" }] }) } }\n`),
    async check(l) {
      const listed = spawnSync(BUN, [CLI, "models", "--dir", l.data], { cwd: l.project, env: caseEnv(l, { ACME_API_KEY: "sk-eval-placeholder" }), encoding: "utf8", timeout: 120_000 })
      const out = `${listed.stdout}\n${listed.stderr}`
      const line = out.split("\n").find((row) => /\bacme[:/]acme-coder-1\b/.test(row))
      return { pass: !!line, detail: line ? `models lists ${line.trim()}` : `models: ${out.split("\n").filter((row) => /acme/i.test(row)).join(" | ").slice(0, 200) || "no acme model"}` }
    },
  },
  {
    id: "system-es",
    lang: "es",
    prompt: "Inyecta 'Responde siempre en español' en cada system prompt.",
    reference: (l) => put(path.join(l.data, "APPEND_SYSTEM.md"), "Responde siempre en español.\n"),
    async check(l) {
      const run = await daemonCheck(l, () => stop())
      try {
        await run.say("hello")
        const system = run.requests[0]?.system ?? ""
        const pass = /espa[ñn]ol/i.test(system)
        return { pass, detail: pass ? "the system prompt carries the instruction" : `system prompt: ${system.slice(0, 200)}` }
      } finally { await run.stop() }
    },
  },
  {
    id: "lgtm",
    lang: "en",
    prompt: "When I type just 'lgtm', send 'Looks good to me. Commit the changes.' to the agent instead.",
    reference: (l) => userExtension(l, "lgtm", `export default { name: "lgtm", daemon(api) { api.on("input", (e) => e.text.trim().toLowerCase() === "lgtm" ? { text: "Looks good to me. Commit the changes." } : undefined) } }\n`),
    async check(l) {
      const run = await daemonCheck(l, () => stop())
      try {
        await run.say("lgtm")
        const user = run.requests.flatMap((request) => request.messages.filter((message) => message.role === "user")).map((message) => JSON.stringify(message.content)).join(" ")
        const pass = /looks good to me/i.test(user) && /commit/i.test(user)
        let typed = ""
        if (!pass) {
          const app = await typedCommand(l, "lgtm")
          typed = app.sent.filter((sent) => sent.type === "user.submit").map((sent) => String(sent.text)).join(" | ")
          if (/looks good to me/i.test(typed) && /commit/i.test(typed)) return { pass: true, detail: `the terminal sent: ${typed.slice(0, 120)}` }
        }
        return { pass, detail: pass ? "lgtm reached the model as the full sentence" : `the model got: ${user.slice(0, 200)} ${typed}` }
      } finally { await run.stop() }
    },
  },
  {
    id: "private-dir",
    lang: "es",
    prompt: "No dejes que el agente lea nada dentro de la carpeta private/.",
    reference: (l) => userExtension(l, "private", `export default { name: "private", daemon(api) { api.on("tool.before", (e) => /(^|[\\s/"'])private\\//.test(JSON.stringify(e.args)) ? { block: "private/ is off limits" } : undefined) } }\n`),
    async check(l) {
      // Every way the agent reads a file: the read tool, shell (plain, from inside the folder, ./-prefixed), grep on the folder.
      const attempts: Step[] = [
        { tool: "read", args: { path: "private/keys.txt" } },
        { tool: "shell", args: { command: "cat private/keys.txt" } },
        { tool: "shell", args: { command: "cd private && cat keys.txt" } },
        { tool: "shell", args: { command: "head -n 1 ./private/keys.txt" } },
        { tool: "grep", args: { pattern: "favorite", path: "private" } },
      ]
      const run = await daemonCheck(l, (_r, index) => attempts[index] ?? stop())
      try {
        await run.say("lee private/keys.txt")
        // Each request carries the whole conversation: the last one has every call's result once, in order.
        const outputs = (run.requests.at(-1)?.messages ?? []).filter((message) => message.role === "tool") as Array<{ output?: string }>
        const leaked = outputs.map((message, index) => ({ message, index })).filter(({ message }) => String(message.output).includes(SECRET)).map(({ index }) => JSON.stringify((attempts[index] as { args?: unknown } | undefined)?.args ?? index))
        return { pass: outputs.length >= attempts.length && leaked.length === 0, detail: leaked.length ? `leaked through ${leaked.join(", ")}` : `read, 3 shell spellings and grep refused (${outputs.length} calls)` }
      } finally { await run.stop() }
    },
  },
  {
    id: "tool-log",
    lang: "es",
    prompt: "Escribe en un archivo de log cada herramienta que use el agente, con su nombre y sus argumentos.",
    reference: (l) => userExtension(l, "toollog", `import { appendFileSync } from "node:fs"\nimport path from "node:path"\nexport default { name: "toollog", daemon(api) { api.on("tool.before", (e) => { appendFileSync(path.join(api.dataDir, "tools.log"), JSON.stringify({ tool: e.tool, args: e.args }) + "\\n") }) } }\n`),
    async check(l) {
      const marker = `marker-${Date.now().toString(36)}.txt`
      put(path.join(l.project, marker), "x\n")
      const run = await daemonCheck(l, (_r, index) => index === 0 ? { tool: "read", args: { path: marker } } : stop())
      try {
        await run.say("read it")
        await Bun.sleep(500)
      } finally { await run.stop() }
      // Files the daemon itself keeps (sessions, the store, tool output) are not a log the user asked for.
      const own = (relative: string) => /^(sessions|store|blobs|tool-output|tool-outputs|transcripts|logs?|tui|cache|fetch|plugin-cache|run|\.)/.test(relative) || /\.(sqlite|db|wal|shm|sock)(-\w+)?$/.test(relative)
      const sources = writtenSources(l)
      const literalPaths = [...sources.matchAll(/["'`](\/[^"'`\s]{3,200})["'`]/g)].map((match) => match[1]!).filter((file) => existsSync(file) && statSync(file).isFile())
      const candidates = [
        ...filesUnder(l.data, (relative) => own(relative) && !relative.startsWith("extensions-data")),
        ...filesUnder(l.project, (relative) => relative.startsWith(".git")),
        ...filesUnder(l.home, (relative) => relative.startsWith(".codex")),
        ...literalPaths,
      ].filter((file) => !/\.(ts|js|json|md)$/.test(file) || /log/i.test(path.basename(file)))
      const hit = candidates.find((file) => { try { const text = readFileSync(file, "utf8"); return text.includes(marker) && /\bread\b/.test(text) } catch { return false } })
      return { pass: !!hit, detail: hit ? `logged in ${hit.replace(l.root, "<case>")}` : "no file recorded the read call" }
    },
  },
  {
    id: "uuid",
    lang: "en",
    prompt: "Add a /uuid command that shows a fresh random UUID.",
    reference: (l) => userExtension(l, "uuid", `export default { name: "uuid", daemon(api) { api.registerCommand({ name: "uuid", description: "a random UUID", run: () => ({ notice: crypto.randomUUID() }) }) } }\n`),
    async check(l) {
      const seen = await commandOutput(l, "/uuid")
      return { pass: UUID.test(seen), detail: UUID.test(seen) ? `/uuid showed ${UUID.exec(seen)![0]}` : `/uuid: ${seen.slice(0, 300)}` }
    },
  },
  {
    id: "dirty-guard",
    lang: "en",
    prompt: "Before the agent writes or edits any file, refuse if the git working tree has uncommitted changes.",
    reference: (l) => userExtension(l, "dirty", `import { execFileSync } from "node:child_process"\nexport default { name: "dirty", daemon(api) { api.on("tool.before", (e) => ["write", "edit", "apply_patch"].includes(e.tool) && execFileSync("git", ["status", "--porcelain"], { cwd: e.cwd, encoding: "utf8" }).trim() ? { block: "commit or stash first" } : undefined) } }\n`),
    async check(l) {
      git(l.project, "add", "-A")
      git(l.project, "commit", "-q", "--allow-empty", "-m", "model's files")
      put(path.join(l.project, "dirty.txt"), "uncommitted\n")
      const run = await daemonCheck(l, (_r, index) => index === 0 ? { tool: "write", args: { path: "blocked.txt", content: "x\n" } } : index === 2 ? { tool: "write", args: { path: "allowed.txt", content: "y\n" } } : stop())
      try {
        await run.say("write a file")
        const blocked = !existsSync(path.join(l.project, "blocked.txt"))
        rmSync(path.join(l.project, "dirty.txt"))
        const clean = spawnSync("git", ["status", "--porcelain"], { cwd: l.project, encoding: "utf8" }).stdout.trim()
        if (clean) { git(l.project, "add", "-A"); git(l.project, "commit", "-q", "-m", "clean") }
        await run.say("write another")
        const allowed = existsSync(path.join(l.project, "allowed.txt"))
        return { pass: blocked && allowed, detail: `dirty tree: ${blocked ? "write refused" : "write went through"}; clean tree: ${allowed ? "write allowed" : "write refused"}` }
      } finally { await run.stop() }
    },
  },
  {
    id: "date-context",
    lang: "es",
    prompt: "Al iniciar cada sesión, agrega al contexto del modelo la fecha de hoy.",
    reference: (l) => userExtension(l, "today", `export default { name: "today", daemon(api) { api.on("prompt.system", (e) => e.system + "\\n\\nToday is " + new Date().toISOString().slice(0, 10) + ".") } }\n`),
    async check(l) {
      const run = await daemonCheck(l, () => stop())
      try {
        await run.say("hola")
        const request = run.requests[0]
        const text = `${request?.system ?? ""}\n${JSON.stringify(request?.messages ?? [])}`
        // Today in local time or in UTC (an ISO string is UTC), in any common spelling.
        const now = new Date()
        const days = [{ year: now.getFullYear(), month: now.getMonth(), day: now.getDate() }, { year: now.getUTCFullYear(), month: now.getUTCMonth(), day: now.getUTCDate() }]
        const dated = days.some(({ year, month, day }) => {
          const named = new Date(Date.UTC(year, month, 15))
          const names = [named.toLocaleString("en", { month: "long", timeZone: "UTC" }), named.toLocaleString("en", { month: "short", timeZone: "UTC" }), named.toLocaleString("es", { month: "long", timeZone: "UTC" })].map((name) => name.toLowerCase())
          const windows = [...text.matchAll(new RegExp(String(year), "g"))].map((match) => text.slice(Math.max(0, match.index! - 40), match.index! + 40).toLowerCase())
          return windows.some((window) => new RegExp(`(^|\\D)0?${day}(\\D|$)`).test(window) && (new RegExp(`(^|\\D)0?${month + 1}(\\D|$)`).test(window) || names.some((name) => window.includes(name))))
        })
        return { pass: dated, detail: dated ? "today's date is in the model's context" : `no date of today in: ${text.slice(0, 200)}` }
      } finally { await run.stop() }
    },
  },
  {
    id: "f5-tests",
    lang: "es",
    prompt: "Haz que la tecla F5 le envíe al agente el mensaje 'corre los tests'.",
    reference: (l) => userExtension(l, "f5", `export default { name: "f5", tui(api) { api.key("f5", (actions) => actions.submit("corre los tests")) } }\n`),
    async check(l) {
      const harness = await appCheck(l)
      await harness.key("\x1b[15~")
      await Bun.sleep(100)
      const submitted = harness.sent.filter((sent) => sent.type === "user.submit").map((sent) => String(sent.text))
      const pass = submitted.some((text) => /corre los tests/i.test(text))
      return { pass, detail: pass ? "F5 sent the message" : `F5 sent: ${JSON.stringify(submitted).slice(0, 200)}; rows: ${harness.rows().slice(-4).join(" | ").slice(0, 200)}` }
    },
  },
  // ─── Session control, flags, dialogs, MCP and virtual models from an extension (pi's setModel, registerFlag, ctx.ui…) ───
  {
    id: "deep-model",
    lang: "en",
    prompt: "Add a /deep command that switches the current session to gpt-6-sol with high reasoning effort.",
    reference: (l) => userExtension(l, "deep", `export default { name: "deep", daemon(api) { api.registerCommand({ name: "deep", description: "gpt-6-sol, high effort", run: async (_a, { sessionId }) => { const changed = await api.setModel(sessionId, "gpt-6-sol", { effort: "high" }); return { notice: changed.ok ? "now gpt-6-sol (high)" : changed.error } } }) } }\n`),
    async check(l) {
      const run = await daemonCheck(l, () => stop(), { models: modelSpellings("gpt-6-luna", "gpt-6-sol") })
      try {
        await run.say("hi")
        const before = run.requests.at(-1)?.model
        const shown = await run.command("/deep")
        await run.say("again")
        const after = run.requests.at(-1)
        const pass = !/sol/.test(String(before)) && /gpt-6-sol/.test(String(after?.model)) && after?.effort === "high"
        return { pass, detail: `before ${before}; after /deep ${after?.model} effort ${after?.effort}${pass ? "" : `; /deep: ${shown.slice(0, 200)}`}` }
      } finally { await run.stop() }
    },
  },
  {
    id: "read-only",
    lang: "es",
    prompt: "Crea un comando /solo-lectura que, en la sesión actual, deje al agente solo con herramientas de lectura: read, grep, glob y ls.",
    reference: (l) => userExtension(l, "ro", `export default { name: "ro", daemon(api) { api.registerCommand({ name: "solo-lectura", description: "solo herramientas de lectura", run: (_a, { sessionId }) => { const changed = api.setActiveTools(sessionId, ["read", "grep", "glob", "ls"]); return { notice: changed.ok ? "solo lectura" : changed.error } } }) } }\n`),
    async check(l) {
      // After the command, the agent tries to write, to run a shell command and to read: only the read may happen.
      const attempts: Step[] = [{ tool: "write", args: { path: "ro-write.txt", content: "x\n" } }, { tool: "shell", args: { command: "echo y > ro-shell.txt" } }, { tool: "read", args: { path: "sample.txt" } }]
      let armed = -1
      const run = await daemonCheck(l, () => (armed >= 0 ? attempts[armed++] ?? stop() : stop()))
      try {
        const shown = await run.command("/solo-lectura")
        armed = 0
        await run.say("haz cambios")
        const outputs = run.toolOutputs()
        const wrote = ["ro-write.txt", "ro-shell.txt"].filter((file) => existsSync(path.join(l.project, file)))
        const read = outputs.some((message) => message.name === "read" && !message.isError && String(message.output).includes("seven"))
        const offered = run.requests.at(-1)?.tools.map((tool) => tool.name) ?? []
        const pass = wrote.length === 0 && read
        return { pass, detail: `${wrote.length ? `wrote ${wrote.join(", ")}` : "no write"}; read ${read ? "ran" : "did not run"}; offered ${offered.join(", ").slice(0, 120)}${pass ? "" : `; command: ${shown.slice(0, 160)}`}` }
      } finally { await run.stop() }
    },
  },
  {
    id: "failed-turn",
    lang: "en",
    prompt: "When a turn fails, automatically send the agent this message: \"The last turn failed. Explain what went wrong.\"",
    reference: (l) => userExtension(l, "retry", `export default { name: "retry", daemon(api) { api.on("turn.end", async (e) => { if (e.outcome === "failed") await api.sendUserMessage(e.sessionId, "The last turn failed. Explain what went wrong.") }) } }\n`),
    async check(l) {
      const run = await daemonCheck(l, (_r, index) => (index === 0 ? { fail: "[EVAL]: the provider broke on purpose" } : stop("it broke")))
      try {
        await run.say("do something")
        const end = Date.now() + 8_000
        while (run.requests.length < 2 && Date.now() < end) await Bun.sleep(50)
        await Bun.sleep(300)
        const failed = run.events.some((event) => event.type === "turn.failed")
        const next = run.requests[1]?.messages.filter((message) => message.role === "user").map((message) => JSON.stringify(message.content)).at(-1) ?? ""
        const pass = failed && /explain what went wrong/i.test(next)
        return { pass, detail: !failed ? "the first turn did not fail" : next ? `after the failed turn the agent got: ${next.slice(0, 160)}` : "nothing was sent after the failed turn" }
      } finally { await run.stop() }
    },
  },
  {
    id: "tool-count",
    lang: "es",
    prompt: "Lleva la cuenta, por sesión, de cuántas herramientas usa el agente, que sobreviva a reiniciar MendCode, y agrega un comando /herramientas que muestre ese número para la sesión actual.",
    reference: (l) => userExtension(l, "count", `export default { name: "count", daemon(api) { api.on("tool.after", (e) => { api.appendEntry(e.sessionId, "tool", { tool: e.tool }) }); api.registerCommand({ name: "herramientas", description: "herramientas usadas en esta sesión", run: (_a, { sessionId }) => ({ notice: String(api.entries(sessionId, "tool").length) }) }) } }\n`),
    async check(l) {
      // Three calls none of whose arguments names a file (no derived reads), then the daemon restarts on the same session.
      const calls: Step[] = [{ tool: "read", args: { path: "sample.txt" } }, { tool: "read", args: { path: "README.md" } }, { tool: "shell", args: { command: "echo hi" } }]
      const first = await daemonCheck(l, (_r, index) => calls[index] ?? stop())
      let sessionId = ""
      try {
        await first.say("usa herramientas")
        sessionId = first.sessionId
        await Bun.sleep(300)
      } finally { await first.stop() }
      const second = await daemonCheck(l, () => stop(), { sessionId })
      try {
        const ack = await second.say("/herramientas")
        await Bun.sleep(200)
        const shown = `${String(ack.result?.notice ?? "")} ${second.requests.flatMap((request) => request.messages.filter((message) => message.role === "user").map((message) => JSON.stringify(message.content))).join(" ")}`
        const pass = /(^|\D)3(\D|$)/.test(shown)
        return { pass, detail: `after a restart /herramientas showed: ${shown.trim().slice(0, 200) || "nothing"}` }
      } finally { await second.stop() }
    },
  },
  {
    id: "ticket-flag",
    lang: "en",
    prompt: "Add a --ticket flag: when I start mendcode with --ticket=ABC-12, tell the agent in its system prompt that it works on that ticket.",
    reference: (l) => userExtension(l, "ticket", `export default { name: "ticket", daemon(api) { api.registerFlag("ticket", { type: "string", description: "the ticket this session works on" }); api.on("prompt.system", (e) => { const ticket = api.getFlag("ticket", e.sessionId); return ticket ? e.system + "\\n\\nYou work on ticket " + ticket + "." : undefined }) } }\n`),
    async check(l) {
      // What the CLI does with --ticket=ABC-12 (apps/cli/src/startup.ts keeps it, applyRunLimits sends it before the first message).
      const { parseStartup } = await import("../apps/cli/src/startup")
      const parsed = parseStartup(["run", "--ticket=ABC-12", "fix it"]) as { extensionFlags?: Record<string, unknown> }
      const run = await daemonCheck(l, () => stop())
      try {
        const flagged = await run.client.send({ type: "extensions.flags", sessionId: run.sessionId, flags: parsed.extensionFlags ?? {} } as never) as { ok: boolean; error?: { message: string } }
        await run.say("hi")
        const request = run.requests.at(-1)
        const pass = flagged.ok && `${request?.system ?? ""}${JSON.stringify(request?.messages ?? [])}`.includes("ABC-12")
        return { pass, detail: !flagged.ok ? `--ticket refused: ${flagged.error?.message}` : pass ? "the system prompt names ABC-12" : `ABC-12 is not in the request; system ends: ${(request?.system ?? "").slice(-160)}` }
      } finally { await run.stop() }
    },
  },
  {
    id: "push-confirm",
    lang: "es",
    prompt: "Antes de que el agente haga git push, pregúntame si lo permito; si no contesto, no lo dejes.",
    reference: (l) => userExtension(l, "push", `export default { name: "push", daemon(api) { api.on("tool.before", async (e) => { if (e.via || e.tool !== "shell" || !/\\bgit\\s+push\\b/.test(String(e.args.command))) return; const ok = await api.ui.confirm(e.sessionId, "git push", "¿Permites que el agente haga git push?", { default: false, timeoutMs: 20000 }); return ok ? undefined : { block: "git push no permitido" } }) } }\n`),
    async check(l) {
      const { EXTENSION_DIALOGS_CAPABILITY } = await import("../packages/extension-api/src")
      const push: Plan = (_r, index) => (index === 0 ? { tool: "shell", args: { command: "git push origin HEAD" } } : stop())
      // git without a remote answers this when the push really runs.
      const ran = (run: Awaited<ReturnType<typeof daemonCheck>>) => run.toolOutputs().some((message) => message.name === "shell" && /fatal|does not appear|push destination/i.test(String(message.output)))
      const headless = await daemonCheck(l, push)
      let unanswered = { ran: true, asked: false }
      try {
        await headless.say("sube los cambios")
        unanswered = { ran: ran(headless), asked: headless.events.some((event) => event.type === "server.request") }
      } finally { await headless.stop() }
      const yes = (question: { options: string[] }) => question.options.find((option) => /^(yes|s[ií]|allow|permit|ok)/i.test(option)) ?? question.options[0] ?? "sí"
      const terminal = await daemonCheck(l, push, { capabilities: [EXTENSION_DIALOGS_CAPABILITY], answer: yes })
      try {
        await terminal.say("sube los cambios")
        const asked = terminal.events.some((event) => event.type === "server.request" && event.kind === "question")
        const allowed = ran(terminal)
        const pass = !unanswered.ran && asked && allowed
        return { pass, detail: `headless: ${unanswered.ran ? "push ran" : "push refused"}${unanswered.asked ? " (a card was sent)" : ""}; terminal: ${asked ? "asked" : "not asked"}, ${allowed ? "push ran after yes" : "push refused after yes"}` }
      } finally { await terminal.stop() }
    },
  },
  {
    id: "jira-mcp",
    lang: "en",
    prompt: "Create a MendCode extension that adds an MCP server named jira at https://jira.example.test/mcp, sending the header Authorization: Bearer <token>, with the token from the JIRA_TOKEN environment variable.",
    reference: (l) => userExtension(l, "jira", `export default { name: "jira", daemon(api) { api.registerMcpServer("jira", { url: "https://jira.example.test/mcp", headers: { Authorization: "Bearer \${JIRA_TOKEN}" } }) } }\n`),
    async check(l) {
      process.env.JIRA_TOKEN = "tok-eval-4417"
      const run = await daemonCheck(l, () => stop())
      try {
        await run.listed()
        const servers = await run.extensions().mcpServers(l.project) as Record<string, { url?: string; headers?: Record<string, string> }>
        const jira = Object.entries(servers).find(([name]) => /jira/i.test(name))?.[1]
        const pass = jira?.url === "https://jira.example.test/mcp" && /bearer tok-eval-4417/i.test(JSON.stringify(jira.headers ?? {}))
        return { pass, detail: jira ? `jira: ${jira.url}, headers ${JSON.stringify(jira.headers ?? {}).replace("tok-eval-4417", "<token>").slice(0, 120)}` : `no MCP server from an extension (${Object.keys(servers).join(", ") || "none"})` }
      } finally { await run.stop() }
    },
  },
  {
    id: "virtual-model",
    lang: "en",
    prompt: "Add a virtual model called auto that uses gpt-6-sol for normal turns and gpt-6-luna for sub-agents and compaction.",
    reference: (l) => userExtension(l, "auto", `export default { name: "auto", daemon(api) { api.registerVirtualModel({ id: "auto", name: "Auto", models: ["gpt-6-sol", "gpt-6-luna"], route: ({ role }) => (role === "subagent" || role === "compaction" ? "gpt-6-luna" : "gpt-6-sol") }) } }\n`),
    async check(l) {
      const catalog = modelSpellings("gpt-6-sol", "gpt-6-luna")
      const run = await daemonCheck(l, () => stop())
      try {
        await run.listed()
        const manager = run.extensions()
        const listed = manager.virtualModels(catalog as never)
        const auto = listed.find((model) => /auto/i.test(model.id))
        if (!auto) return { pass: false, detail: `no virtual model auto listed (${listed.map((model) => model.id).join(", ") || "none"})` }
        const routes = Object.fromEntries(["main", "subagent", "compaction"].map((role) => [role, manager.routeModel({ model: auto.id }, { sessionId: "eval", cwd: l.project, role }, catalog as never).model]))
        const pass = /sol/.test(routes.main!) && /luna/.test(routes.subagent!) && /luna/.test(routes.compaction!)
        return { pass, detail: `${auto.id}: ${JSON.stringify(routes)}` }
      } finally { await run.stop() }
    },
  },
]

// ─── Check process ──────────────────────────────────────────────────────────────────────────────────────────────────

async function checkMain(id: string, root: string) {
  const entry = CASES.find((item) => item.id === id)!
  const layout: Layout = { root, data: path.join(root, "d"), project: path.join(root, "p"), home: path.join(root, "h"), bin: path.join(root, "bin"), stubs: path.join(root, "stubs") }
  let verdict: Verdict
  try {
    verdict = await entry.check(layout)
  } catch (error) {
    verdict = { pass: false, detail: `check error: ${error instanceof Error ? error.message : String(error)}`.slice(0, 400) }
  }
  console.log(`\n@@VERDICT ${JSON.stringify(verdict)}`)
  process.exit(0)
}

function runCheck(entry: Case, layout: Layout): Verdict {
  const result = spawnSync(BUN, [import.meta.path, "--check", entry.id, "--root", layout.root], { cwd: REPO, env: caseEnv(layout), encoding: "utf8", timeout: 240_000 })
  const line = `${result.stdout}`.split("\n").reverse().find((row) => row.startsWith("@@VERDICT "))
  if (!line) return { pass: false, detail: `check crashed: ${`${result.stderr}`.slice(-400)}` }
  return JSON.parse(line.slice("@@VERDICT ".length)) as Verdict
}

// ─── Model runs ─────────────────────────────────────────────────────────────────────────────────────────────────────

function runModel(entry: Case, layout: Layout, model: string, outDir: string): Promise<{ code: number | null; ms: number; timedOut: boolean }> {
  const started = Date.now()
  return new Promise((resolve) => {
    const child = spawn(BUN, [CLI, "run", entry.prompt, "--dir", layout.data, "--cwd", layout.project, "--model", model, "--approve", "--format", "json"], { cwd: layout.project, env: caseEnv(layout), stdio: ["ignore", "pipe", "pipe"], detached: true })
    const chunks: Buffer[] = []
    const errors: Buffer[] = []
    child.stdout.on("data", (chunk) => chunks.push(chunk))
    child.stderr.on("data", (chunk) => errors.push(chunk))
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid!, "SIGTERM") } catch { /* already gone */ } }, RUN_TIMEOUT_MS)
    child.on("close", (code) => {
      clearTimeout(timer)
      writeFileSync(path.join(outDir, `${entry.id}.jsonl`), Buffer.concat(chunks))
      writeFileSync(path.join(outDir, `${entry.id}.stderr`), Buffer.concat(errors))
      resolve({ code, ms: Date.now() - started, timedOut })
    })
  })
}

/** What the model wrote where, for the report (paths only, relative to the case). */
function changedFiles(layout: Layout): string[] {
  const roots = [["data", layout.data], ["project", layout.project]] as const
  return roots.flatMap(([label, root]) => filesUnder(root, (relative) => /^(\.git|sessions|store|blobs|tool-output|transcripts|logs?|cache|run)(\/|$)/.test(relative) || /\.(sqlite|db|wal|shm|sock)(-\w+)?$/.test(relative)).map((file) => `${label}/${path.relative(root, file)}`)).filter((file) => !/^project\/(sample\.txt|README\.md|private\/keys\.txt)$/.test(file)).slice(0, 40)
}

/** Tool names the model called, from the JSON event stream. */
function toolsCalled(outDir: string, id: string): string[] {
  const names: string[] = []
  for (const line of readFileSync(path.join(outDir, `${id}.jsonl`), "utf8").split("\n")) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line) as Record<string, unknown>
      const tool = (event.meta as { tool?: string } | undefined)?.tool ?? (event.tool as string | undefined)
      if (event.type === "item.started" && event.kind === "tool_call" && tool) names.push(tool.split(/[:\s]/)[0]!)
    } catch { /* not JSON */ }
  }
  return names
}

async function pool<T, R>(items: T[], jobs: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(jobs, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await work(items[index]!) }
  }))
  return results
}

async function selfTest(selected: Case[]) {
  let ok = true
  for (const entry of selected) {
    const empty = makeLayout()
    const negative = runCheck(entry, empty)
    const solved = makeLayout()
    entry.reference(solved)
    const positive = runCheck(entry, solved)
    const fine = !negative.pass && positive.pass
    ok &&= fine
    console.log(`${fine ? "ok  " : "BAD "} ${entry.id.padEnd(14)} empty: ${negative.pass ? `PASS (should fail: ${negative.detail})` : "fail"} · reference: ${positive.pass ? "pass" : `FAIL ${positive.detail}`}`)
    for (const layout of [empty, solved]) {
      await stopCaseDaemons(layout)
      rmSync(layout.root, { recursive: true, force: true })
    }
  }
  process.exit(ok ? 0 : 1)
}

async function main() {
  const argv = process.argv.slice(2)
  const flag = (name: string) => { const index = argv.indexOf(`--${name}`); return index >= 0 ? argv[index + 1] : undefined }
  if (flag("check")) return checkMain(flag("check")!, flag("root")!)
  const wanted = flag("cases")?.split(",").map((id) => id.trim()).filter(Boolean)
  const selected = wanted ? CASES.filter((entry) => wanted.includes(entry.id)) : CASES
  if (wanted && selected.length !== wanted.length) throw new Error(`unknown case in ${wanted.join(",")}; cases: ${CASES.map((c) => c.id).join(", ")}`)
  if (argv.includes("--self-test")) return await selfTest(selected)
  const model = flag("model") ?? "chatgpt/gpt-6-luna"
  if (/claude/i.test(model)) throw new Error("harness evals never use Claude models")
  const authFrom = path.resolve(flag("auth-from") ?? path.join(homedir(), ".codex"))
  const outDir = path.resolve(flag("out") ?? path.join(realpathSync(process.env.TMPDIR ?? tmpdir()), `eval-extend-${new Date().toISOString().replace(/[:.]/g, "-")}`))
  const keep = argv.includes("--keep")
  mkdirSync(outDir, { recursive: true })
  console.log(`model ${model} · ${selected.length} cases · out ${outDir}`)
  const results = await pool(selected, Number(flag("jobs") ?? 4), async (entry) => {
    const layout = makeLayout(authFrom)
    const run = await runModel(entry, layout, model, outDir)
    await stopCaseDaemons(layout)
    const verdict = runCheck(entry, layout)
    await stopCaseDaemons(layout)
    const result = { id: entry.id, lang: entry.lang, prompt: entry.prompt, ...verdict, exit: run.code, timedOut: run.timedOut, seconds: Math.round(run.ms / 1000), tools: toolsCalled(outDir, entry.id), files: changedFiles(layout), root: keep ? layout.root : undefined }
    console.log(`${verdict.pass ? "PASS" : "FAIL"} ${entry.id.padEnd(14)} ${String(result.seconds).padStart(4)}s  ${verdict.detail.slice(0, 160)}`)
    writeFileSync(path.join(outDir, `${entry.id}.result.json`), JSON.stringify(result, null, 2))
    if (!keep) rmSync(layout.root, { recursive: true, force: true })
    return result
  })
  const passed = results.filter((result) => result.pass).length
  writeFileSync(path.join(outDir, "summary.json"), JSON.stringify({ model, passed, total: results.length, at: new Date().toISOString(), results }, null, 2))
  console.log(`\n${passed}/${results.length} passed · ${outDir}/summary.json`)
}

await main()
