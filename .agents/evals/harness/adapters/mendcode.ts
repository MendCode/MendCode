import { spawn, type ChildProcess } from "node:child_process"
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { cleanEnv } from "../lib/env"
import { runProcess } from "../lib/proc"
import { HARNESS_ROOT } from "../lib/tasks"
import { assertSafeStateRoot, removeOwnedChild } from "../lib/safety"
import { emptyUsage, type AdapterOptions, type HarnessAdapter, type PrepareContext, type RunResult } from "../lib/types"
import { makeTempDir } from "../lib/workspace"
import { linkAuth, randomId, readLines } from "./common"
import { TIER_BUNDLES } from "@mendcode/protocol/wire"
import { MENDCODE_EVAL_ENV, MENDCODE_EVAL_SETTINGS, MENDCODE_PROMPT_MODE } from "./mendcode-settings"
import { parseMendcodeEvents } from "./mendcode-usage"

const REPO_ROOT = path.resolve(HARNESS_ROOT, "../../..")
/** Unix socket paths are limited to about 104 bytes; the daemon's lives at `<dataDir>/mendd.sock`. */
const MAX_SOCKET_PATH = 100

type State = { context: PrepareContext; stateDir: string; home: string; dataDir: string; env: Record<string, string> }

/** `chatgpt/<model>` unless the caller already wrote a provider. */
export function nativeModelRef(model: string): string {
  return model.includes("/") ? model : `chatgpt/${model}`
}

/** The model selection of a native `mendcode run`: `--effort` sets the reasoning effort (`--variant` would name a provider variant), and the CLI refuses a level the model does not list. */
export function nativeRunArgs(model: string, effort: string): string[] {
  return ["--model", nativeModelRef(model), "--effort", effort]
}

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

type PromptModeStatus ={ mode?: string; focusID?: string; resolvedFocus?: string }

/** The JSON that `mendcode prompt mode` printed, or undefined when it did not print one. */
export function promptModeOf(file: string): PromptModeStatus | undefined {
  try {
    // The CLI prints a one-line summary before the JSON.
    const text = readFileSync(file, "utf8")
    return JSON.parse(text.slice(Math.max(0, text.search(/^\{/m)))) as PromptModeStatus
  } catch {
    return undefined
  }
}

async function socketAccepts(socketPath: string): Promise<boolean> {
  try {
    const socket = await Bun.connect({ unix: socketPath, socket: { data() {} } })
    socket.end()
    return true
  } catch {
    return false
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * The product's own headless path: a daemon on a dedicated data directory (native engine, isolated HOME), then
 * `mendcode run --json` against it. The kit starts the daemon itself so its lifetime, environment and cleanup are
 * its own; the CLI finds it through the data directory's socket and starts nothing.
 */
export function createMendcodeAdapter(options: AdapterOptions): HarnessAdapter {
  const engine = options.engine ?? "native"
  // Claude models run inside a native daemon: the model's catalog entry (`engine: "claude"`) routes the turn to Claude Code.
  const daemonEngine = engine === "claude" ? "native" : engine
  const cli = options.mendcodeCommand ?? [process.execPath, path.join(REPO_ROOT, "apps/cli/src/entry.ts")]
  const daemonCommand = options.daemonCommand ?? [process.execPath, path.join(REPO_ROOT, "packages/daemon/src/main.ts")]
  // `--tier` runs the data dir as `/tier <name>` leaves it: that tier and its bundle's prompt mode. Without it, the balanced focus arm.
  const settings = { ...MENDCODE_EVAL_SETTINGS, tier: options.tier ?? MENDCODE_EVAL_SETTINGS.tier }
  const promptMode = options.tier ? { mode: TIER_BUNDLES[options.tier].promptMode, focus: MENDCODE_PROMPT_MODE.focus } : MENDCODE_PROMPT_MODE
  let state: State | undefined
  let daemon: ChildProcess | undefined

  async function stopDaemon() {
    const child = daemon
    daemon = undefined
    if (!child || child.pid === undefined) return
    const pid = child.pid
    const signal = (name: NodeJS.Signals) => {
      try { process.kill(-pid, name) } catch { /* group already gone */ }
    }
    signal("SIGTERM")
    for (let waited = 0; waited < 10_000 && processAlive(pid); waited += 100) await Bun.sleep(100)
    if (processAlive(pid)) {
      signal("SIGKILL")
      for (let waited = 0; waited < 3_000 && processAlive(pid); waited += 100) await Bun.sleep(100)
    }
  }

  async function startDaemon(s: State, cwd: string): Promise<void> {
    const log = openSync(path.join(s.context.runDir, "daemon.log"), "w")
    try {
      daemon = spawn(daemonCommand[0]!, [...daemonCommand.slice(1), "--dir", s.dataDir, "--cwd", cwd, "--engine", daemonEngine, "--local-transport", "unix", "--local-only"], {
        cwd,
        env: s.env,
        detached: true,
        stdio: ["ignore", log, log],
      })
    } finally {
      closeSync(log)
    }
    daemon.on("error", () => {})
    const socketPath = path.join(s.dataDir, "mendd.sock")
    for (let waited = 0; waited < 30_000; waited += 100) {
      if (daemon.exitCode !== null) throw new Error(`[MENDCODE]: the daemon exited with ${daemon.exitCode} before it listened; see daemon.log`)
      if (await socketAccepts(socketPath)) return
      await Bun.sleep(100)
    }
    throw new Error("[MENDCODE]: the daemon did not listen within 30 s; see daemon.log")
  }

  async function applySettings(s: State): Promise<void> {
    const client = createClient({ socketPath: path.join(s.dataDir, "mendd.sock"), name: "eval-kit", timeoutMs: 20_000 })
    try {
      await client.connect()
      const reply = await client.send({ type: "settings.set", patch: { ...settings } })
      if (!reply.ok) throw new Error(`[MENDCODE]: settings.set refused: ${JSON.stringify(reply.error)}`)
      // Evidence that the daemon holds the values, not just that it accepted the command.
      const saved = (reply.result?.settings ?? {}) as Record<string, unknown>
      const applied = Object.fromEntries(Object.keys(settings).map((key) => [key, saved[key]]))
      writeFileSync(path.join(s.context.runDir, "settings-applied.json"), `${JSON.stringify(applied, null, 2)}\n`)
      if (JSON.stringify(applied) !== JSON.stringify(settings)) throw new Error(`[MENDCODE]: the daemon did not keep the evaluation settings: ${JSON.stringify(applied)}`)
    } finally {
      client.close()
    }
  }

  async function cliStep(s: State, args: string[], cwd: string, name: string, timeoutMs = 60_000) {
    return runProcess({
      command: [...cli, ...args, "--dir", s.dataDir],
      cwd,
      env: s.env,
      stdoutPath: path.join(s.context.runDir, `${name}.out`),
      stderrPath: path.join(s.context.runDir, `${name}.err`),
      timeoutMs,
    })
  }

  return {
    name: "mendcode",
    async prepare(context) {
      const root = assertSafeStateRoot(options.dataDir ?? makeTempDir("data"))
      const stateDir = path.join(root, `r${randomId(3)}`)
      const dataDir = path.join(stateDir, "d")
      const home = path.join(stateDir, "home")
      mkdirSync(dataDir, { recursive: true, mode: 0o700 })
      mkdirSync(path.join(home, ".codex"), { recursive: true, mode: 0o700 })
      if (path.join(dataDir, "mendd.sock").length > MAX_SOCKET_PATH) throw new Error(`[MENDCODE]: ${dataDir} is too long for a unix socket; pass a shorter --data-dir`)
      if (options.authFrom && engine === "native") linkAuth(options.authFrom, path.join(home, ".codex"), { modelsCache: true })
      const env = cleanEnv({ HOME: home, MENDCODE_V2_DIR: dataDir, MENDCODE_V2_ENGINE: daemonEngine, ...MENDCODE_EVAL_ENV })
      if (engine === "claude") {
        // The daemon keeps its isolated HOME; only the `claude` process it spawns sees the operator's, where Claude Code finds
        // its own login. The kit reads no credential. The trace is the raw stream-json exchanged with that process.
        const wrapper = path.join(stateDir, "claude")
        writeFileSync(wrapper, `#!/bin/sh\nHOME=${shellQuote(homedir())} exec ${shellQuote(options.claudeBin ?? "claude")} "$@"\n`, { mode: 0o700 })
        delete env.MENDCODE_CLAUDE
        env.MENDCODE_CLAUDE_BIN = wrapper
        env.MENDCODE_CLAUDE_TRACE = path.join(context.runDir, "claude-trace.log")
      }
      state = { context, stateDir, home, dataDir, env }
    },
    async run(prompt, cwd, model): Promise<RunResult> {
      if (!state) throw new Error("[MENDCODE]: prepare() was not called")
      const s = state
      const notes: string[] = []
      const events = path.join(s.context.runDir, "transcript.jsonl")
      try {
        await startDaemon(s, cwd)
        await applySettings(s)
        const mode = await cliStep(s, ["prompt", "mode", promptMode.mode, ...(promptMode.mode === "focus" ? ["--focus", promptMode.focus] : [])], cwd, "prompt-mode")
        const appliedMode = promptModeOf(path.join(s.context.runDir, "prompt-mode.out"))
        if (mode.exitCode !== 0 || appliedMode?.mode !== promptMode.mode) notes.push(`prompt mode ${promptMode.mode} was not confirmed (exit ${mode.exitCode}); see prompt-mode.out`)
        else notes.push(`prompt mode ${appliedMode.mode}, family ${appliedMode.focusID} (resolved ${appliedMode.resolvedFocus ?? "per model"})`)
        // A Claude Code model is named as the catalog lists it (`claude-haiku`) and runs at its own default effort.
        const modelArgs = engine === "native" ? nativeRunArgs(model, s.context.effort) : engine === "claude" ? ["--model", model] : []
        const result = await runProcess({
          command: [...cli, "run", "-", "--json", "--approve", "--offline", "--cwd", cwd, ...modelArgs, "--dir", s.dataDir],
          cwd,
          env: s.env,
          stdin: prompt,
          stdoutPath: events,
          stderrPath: path.join(s.context.runDir, "stderr.log"),
          timeoutMs: s.context.timeoutMs,
        })
        const parsed = parseMendcodeEvents(readLines(events))
        if (parsed.error) notes.push(`turn failed: ${parsed.error}`)
        if (parsed.turnStatus === "none" && !result.timedOut) notes.push("no terminal turn event in the stream")
        if (parsed.retries > 0) notes.push(`${parsed.retries} provider retries`)
        if (parsed.usage.inputTokens === null) notes.push("no usage.recorded event: token metrics unavailable")
        return { exitCode: result.exitCode, timedOut: result.timedOut, transcriptPath: events, usage: parsed.usage, agentMs: result.durationMs, notes }
      } catch (error) {
        notes.push(error instanceof Error ? error.message : String(error))
        writeFileSync(path.join(s.context.runDir, "adapter-error.txt"), `${notes.join("\n")}\n`)
        return { exitCode: null, timedOut: false, transcriptPath: null, usage: emptyUsage(), agentMs: 0, notes }
      } finally {
        await stopDaemon()
      }
    },
    async cleanup() {
      await stopDaemon()
      const current = state
      state = undefined
      // State lives under the dedicated data directory; only this run's own subdirectory is removed.
      if (current) removeOwnedChild(path.dirname(current.stateDir), current.stateDir)
    },
    async describe() {
      return { adapter: "mendcode", engine, command: cli.join(" "), settings: JSON.stringify(settings), promptMode: JSON.stringify(promptMode) }
    },
  }
}
