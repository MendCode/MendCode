import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { cleanEnv } from "../lib/env"
import { runProcess } from "../lib/proc"
import type { AdapterOptions, HarnessAdapter, PrepareContext, RunResult } from "../lib/types"
import { makeTempDir, removeKitTree } from "../lib/workspace"
import { linkAuth, readLines } from "./common"
import { mergeSessionFacts, parseCodexEvents, parseCodexSession } from "./codex-usage"

type State = { context: PrepareContext; root: string; home: string; codexHome: string; env: Record<string, string> }

/** Every `rollout-*.jsonl` under a Codex home's `sessions/`, newest first. */
export function findSessionFiles(codexHome: string): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    if (!existsSync(dir)) return
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (/^rollout-.*\.jsonl$/.test(name)) out.push(full)
    }
  }
  walk(path.join(codexHome, "sessions"))
  return out.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
}

/** The argument vector of one `codex exec` run (without the executable). Exported so tests pin the held-equal settings. */
export function codexExecArgs(input: { cwd: string; model: string; effort: string }): string[] {
  return [
    "exec", "--json",
    "-C", input.cwd,
    "-s", "workspace-write",
    "-m", input.model,
    "-c", `model_reasoning_effort="${input.effort}"`,
    "-c", 'approval_policy="never"',
    // Nothing of the operator's config.toml or execpolicy rules leaks in; auth still comes from CODEX_HOME.
    "--ignore-user-config", "--ignore-rules",
    // The prompt arrives on stdin.
    "-",
  ]
}

/** Official Codex CLI, non-interactive, in an isolated HOME / CODEX_HOME whose only credential is a link to the one given by `--auth-from`. */
export function createCodexAdapter(options: AdapterOptions): HarnessAdapter {
  const bin = options.codexBin ?? "codex"
  let state: State | undefined

  return {
    name: "codex",
    async prepare(context) {
      const root = makeTempDir("cx")
      const home = path.join(root, "home")
      const codexHome = path.join(home, ".codex")
      mkdirSync(codexHome, { recursive: true, mode: 0o700 })
      if (options.authFrom) linkAuth(options.authFrom, codexHome, { modelsCache: false })
      state = { context, root, home, codexHome, env: cleanEnv({ HOME: home, CODEX_HOME: codexHome }) }
    },
    async run(prompt, cwd, model): Promise<RunResult> {
      if (!state) throw new Error("[CODEX]: prepare() was not called")
      const s = state
      const notes: string[] = []
      const transcript = path.join(s.context.runDir, "transcript.jsonl")
      const result = await runProcess({
        command: [bin, ...codexExecArgs({ cwd, model, effort: s.context.effort })],
        cwd,
        env: s.env,
        stdin: prompt,
        stdoutPath: transcript,
        stderrPath: path.join(s.context.runDir, "stderr.log"),
        timeoutMs: s.context.timeoutMs,
      })
      const parsed = parseCodexEvents(readLines(transcript))
      let usage = parsed.usage
      const sessions = findSessionFiles(s.codexHome)
      const session = sessions[0]
      if (session) {
        copyFileSync(session, path.join(s.context.runDir, "codex-session.jsonl"))
        usage = mergeSessionFacts(usage, parseCodexSession(readLines(session)))
        if (sessions.length > 1) notes.push(`${sessions.length} session files in the isolated home; the newest was read`)
      } else notes.push("no Codex session file found: compactions unavailable")
      if (parsed.error) notes.push(`codex reported: ${parsed.error}`)
      if (parsed.status === "none" && !result.timedOut) notes.push("no turn event in the stream")
      if (usage.inputTokens === null) notes.push("no usage in the stream: token metrics unavailable")
      notes.push("turnMs and cache writes are not reported by codex exec")
      return { exitCode: result.exitCode, timedOut: result.timedOut, transcriptPath: transcript, usage, agentMs: result.durationMs, notes }
    },
    async cleanup() {
      const current = state
      state = undefined
      if (current) removeKitTree(current.root)
    },
    async describe() {
      const probe = makeTempDir("cxv")
      try {
        const out = path.join(probe, "version.txt")
        const result = await runProcess({ command: [bin, "--version"], cwd: probe, env: cleanEnv({ HOME: probe, CODEX_HOME: path.join(probe, ".codex") }), stdoutPath: out, timeoutMs: 15_000 })
        const text = existsSync(out) ? readLines(out).join("").trim() : ""
        return { adapter: "codex", bin, version: result.exitCode === 0 ? text : `unavailable (exit ${result.exitCode})` }
      } finally {
        removeKitTree(probe)
      }
    },
  }
}
