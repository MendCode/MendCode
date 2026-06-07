import { spawnSync } from "child_process"
import { mkdir, writeFile, appendFile } from "fs/promises"
import path from "path"
import { performance } from "perf_hooks"
import { mendPaths } from "../config/paths"

type BenchCommand = { cmd: string; args: string[]; expectFailure?: boolean }

function benchCommands(): BenchCommand[] {
  return [
    { cmd: "./bin/mend", args: ["status"] },
    { cmd: "./bin/mend", args: ["doctor"] },
    { cmd: "./bin/mend", args: ["context", "refresh"] },
    { cmd: "./bin/mend", args: ["budget", "status"] },
    { cmd: "./bin/mend", args: ["budget", "doctor"] },
    { cmd: "./bin/mend", args: ["models", "status"] },
    { cmd: "./bin/mend", args: ["models", "plan"] },
    { cmd: "./bin/mend", args: ["tui", "status"] },
    { cmd: "./bin/mend", args: ["tui", "preview-plan"] },
    { cmd: "./bin/mend", args: ["tui", "runtime-plan"] },
    { cmd: "./bin/mend", args: ["tui", "probe"] },
    { cmd: "./bin/mend", args: ["focus", "status"] },
    { cmd: "./bin/mend", args: ["worktree", "status"] },
    { cmd: "./bin/mend", args: ["worktree", "doctor"] },
    { cmd: "./bin/mend", args: ["tsm", "status"] },
    { cmd: "./bin/mend", args: ["tsm", "plan"] },
    { cmd: "./bin/mend", args: ["tsm", "doctor"] },
    { cmd: "./bin/mend", args: ["mflow", "status"] },
    { cmd: "./bin/mend", args: ["mflow", "plan"] },
    { cmd: "./bin/mend", args: ["mflow", "doctor"] },
    { cmd: "./bin/mend", args: ["export", "plan"] },
    { cmd: "./bin/mend", args: ["setup", "status"] },
    { cmd: "./bin/mend", args: ["setup", "plan"] },
    { cmd: "./bin/mend", args: ["setup", "doctor"] },
    { cmd: "./bin/mend", args: ["ai", "status"] },
    { cmd: "./bin/mend", args: ["ai", "env", "status"] },
    { cmd: "./bin/mend", args: ["runtime", "status"] },
    { cmd: "./bin/mend", args: ["runtime", "plan"] },
    { cmd: "./bin/mend", args: ["prompts", "sources"] },
    { cmd: "./bin/mend", args: ["prompts", "build", "--mode", "focus", "--focus", "codex"] },
    { cmd: "./bin/mend", args: ["prompts", "build", "--mode", "focus", "--focus", "claude"] },
    { cmd: "./bin/mend", args: ["models", "set-default", "anthropic", "claude-sonnet-4-5", "--enable", "--dry-run"] },
    { cmd: "./bin/mend", args: ["run", "--dry-run", "--prompt-mode", "focus", "summarize this checkout"] },
    { cmd: "./bin/mend", args: ["chat", "--dry-run", "--session", "bench", "--prompt-mode", "full", "summarize this checkout"] },
    { cmd: "./bin/mend", args: ["toolchain", "status"] },
    { cmd: "./bin/mend", args: ["upstream", "status"] },
    { cmd: "./bin/mend", args: ["adapter", "status"] },
    { cmd: "./bin/mend", args: ["providers", "status"] },
    { cmd: "./bin/mend", args: ["providers", "auth"] },
    { cmd: "./bin/mend", args: ["auth", "status", "openai"] },
    { cmd: "./bin/mend", args: ["auth", "login-plan", "openai", "--method", "browser"] },
    { cmd: "./bin/mend", args: ["auth", "login", "openai", "--method", "browser"] },
    { cmd: "./bin/mend", args: ["check"] },
    { cmd: "./bin/mend", args: ["opencode", "--", "upgrade", "--help"], expectFailure: true },
    { cmd: "./bin/mend", args: ["opencode", "--", "providers", "--help"], expectFailure: true },
    { cmd: "./bin/mend", args: ["opencode", "--", "--help"], expectFailure: true },
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
