import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { cleanEnv } from "./env"
import type { DiffStats, Task } from "./types"

export const TEMP_PREFIX = "mcev-"

export type Workspace = { root: string; cwd: string; baseSha: string }

/** Removes a directory this kit created: it must live in the OS temp directory and carry the kit's prefix. */
export function removeKitTree(dir: string): void {
  const resolved = path.resolve(dir)
  const temp = realpathSync(tmpdir())
  const inside = resolved.startsWith(`${temp}${path.sep}`) || resolved.startsWith(`${path.resolve(tmpdir())}${path.sep}`)
  const owned = path.basename(resolved).startsWith(TEMP_PREFIX) || path.basename(path.dirname(resolved)).startsWith(TEMP_PREFIX)
  if (!inside || !owned) throw new Error(`[WORKSPACE]: refusing to remove ${resolved}: not a kit temp directory`)
  rmSync(resolved, { recursive: true, force: true })
}

export function makeTempDir(label: string): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), `${TEMP_PREFIX}${label}-`)))
}

const GIT_ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" }

/** Runs git with the operator's configuration, hooks and signing switched off. */
export async function git(cwd: string, args: string[]): Promise<{ exitCode: number | null; output: string }> {
  const child = Bun.spawn(["git", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=eval", "-c", "user.email=eval@example.invalid", ...args], {
    cwd,
    env: cleanEnv({ HOME: cwd, ...GIT_ENV }),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [output, , exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  return { exitCode, output }
}

/** A fresh directory holding a copy of the task's `repo/`, committed to git so the agent's changes can be measured. */
export async function createWorkspace(task: Task): Promise<Workspace> {
  const root = makeTempDir("w")
  const cwd = path.join(root, "work")
  cpSync(task.repoDir, cwd, { recursive: true })
  for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "base"]]) {
    const result = await git(cwd, args)
    if (result.exitCode !== 0) throw new Error(`[WORKSPACE]: git ${args[0]} failed in ${cwd}`)
  }
  const head = await git(cwd, ["rev-parse", "HEAD"])
  return { root, cwd, baseSha: head.output.trim() }
}

/** Summarises everything the run changed relative to the starting commit, committed or not, and saves the patch. */
export async function collectDiff(workspace: Workspace, patchPath: string): Promise<DiffStats> {
  await git(workspace.cwd, ["add", "-A"])
  const numstat = await git(workspace.cwd, ["diff", "--cached", "--numstat", workspace.baseSha])
  let filesChanged = 0
  let insertions = 0
  let deletions = 0
  for (const line of numstat.output.split("\n")) {
    const [added, removed] = line.split("\t")
    if (added === undefined || removed === undefined) continue
    filesChanged++
    insertions += added === "-" ? 0 : Number(added)
    deletions += removed === "-" ? 0 : Number(removed)
  }
  const patch = await git(workspace.cwd, ["diff", "--cached", "--binary", workspace.baseSha])
  mkdirSync(path.dirname(patchPath), { recursive: true })
  writeFileSync(patchPath, patch.output.length > 2_000_000 ? `${patch.output.slice(0, 2_000_000)}\n[truncated]\n` : patch.output)
  return { filesChanged, insertions, deletions }
}
