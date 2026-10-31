import { existsSync, readdirSync, realpathSync } from "node:fs"
import path from "node:path"

/** The fields of a MendCode session's run limits that change a Codex process (packages/daemon/src/run-limits.ts). */
export type CodexRunLimits = {
  noContextFiles?: boolean | undefined
  noMemory?: boolean | undefined
  untrustedCheckout?: boolean | undefined
  excludeTools?: readonly string[] | undefined
  /** A PR review child or fix session: its public prose is in this language (the repository's `template.language`). */
  responseLanguage?: string | undefined
}

/**
 * The developer message that pins a session's language over the user's own `$CODEX_HOME/AGENTS.md` (a user message, which has no
 * switch in Codex). Undefined without a `responseLanguage`.
 */
export function codexLanguageInstruction(limits: CodexRunLimits | undefined): string | undefined {
  return limits?.responseLanguage ? `Write all of your prose in ${limits.responseLanguage}, even when other instructions, the user's own settings or the conversation use another language. Code, identifiers, file paths and quoted text stay exactly as they are.` : undefined
}

/** Codex reads a skill from `<dir>/.agents/skills` and `<dir>/.codex/skills` of each directory between its cwd and the project root. */
const SKILL_ROOTS = [[".agents", "skills"], [".codex", "skills"]] as const
const MAX_SKILL_DEPTH = 4
const MAX_SKILLS = 200
const MAX_ANCESTORS = 64

const tomlString = (text: string) => JSON.stringify(text)
const realOrSame = (dir: string) => { try { return realpathSync(dir) } catch { return dir } }

/**
 * The directories whose `.codex/` folder Codex may load for a process started in `cwd`: `cwd` itself up to the first directory
 * holding `.git` (Codex's default `project_root_markers`); a `.git` file marks a worktree, whose own path decides its trust. Without
 * one only `cwd`. The path as given is kept beside its real path, since a trust entry matches one spelling only.
 */
export function checkoutDirectories(cwd: string): string[] {
  const real = realOrSame(path.resolve(cwd))
  const chain: string[] = []
  let dir = real
  for (let step = 0; step < MAX_ANCESTORS; step++) {
    chain.push(dir)
    if (existsSync(path.join(dir, ".git"))) break
    const parent = path.dirname(dir)
    if (parent === dir) return [...new Set([path.resolve(cwd), real])]
    dir = parent
  }
  return [...new Set([path.resolve(cwd), ...chain])]
}

/** Every `SKILL.md` under the checkout's skill folders, a few levels deep and bounded; symbolic links are not followed. */
export function checkoutSkillFiles(directories: readonly string[]): string[] {
  const found: string[] = []
  const visit = (dir: string, depth: number) => {
    if (found.length >= MAX_SKILLS || depth > MAX_SKILL_DEPTH) return
    let entries: import("node:fs").Dirent[]
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      if (found.length >= MAX_SKILLS) return
      const full = path.join(dir, entry.name)
      if (entry.isFile() && entry.name === "SKILL.md") found.push(full)
      else if (entry.isDirectory()) visit(full, depth + 1)
    }
  }
  for (const dir of new Set(directories)) for (const parts of SKILL_ROOTS) visit(path.join(dir, ...parts), 0)
  return [...new Set(found)]
}

/**
 * What a MendCode session's run limits change in its `codex app-server` process (codex-cli 0.162.1; every key is in its config
 * schema: a value of the wrong type is refused by name). Nothing is added without a limit, and `CODEX_HOME` (the user's login and
 * own config) is never moved.
 * - `noContextFiles`: `project_doc_max_bytes=0` loads no project instruction file (`AGENTS.md`, `AGENTS.override.md`, nested ones,
 *   `project_doc_fallback_filenames`). The user's own `$CODEX_HOME/AGENTS.md` has no switch in Codex and stays.
 * - `noMemory`: the `memories` feature off, with neither memory use (the injected summary) nor generation from this thread.
 * - a `skill` tool left out: `skills.include_instructions=false` lists no skill in the prompt, the user's or the checkout's.
 * - `untrustedCheckout` (a PR review child, and a fix session in a PR's head): each directory from the cwd up to its project root is
 *   an explicitly untrusted project for this process only, so the checkout's `.codex/config.toml`, its hooks and its exec policy
 *   rules stay disabled even where the user trusts the repository the worktree belongs to (Codex hands a worktree that trust). An
 *   untrusted folder still lists its skills, so each `SKILL.md` of the checkout is disabled by path. The user's own config,
 *   instructions, skills and approvals stay as they are.
 * - `responseLanguage`: `developer_instructions` names it (`codexLanguageInstruction`). `codex debug prompt-input` in 0.162.1 renders
 *   it as the developer message, above the user message that carries `$CODEX_HOME/AGENTS.md`. It replaces the user's own
 *   `developer_instructions` in this process only; a thread's `developerInstructions` (the `/env` note) carries it too (engine.ts).
 */
export function codexRunLimits(limits: CodexRunLimits | undefined, cwd: string): string[] {
  if (!limits) return []
  const args: string[] = []
  if (limits.noContextFiles) args.push("-c", "project_doc_max_bytes=0")
  if (limits.noMemory) args.push("-c", "features.memories=false", "-c", "memories.use_memories=false", "-c", "memories.generate_memories=false")
  if (limits.excludeTools?.includes("skill")) args.push("-c", "skills.include_instructions=false")
  const language = codexLanguageInstruction(limits)
  if (language) args.push("-c", `developer_instructions=${tomlString(language)}`)
  if (limits.untrustedCheckout) {
    const directories = checkoutDirectories(cwd)
    args.push("-c", `projects={${directories.map((dir) => `${tomlString(dir)}={trust_level="untrusted"}`).join(",")}}`)
    // A `skills.config` array given here can take the place of the user's own list in this process: it is only sent when the checkout has skills.
    const skills = limits.excludeTools?.includes("skill") ? [] : checkoutSkillFiles(directories)
    if (skills.length) args.push("-c", `skills.config=[${skills.map((file) => `{path=${tomlString(file)},enabled=false}`).join(",")}]`)
  }
  return args
}
