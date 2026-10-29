import { existsSync } from "node:fs"
import path from "node:path"
import type { Client, CommandInput } from "@mendcode/client"
import type { AgentsReport, BlobRef, ReasoningEffort, SessionDetail, SessionId, SessionSummary } from "@mendcode/protocol"
import { REASONING_EFFORTS } from "@mendcode/protocol/wire"
import { sessionSelection } from "./session-output"
import { isDraftOnly } from "./view/session-query"
import { COMPAT } from "./compat"
import { STDIN_FIRST_BYTE_MS } from "./run-stdin"
import { PROGRAM_NAME } from "@mendcode/program"

export type Startup = {
  kind: "run" | "tui" | "acp" | "app-server"
  words: string[]
  dataDir?: string
  project?: string
  engine?: string
  session?: SessionId
  continue: boolean
  fork: boolean
  model?: string
  agent?: string
  variant?: string
  /** `--effort LEVEL`: the reasoning effort of the session's model (the choice F3 and `/model ID LEVEL` make). */
  effort?: ReasoningEffort
  files: string[]
  command?: string
  title?: string
  prompt?: string
  initialMessage?: string
  json: boolean
  compat: boolean
  approve: boolean
  /** `--dangerously-skip-permissions` (run): `approve` plus allowing a command the engine itself flagged in full access. */
  skipPermissions: boolean
  thinking: boolean
  isolated: boolean
  diagnostics: boolean
  tuiControl: boolean
  /** `--alt-screen` / `--no-alt-screen`; unset leaves it to the saved `altScreen` setting. */
  altScreen?: boolean
  /** `--accessible`: screen-reader mode for this run (inline screen, no animation, no mouse reporting, plain text); the saved `accessible` setting and `MENDCODE_ACCESSIBLE` do the same. */
  accessible?: boolean
  help: boolean
  /** Scripted-run options (`run` only, except `offline`, which a global flag sets). */
  outputSchema?: string
  outputFile?: string
  ephemeral: boolean
  /** `run --bg`: submit the turn, print the session id and return; the daemon keeps working (`ps`, `logs`, `attach`, `kill`). */
  background?: boolean
  /** A bare `-` (run): stdin is read to its end even when a message is given; without it a message waits only briefly for a silent stdin (run-stdin.ts). */
  waitStdin?: boolean
  maxTurns?: number
  tools?: string[]
  excludeTools?: string[]
  systemPrompt?: string
  appendSystemPrompt?: string
  permission?: "ask" | "edits" | "plan" | "smart"
  offline: boolean
  /** `--no-context-files` / `-nc` (TUI and run): AGENTS.md and the other instruction files stay out of this session's prompt. */
  noContextFiles?: boolean
  /** `--add-dir PATH` (repeatable, TUI and run): extra workspace directories for this session only; `/add-dir` and the `additionalDirectories` setting do the same persistently. */
  addDirs?: string[]
  /** Flags MendCode does not know (`--name` true, `--name=value`): an extension's, checked by the daemon for the session (`extensions.flags`). */
  extensionFlags?: Record<string, string | true>
}

/** `-c/--config KEY=VALUE` keys: each maps onto the flag of the same meaning; an explicit flag wins over its key. */
export const CONFIG_KEYS: Record<string, { flag: string; boolean?: true }> = {
  model: { flag: "model" }, agent: { flag: "agent" }, variant: { flag: "variant" }, effort: { flag: "effort" }, permission: { flag: "permission" },
  max_turns: { flag: "max-turns" }, tools: { flag: "tools" }, exclude_tools: { flag: "exclude-tools" },
  system_prompt: { flag: "system-prompt" }, append_system_prompt: { flag: "append-system-prompt" },
  output_schema: { flag: "output-schema" }, output_last_message: { flag: "output-last-message" },
  offline: { flag: "offline", boolean: true }, ephemeral: { flag: "ephemeral", boolean: true }, thinking: { flag: "thinking", boolean: true },
}

const VALUES = new Set(["dir", "data-dir", "cwd", "project", "engine", "session", "model", "agent", "variant", "effort", "file", "command", "prompt", "initial-message", "format", "compat", "title", "output-schema", "output-last-message", "max-turns", "tools", "exclude-tools", "system-prompt", "append-system-prompt", "permission", "config", "add-dir"])
const BOOLEANS = new Set(["continue", "fork", "json", "approve", "dangerously-skip-permissions", "thinking", "isolated", "diagnostics", "help", "restart-daemon", "reasoning", "tui-control", "ephemeral", "no-tools", "offline", "no-context-files", "alt-screen", "no-alt-screen", "accessible", "bg"])
const ALIASES: Record<string, string> = { "-m": "--model", "-s": "--session", "-c": "--continue", "-f": "--file", "-h": "--help", "-o": "--output-last-message", "-nc": "--no-context-files" }
const RUN_ONLY = ["output-schema", "output-last-message", "max-turns", "tools", "exclude-tools", "system-prompt", "append-system-prompt", "permission"]
const list = (value: string) => value.split(",").map((entry) => entry.trim()).filter(Boolean)
const BLOCKED: Record<string, string> = {
  share: "--share requires a configured sharing service; no session is published",
  attach: "--attach naming is pending; use --connect HOST:PORT or --socket PATH for the MendCode protocol",
  password: "HTTP basic authentication is not supported by the MendCode wire transport; use --token-file with --connect",
  username: "HTTP basic authentication is not supported by the MendCode wire transport; use --token-file with --connect",
  port: "--port selects a legacy MendCode HTTP listener; local runs use a Unix socket, remote runs use --connect HOST:PORT",
}

/** Where `--file` candidates are looked up at parse time: the shell's directory (default) and the existence check (default: the file system). */
export type FileProbe = { cwd?: string; exists?(file: string): boolean }

export function parseStartup(argv: string[], probe: FileProbe = {}): Startup {
  const values = new Map<string, string>()
  const flags = new Set<string>()
  const files: string[] = []
  /** One per `--file`: its value, the bare arguments after it, and how many message words preceded it. */
  const fileGroups: Array<{ first: string; rest: string[]; at: number }> = []
  let waitStdin = false
  const words: string[] = []
  const config: string[] = []
  const addDirs: string[] = []
  const extensionFlags: Record<string, string | true> = {}
  for (let index = 0; index < argv.length; index++) {
    // `-c KEY=VALUE` is a config override; a bare `-c` stays the short form of --continue.
    const token = argv[index] === "-c" && /^[A-Za-z_][\w.-]*=/.test(argv[index + 1] ?? "") ? "--config" : ALIASES[argv[index]!] ?? argv[index]!
    if (token === "-") { waitStdin = true; continue }
    if (token === "--") { words.push(...argv.slice(index + 1)); break }
    if (!token.startsWith("-")) { words.push(token); continue }
    const [name, inline] = token.replace(/^--/, "").split(/=(.*)/s, 2)
    if (BLOCKED[name!]) throw new Error(BLOCKED[name!])
    if (token === "-p" || token === "-u") throw new Error(BLOCKED.password)
    if (BOOLEANS.has(name!) || name === "optional") {
      if (inline !== undefined) throw new Error(`--${name} does not take a value`)
      flags.add(name!)
    } else if (VALUES.has(name!) || name === "usd") {
      const optionalTitle = name === "title" && (argv[index + 1] === undefined || argv[index + 1]!.startsWith("-"))
      const value = inline ?? (optionalTitle ? "" : argv[++index])
      if (value === undefined || value.startsWith("--") || value === "" && name !== "title" && name !== "initial-message") throw new Error(`--${name} needs a value`)
      if (name === "config") config.push(value)
      else if (name === "add-dir") addDirs.push(value)
      else if (name === "file") {
        const rest: string[] = []
        if (inline === undefined) while (argv[index + 1] && !argv[index + 1]!.startsWith("-")) rest.push(argv[++index]!)
        fileGroups.push({ first: value, rest, at: words.length })
      } else values.set(name!, value)
    } else if (token.startsWith("--") && EXTENSION_FLAG.test(name!) && !nearBuiltin(name!)) {
      // A flag MendCode does not know may be an extension's (`api.registerFlag`): the daemon checks it against the session's extensions.
      extensionFlags[name!] = inline ?? true
    } else throw new Error(`unknown flag ${token.split("=")[0]}${nearBuiltin(name!) ? ` (did you mean --${nearBuiltin(name!)}?)` : ""}`)
  }
  if ((words[0] === "acp" || words[0] === "app-server") && Object.keys(extensionFlags).length) throw new Error(`unknown flag --${Object.keys(extensionFlags)[0]}`)
  // `--file a.png b.png "prompt"`: the value of --file is always an attachment (a missing one is reported by the daemon); of the bare
  // arguments after it, the existing paths are attachments too and the first one that is not a path starts the message, where it stood.
  // Paths are checked in the project the command names (--cwd/--project, else the shell's directory); the split needs it before any daemon is asked.
  const base = path.resolve(probe.cwd ?? process.env.PWD ?? process.cwd(), values.get("cwd") ?? values.get("project") ?? "")
  const isPath = probe.exists ?? existsSync
  const split = fileGroups.map((group) => {
    const end = group.rest.findIndex((entry) => !isPath(path.resolve(base, entry)))
    return { at: group.at, paths: [group.first, ...(end < 0 ? group.rest : group.rest.slice(0, end))], text: end < 0 ? [] : group.rest.slice(end) }
  })
  for (const group of split) files.push(...group.paths)
  for (const group of split.reverse()) words.splice(group.at, 0, ...group.text)
  for (const entry of config) {
    const [rawKey, value] = entry.split(/=(.*)/s, 2) as [string, string]
    const key = rawKey.toLowerCase().replaceAll("-", "_").replace(/^mendcode\./, "")
    const known = CONFIG_KEYS[key]
    if (!known) throw new Error(`unknown config key ${rawKey}; supported: ${Object.keys(CONFIG_KEYS).join(", ")}`)
    if (known.boolean) {
      if (value !== "true" && value !== "false") throw new Error(`config ${rawKey} needs true or false`)
      if (value === "true") flags.add(known.flag)
    } else if (!values.has(known.flag)) {
      if (value === "") throw new Error(`config ${rawKey} needs a value`)
      values.set(known.flag, value)
    }
  }
  // `attach ID` opens the terminal UI on a session (typically one started with `run --bg`).
  if (words[0] === "attach") {
    words.shift()
    if (words.length !== 1) throw new Error("attach needs one session id")
    if (values.has("session") || flags.has("continue")) throw new Error("attach takes the session id; do not combine it with --session or --continue")
    values.set("session", words.shift()!)
  }
  if (words[0] === "pet" && words[1] === "new") {
    if (values.has("prompt") || values.has("initial-message")) throw new Error("pet new cannot combine with --prompt or --initial-message")
    values.set("prompt", `/pet ${words.slice(1).join(" ")}${values.has("usd") ? ` --usd ${values.get("usd")}` : ""}${flags.has("optional") ? " --optional" : ""}`)
    words.length = 0
  } else if (values.has("usd") || flags.has("optional")) {
    throw new Error("--usd and --optional require pet new")
  }
  const kind = words[0] === "run" ? "run" : words[0] === "acp" ? "acp" : words[0] === "app-server" ? "app-server" : "tui"
  if (kind !== "run" && flags.has("bg")) throw new Error("--bg requires run")
  if (flags.has("bg") && (flags.has("ephemeral") || flags.has("approve") || flags.has("dangerously-skip-permissions") || flags.has("thinking") || values.has("output-schema") || values.has("output-last-message"))) throw new Error("--bg returns at once: it cannot combine with --ephemeral, --approve, --dangerously-skip-permissions, --thinking, --output-schema or --output-last-message (approvals wait for `attach`; use --permission to set the mode)")
  if (kind !== "tui") words.shift()
  else if (words[0] === "thread") words.shift()
  if (kind === "tui" && words.length > 1 || (kind === "acp" || kind === "app-server") && words.length) throw new Error(`${kind} takes ${kind === "tui" ? "one project path" : "no positional arguments"}`)
  if (flags.has("fork") && !flags.has("continue") && !values.has("session")) throw new Error("--fork requires --continue or --session")
  if (values.has("format") && !["default", "json"].includes(values.get("format")!)) throw new Error("--format must be default or json")
  if (values.has("compat") && values.get("compat") !== COMPAT) throw new Error(`--compat must be ${COMPAT}`)
  if (files.length > 32) throw new Error("--file accepts at most 32 attachments")
  if (addDirs.length > 20) throw new Error("--add-dir accepts at most 20 directories")
  if ((kind === "acp" || kind === "app-server") && addDirs.length) throw new Error("--add-dir requires the TUI or run")
  if (kind !== "run" && (files.length || values.has("command") || flags.has("thinking") || flags.has("dangerously-skip-permissions"))) throw new Error("--file, --command, --thinking and --dangerously-skip-permissions require run")
  if (kind !== "run" && (RUN_ONLY.some((name) => values.has(name)) || flags.has("ephemeral") || flags.has("no-tools"))) throw new Error("--output-schema, --output-last-message, --ephemeral, --max-turns, --tools, --exclude-tools, --no-tools, --system-prompt, --append-system-prompt and --permission require run")
  if (flags.has("ephemeral") && (flags.has("continue") || values.has("session") || flags.has("fork"))) throw new Error("--ephemeral starts a new session that is deleted afterwards; it cannot combine with --continue, --session or --fork")
  if (flags.has("no-tools") && (values.has("tools") || values.has("exclude-tools"))) throw new Error("--no-tools cannot combine with --tools or --exclude-tools")
  if (values.has("effort") && !(REASONING_EFFORTS as readonly string[]).includes(values.get("effort")!)) throw new Error(`--effort must be one of ${REASONING_EFFORTS.join(", ")}`)
  if (values.has("max-turns") && !/^[1-9]\d{0,3}$/.test(values.get("max-turns")!)) throw new Error("--max-turns needs an integer from 1 to 1000")
  if (values.has("max-turns") && Number(values.get("max-turns")) > 1000) throw new Error("--max-turns needs an integer from 1 to 1000")
  if (values.has("permission") && !["ask", "edits", "plan", "smart"].includes(values.get("permission")!)) throw new Error("--permission must be ask, edits, plan or smart")
  if (values.has("tools") && !list(values.get("tools")!).length) throw new Error("--tools needs at least one tool name; use --no-tools for none")
  if (kind !== "tui" && (values.has("prompt") || values.has("initial-message") || flags.has("isolated") || flags.has("diagnostics"))) throw new Error("--prompt, --initial-message, --isolated and --diagnostics require the TUI")
  if (kind !== "tui" && flags.has("tui-control")) throw new Error("--tui-control requires the TUI")
  if (kind !== "tui" && (flags.has("alt-screen") || flags.has("no-alt-screen"))) throw new Error("--alt-screen and --no-alt-screen require the TUI")
  if (kind !== "tui" && flags.has("accessible")) throw new Error("--accessible requires the TUI")
  if (flags.has("alt-screen") && flags.has("no-alt-screen")) throw new Error("use --alt-screen or --no-alt-screen, not both")
  if (values.has("prompt") && values.has("initial-message")) throw new Error("use --prompt or --initial-message, not both")
  if (values.has("dir") && values.has("data-dir")) throw new Error("use --dir or --data-dir for daemon storage")
  const projects = [values.get("cwd"), values.get("project"), ...(kind === "tui" ? words : [])].filter((value) => value !== undefined)
  if (projects.length > 1) throw new Error("choose one project path: positional, --cwd or --project")
  return {
    kind, words: kind === "tui" ? [] : words, files,
    ...(values.has("data-dir") || values.has("dir") ? { dataDir: (values.get("data-dir") ?? values.get("dir"))! } : {}),
    ...(projects[0] ? { project: projects[0] } : {}),
    ...(values.has("engine") ? { engine: values.get("engine")! } : {}),
    ...(values.has("session") ? { session: values.get("session") as SessionId } : {}),
    ...(values.has("model") ? { model: values.get("model")! } : {}),
    ...(values.has("agent") ? { agent: values.get("agent")! } : {}),
    ...(values.has("variant") ? { variant: values.get("variant")! } : {}),
    ...(values.has("effort") ? { effort: values.get("effort") as ReasoningEffort } : {}),
    ...(values.has("command") ? { command: values.get("command")! } : {}),
    ...(values.has("title") ? { title: values.get("title")! } : {}),
    ...(values.has("prompt") ? { prompt: values.get("prompt")! } : {}),
    ...(values.has("initial-message") ? { initialMessage: values.get("initial-message")! } : {}),
    continue: flags.has("continue"), fork: flags.has("fork"), json: flags.has("json") || values.get("format") === "json" || values.has("compat"),
    compat: values.has("compat"), approve: flags.has("approve") || flags.has("dangerously-skip-permissions"), skipPermissions: flags.has("dangerously-skip-permissions"), thinking: flags.has("thinking"),
    isolated: flags.has("isolated"), diagnostics: flags.has("diagnostics"), help: flags.has("help"),
    tuiControl: flags.has("tui-control"),
    ephemeral: flags.has("ephemeral"), offline: flags.has("offline"),
    ...(addDirs.length ? { addDirs } : {}),
    ...(flags.has("no-context-files") ? { noContextFiles: true } : {}),
    ...(flags.has("bg") ? { background: true } : {}),
    ...(waitStdin ? { waitStdin: true } : {}),
    ...(values.has("output-schema") ? { outputSchema: values.get("output-schema")! } : {}),
    ...(values.has("output-last-message") ? { outputFile: values.get("output-last-message")! } : {}),
    ...(values.has("max-turns") ? { maxTurns: Number(values.get("max-turns")) } : {}),
    ...(flags.has("no-tools") ? { tools: [] } : values.has("tools") ? { tools: list(values.get("tools")!) } : {}),
    ...(values.has("exclude-tools") ? { excludeTools: list(values.get("exclude-tools")!) } : {}),
    ...(values.has("system-prompt") ? { systemPrompt: values.get("system-prompt")! } : {}),
    ...(values.has("append-system-prompt") ? { appendSystemPrompt: values.get("append-system-prompt")! } : {}),
    ...(values.has("permission") ? { permission: values.get("permission") as NonNullable<Startup["permission"]> } : {}),
    ...(flags.has("no-alt-screen") ? { altScreen: false } : flags.has("alt-screen") ? { altScreen: true } : {}),
    ...(flags.has("accessible") ? { accessible: true } : {}),
    ...(Object.keys(extensionFlags).length ? { extensionFlags } : {}),
  }
}

/** `--name` or `--name=value` of a flag an extension may declare: what `api.registerFlag` accepts. */
const EXTENSION_FLAG = /^[a-z][a-z0-9-]{0,39}$/
/** A built-in flag one or two edits away (`--modle`): a typo is reported here instead of reaching the daemon as an extension flag. */
function nearBuiltin(name: string): string | undefined {
  const known = [...VALUES, ...BOOLEANS]
  return known.find((flag) => flag !== name && Math.abs(flag.length - name.length) <= 2 && distance(flag, name) <= (name.length <= 4 ? 1 : 2))
}
function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++) current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    previous = current
  }
  return previous[b.length]!
}

export const STARTUP_USAGE = [
  `${PROGRAM_NAME} pet new DESCRIPTION [--usd ESTIMATED_USD_PER_CALL] [--optional] opens the paid-call confirmation in the terminal`,
  `${PROGRAM_NAME} [PROJECT] [--model P/M] [--agent A] [--continue | --session ID] [--fork]`,
  "  --prompt TEXT submits once · --initial-message TEXT fills the editor without submitting",
  "  --add-dir PATH (repeatable, also on run) treats another directory as part of the workspace for this session",
  "  --no-context-files (-nc, also on run) leaves AGENTS.md and the other instruction files out of this session's prompt · --strict-config stops when a setting is invalid",
  "  --isolated starts a private temporary daemon · --diagnostics enables /diagnostics and /snapshot",
  "  --process daemon|auto|solo: auto (default) or solo runs the daemon inside this terminal's process when none runs; daemon uses a separate one (about a quarter less memory; a hard-killed terminal interrupts its running turn; slower first frame) (or MENDCODE_PROCESS, or the processMode setting)",
  "  --no-alt-screen keeps the chat inline so output lands in the terminal scrollback · --alt-screen forces the full screen",
  "  --safe-mode starts with no extensions, packages, shell hooks, MCP or project tools (or MENDCODE_SAFE_MODE=1); see /doctor",
  "  --accessible screen-reader mode: inline screen, no animation, no mouse reporting, plain text (or MENDCODE_ACCESSIBLE=1, or /accessible on)",
  "  --NAME or --NAME=VALUE (also on run) a flag one of your extensions declares (api.registerFlag), for the session this opens",
  `${PROGRAM_NAME} run [MESSAGE…] [--cwd PROJECT] [--model P/M] [--agent A] [--variant V] [--effort LEVEL]`,
  "  --effort minimal|low|medium|high|xhigh sets the model's reasoning effort and must be one of that model's levels (also on the TUI; for a Claude Code model --variant LEVEL means the same) · --variant names a provider variant",
  "  --continue | --session ID · --fork · --command NAME · --file PATH… · --title [TITLE]",
  "  --file takes the existing paths after it; the first argument that is not one starts the message (--file a.png \"prompt\" and \"prompt\" --file a.png both work)",
  `  piped stdin is appended to MESSAGE; with a MESSAGE, a stdin that stays silent for ${STDIN_FIRST_BYTE_MS / 1000} s is skipped (a bare - waits for its end)`,
  "  --format default|json · --thinking · --approve | --dangerously-skip-permissions",
  "  --output-schema FILE · -o/--output-last-message FILE · --ephemeral · --max-turns N",
  "  --tools a,b | --no-tools · --exclude-tools a,b · --system-prompt TEXT · --append-system-prompt TEXT",
  "  -c/--config KEY=VALUE (model, agent, variant, effort, permission, max_turns, tools, exclude_tools, offline, ephemeral, …) · --offline",
  "  --bg submits the turn and returns the session id at once (approvals wait; use --permission) · follow with ps, logs ID [-f], attach ID, kill ID",
  "  exit codes: 0 done · 1 failed · 2 stopped · 3 answer rejected by --output-schema · 4 --max-turns reached · 5 approval denied without --approve and nothing ran after it · 64 usage",
  `${PROGRAM_NAME} attach SESSION_ID · ps · logs SESSION_ID [-f] · kill SESSION_ID`,
  `${PROGRAM_NAME} acp [--cwd PROJECT]`,
  `${PROGRAM_NAME} app-server [--cwd PROJECT]   JSON-RPC on stdio for third-party UIs (docs/embedding.md)`,
  "  --dir DATA (or --data-dir DATA) selects daemon storage, never the project",
  "  --connect HOST:PORT (also --server-url) / --socket PATH uses the MendCode wire protocol",
  "  --tui-control opts this terminal into local project control",
].join("\n") + "\n"

async function request(client: Pick<Client, "send">, command: CommandInput) {
  const reply = await client.send(command)
  if (!reply.ok) throw new Error(reply.error.message)
  return reply.result ?? {}
}

const SESSION_ID = /^ses_[0-9A-HJKMNP-TV-Z]{26}$/

/**
 * `--session` as typed: a whole id goes through as is; otherwise the case, a missing `ses_`, a piece of the id (its start or
 * end) or a stray character typed after it names the one session it fits. None or several is an error that says so.
 */
export async function resolveSessionArg(client: Pick<Client, "send">, typed: string): Promise<SessionId> {
  const raw = typed.trim()
  if (SESSION_ID.test(raw)) return raw as SessionId
  const body = raw.replace(/^ses_/i, "").toUpperCase()
  if (SESSION_ID.test(`ses_${body}`)) return `ses_${body}` as SessionId
  if (body.length < 4) throw new Error(`${typed} is not a session id · ${PROGRAM_NAME} session list shows them`)
  const listed = await request(client, { type: "session.list", roots: false, archived: true, limit: 500 })
  const fits = (listed.sessions as SessionSummary[]).filter(({ sessionId }) => {
    const id = sessionId.slice(4)
    return id.startsWith(body) || id.endsWith(body) || (body.startsWith(id) && body.length <= id.length + 2)
  })
  if (fits.length === 1) return fits[0]!.sessionId
  if (fits.length > 1) throw new Error(`${typed} fits ${fits.length} sessions (${fits.slice(0, 3).map((session) => session.sessionId).join(", ")}${fits.length > 3 ? ", …" : ""}) · type more of the id`)
  throw new Error(`no session ${typed} · ${PROGRAM_NAME} session list shows them`)
}

export async function prepareStartup(client: Pick<Client, "send">, options: Startup, directory: string, prompt = "", remote?: { readOnly: boolean }) {
  let sessionId = options.session ? await resolveSessionArg(client, options.session) : undefined
  if (!sessionId && (options.continue || remote)) {
    // The last session worked in: not a blank chat, nor one that holds only an unsent draft.
    const listed = await request(client, { type: "session.list", directory, roots: true, hideEmpty: true, limit: 50 })
    sessionId = (listed.sessions as SessionSummary[]).find((session) => !isDraftOnly(session))?.sessionId
  }
  if (sessionId) {
    const result = await request(client, { type: "session.get", sessionId })
    directory = (result.session as SessionDetail).directory
  }
  if (remote?.readOnly && (options.fork || !sessionId || options.model || options.agent || options.variant || options.effort || options.title !== undefined)) throw new Error("read-only attach requires an existing session without startup changes")
  const selected = await sessionSelection(client, options, sessionId ? { sessionId } : {})
  if (!selected.ok) throw new Error(selected.message)
  if (selected.agent) {
    const result = await request(client, { type: "agents.list", directory })
    const agent = (result as unknown as AgentsReport).agents.find((entry) => entry.name === selected.agent)
    if (!agent || agent.mode === "subagent" || !agent.trusted) throw new Error(`agent ${selected.agent} is not an available primary agent`)
  }
  const title = options.title === "" ? prompt.slice(0, 50) + (prompt.length > 50 ? "..." : "") : options.title
  if (sessionId && options.fork) {
    const forked = await request(client, { type: "session.fork", sessionId, transcript: true, ...(title !== undefined ? { title } : {}) })
    sessionId = forked.sessionId as SessionId
  } else if (!sessionId) {
    // A terminal opening a blank chat takes the project's empty one; `run`, ACP and the app server make the session they asked for.
    const created = await request(client, { type: "session.create", directory, title: title ?? "", ...(selected.agent ? { agent: selected.agent } : {}), ...(selected.model ? { choice: selected.model } : {}), ...(options.kind === "tui" ? { reuseEmpty: true } : {}) })
    return { sessionId: created.sessionId as SessionId, directory }
  }
  if (selected.model) await request(client, { type: "session.model.set", sessionId, choice: selected.model })
  if (selected.agent) await request(client, { type: "session.agent.set", sessionId, agent: selected.agent })
  return { sessionId, directory }
}

export async function prepareRunSubmission(client: Pick<Client, "send">, options: Startup, sessionId: SessionId, directory: string, prompt: string, remote = false): Promise<CommandInput> {
  if (remote && options.files.length) throw new Error("file attachments disabled while remote")
  const attachments: BlobRef[] = []
  let fileText = ""
  for (const file of options.files) {
    const result = await request(client, { type: "attachment.paste", path: path.resolve(directory, file), allowDirectory: true })
    if (result.kind === "image") attachments.push(result.attachment as BlobRef)
    else fileText += `\n\n[${result.name}]\n${result.content}`
  }
  if (options.command) return { type: "commands.execute", sessionId, name: options.command.replace(/^\//, ""), args: prompt, attachments, ...(fileText ? { contextText: fileText } : {}) }
  return { type: "user.submit", sessionId, text: prompt + fileText, attachments }
}
