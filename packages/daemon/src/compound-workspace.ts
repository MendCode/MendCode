import { createHash } from "node:crypto"
import { lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs"
import path from "node:path"
import { redactSecrets } from "@mendcode/protocol"
import { parseCheck } from "@mendcode/loops"
import { runLoopCheck } from "./loop-checks"

export type CompoundSnapshot = { base: string; fingerprint: string; diff: string; files: Array<{ path: string; content: string }> }
export const compoundCheckArgs = (command: string): string[] => {
  const parsed = parseCheck(command)
  if ("error" in parsed) throw new Error(parsed.error)
  const args = parsed.argv
  const [program, sub, next] = args
  const allowed = program === "git" && sub === "diff" && next === "--check" && args.slice(3).every((arg) => ["--", "--cached", "--staged"].includes(arg) || !arg.startsWith("-")) ||
    program === "bun" && (["test", "typecheck"].includes(sub ?? "") || sub === "run" && ["test", "typecheck", "lint", "check", "build"].includes(next ?? "")) ||
    program === "pnpm" && (sub === "run" ? ["test", "typecheck", "lint", "check", "build"].includes(next ?? "") : ["test", "typecheck", "lint", "check", "build"].includes(sub ?? "")) ||
    program === "deno" && ["test", "lint", "check"].includes(sub ?? "") ||
    program === "pytest" || ["python", "python3"].includes(program ?? "") && sub === "-m" && next === "pytest" ||
    program === "go" && sub === "test" || program === "cargo" && ["test", "check", "clippy"].includes(sub ?? "") ||
    program === "make" && ["test", "check", "lint", "build"].includes(sub ?? "")
  if (!allowed || args.some((arg) => path.isAbsolute(arg) || arg.split(/[\\/]/).includes(".."))) throw new Error("Compound checks require an allowed local validation command")
  return args
}

async function git(cwd: string, args: string[], signal: AbortSignal) {
  const result = await runLoopCheck({ argv: ["git", "--no-optional-locks", ...args], cwd, signal, timeoutSeconds: 10 })
  if (result.exitCode !== 0 || signal.aborted || result.output.length >= 64_000) throw new Error("Compound git snapshot unavailable or exceeds 64 KB")
  return result.output.replace(/\n$/, "")
}

export async function createCompoundWorkspace(root: string, directory: string, runId: string, signal: AbortSignal) {
  const base = await git(directory, ["rev-parse", "HEAD"], signal)
  if (!/^[a-f0-9]{40,64}$/.test(base)) throw new Error("Compound requires a committed git checkout")
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const target = path.join(root, runId)
  await git(directory, ["worktree", "add", "--detach", target, base], signal)
  return { path: target, base }
}

/** Host-owned bytes; no symlinks, binary files, unbounded trees or mutable workspace handle reach the critic. */
export async function compoundSnapshot(directory: string, signal: AbortSignal, expectedBase?: string): Promise<CompoundSnapshot> {
  const base = await git(directory, ["rev-parse", "HEAD"], signal)
  if (expectedBase && base !== expectedBase) throw new Error("Compound candidate changed its base commit")
  const diff = await git(directory, ["diff", "HEAD", "--binary"], signal)
  const names = [...new Set((await git(directory, ["diff", "HEAD", "--name-only", "-z"], signal)).split("\0").concat((await git(directory, ["ls-files", "--others", "--exclude-standard", "-z"], signal)).split("\0")).filter(Boolean))].sort()
  if (names.length > 32) throw new Error("Compound snapshot exceeds 32 files")
  const hash = createHash("sha256").update(base).update(diff)
  const files: CompoundSnapshot["files"] = []
  let size = Buffer.byteLength(diff)
  const root = realpathSync(directory)
  for (const name of names) {
    const file = path.resolve(root, name)
    if (!file.startsWith(`${root}${path.sep}`)) throw new Error("Candidate path escapes workspace")
    const stat = lstatSync(file, { throwIfNoEntry: false })
    if (!stat) { hash.update(`\0${name}\0deleted`); files.push({ path: name, content: "[deleted]" }); continue }
    if (!stat.isFile() || stat.size > 32_000 || !realpathSync(file).startsWith(`${root}${path.sep}`)) throw new Error("Candidate contains a symlink, special file or oversized file")
    const bytes = readFileSync(file)
    if (bytes.includes(0) || (size += bytes.length) > 64_000) throw new Error("Candidate is binary or exceeds 64 KB")
    hash.update(`\0${name}\0`).update(bytes)
    files.push({ path: name, content: redactSecrets(bytes.toString("utf8")).text })
  }
  return { base, fingerprint: hash.digest("hex"), diff: redactSecrets(diff).text, files }
}
