import { spawnSync } from "child_process"
import { mkdir, writeFile, appendFile } from "fs/promises"
import path from "path"
import { performance } from "perf_hooks"
import { mendPaths } from "../config/paths"

type BenchCommand = { cmd: string; args: string[]; expectFailure?: boolean }

function benchCommands(): BenchCommand[] {
  return [
    { cmd: "mendcode", args: ["status"] },
    { cmd: "mendcode", args: ["doctor"] },
    { cmd: "mendcode", args: ["context", "refresh"] },
    { cmd: "mendcode", args: ["budget", "status"] },
    { cmd: "mendcode", args: ["budget", "doctor"] },
    { cmd: "mendcode", args: ["models", "status"] },
    { cmd: "mendcode", args: ["models", "plan"] },
    { cmd: "mendcode", args: ["tui", "status"] },
    { cmd: "mendcode", args: ["tui", "preview-plan"] },
    { cmd: "mendcode", args: ["tui", "runtime-plan"] },
    { cmd: "mendcode", args: ["tui", "probe"] },
    { cmd: "mendcode", args: ["focus", "status"] },
    { cmd: "mendcode", args: ["worktree", "status"] },
    { cmd: "mendcode", args: ["worktree", "doctor"] },
    { cmd: "mendcode", args: ["tsm", "status"] },
    { cmd: "mendcode", args: ["tsm", "plan"] },
    { cmd: "mendcode", args: ["tsm", "doctor"] },
    { cmd: "mendcode", args: ["mflow", "status"] },
    { cmd: "mendcode", args: ["mflow", "plan"] },
    { cmd: "mendcode", args: ["mflow", "doctor"] },
    { cmd: "mendcode", args: ["export", "plan"] },
    { cmd: "mendcode", args: ["setup", "status"] },
    { cmd: "mendcode", args: ["setup", "plan"] },
    { cmd: "mendcode", args: ["setup", "doctor"] },
    { cmd: "mendcode", args: ["ai", "status"] },
    { cmd: "mendcode", args: ["ai", "env", "status"] },
    { cmd: "mendcode", args: ["runtime", "status"] },
    { cmd: "mendcode", args: ["runtime", "plan"] },
    { cmd: "mendcode", args: ["prompts", "sources"] },
    { cmd: "mendcode", args: ["prompts", "build", "--mode", "focus", "--focus", "codex"] },
    { cmd: "mendcode", args: ["prompts", "build", "--mode", "focus", "--focus", "claude"] },
    { cmd: "mendcode", args: ["models", "set-default", "anthropic", "claude-sonnet-4-5", "--enable", "--dry-run"] },
    { cmd: "mendcode", args: ["run", "--dry-run", "--prompt-mode", "focus", "summarize this checkout"] },
    { cmd: "mendcode", args: ["chat", "--dry-run", "--session", "bench", "--prompt-mode", "full", "summarize this checkout"] },
    { cmd: "mendcode", args: ["toolchain", "status"] },
    { cmd: "mendcode", args: ["upstream", "status"] },
    { cmd: "mendcode", args: ["adapter", "status"] },
    { cmd: "mendcode", args: ["providers", "status"] },
    { cmd: "mendcode", args: ["providers", "auth"] },
    { cmd: "mendcode", args: ["auth", "status", "openai"] },
    { cmd: "mendcode", args: ["auth", "login-plan", "openai", "--method", "browser"] },
    { cmd: "mendcode", args: ["auth", "login", "openai", "--method", "browser"] },
    { cmd: "mendcode", args: ["check"] },
    { cmd: "mendcode", args: ["opencode", "--", "upgrade", "--help"], expectFailure: true },
    { cmd: "mendcode", args: ["opencode", "--", "providers", "--help"], expectFailure: true },
    { cmd: "mendcode", args: ["opencode", "--", "--help"], expectFailure: true },
  ]
}

export async function runBenchmark(root = mendPaths().root) {
  const outDir = path.join(root, ".agents", "specs", "mendcode-opencode-phase0-spike", "evidence", "benchmark-output")
  await mkdir(outDir, { recursive: true })
  const out = path.join(outDir, `phase1-wrapper-${new Date().toISOString().replaceAll(":", "-")}.txt`)
  const commands = benchCommands()
  let exitCode = 0
  await writeFile(out, `# MendCode benchmark ${new Date().toISOString()}\n`)
  for (const { cmd, args, expectFailure = false } of commands) {
    await appendFile(out, `\n$ ${cmd} ${args.join(" ")}\n`)
    const start = performance.now()
    const result = spawnSync(cmd, args, { cwd: root, encoding: "utf8" })
    const elapsed = ((performance.now() - start) / 1000).toFixed(2)
    await appendFile(out, result.stdout || "")
    await appendFile(out, result.stderr || "")
    await appendFile(out, `exit=${result.status} elapsed=${elapsed}s${expectFailure ? " expectedFailure=true" : ""}\n`)
    if (!expectFailure && result.status !== 0) exitCode = result.status || 1
    if (expectFailure && result.status === 0) exitCode = 1
  }
  return { output: path.relative(root, out), exitCode, commandCount: commands.length }
}
