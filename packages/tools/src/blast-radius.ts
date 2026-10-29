import { lstat, readdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { runManaged } from "./process"
import { boundPreview, displayPath, resolvePath } from "./util"

/**
 * Blast-radius preview of a risky shell command: what a closed set of destructive commands would change, computed
 * read-only before the user approves. It never runs the command: `rm` is measured with filesystem metadata, `git clean`,
 * `git reset --hard`, `git restore`/`git checkout -- <paths>` and `find ... -delete` are answered by a dry run or a diff
 * (argument arrays, no shell, no model). Anything else, and any line the preview cannot read with certainty (pipes,
 * `$(…)`, `~`, brace expansion, unknown flags), gives `undefined` and the approval shows the command alone.
 */

const GIT_TIMEOUT_MS = 8_000
const FIND_TIMEOUT_MS = 5_000
const WALK_ENTRIES = 5_000
const WALK_MS = 1_500
const GLOB_MATCHES = 200
const LISTED_PER_DIRECTORY = 25
const SAFE_REV = /^[A-Za-z0-9_][A-Za-z0-9_./@{}~^:+-]*$/
const FIND_WRITERS = new Set(["-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"])

type Token = { text: string; glob: boolean }

/** A command line split like `sh` would, or undefined when anything in it cannot be read without running it. */
export function tokenize(command: string): Token[] | undefined {
  const tokens: Token[] = []
  let text = ""
  let glob = false
  let quotedGlob = false
  let started = false
  const push = () => {
    if (!started) return true
    if (glob && quotedGlob) return false
    tokens.push({ text, glob })
    text = ""
    glob = false
    quotedGlob = false
    started = false
    return true
  }
  let quote: "" | "'" | '"' = ""
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!
    if (quote === "'") {
      if (char === "'") quote = ""
      else {
        text += char
        if ("*?[".includes(char)) quotedGlob = true
      }
      continue
    }
    if (quote === '"') {
      if (char === '"') quote = ""
      else if (char === "$" || char === "`") return undefined
      else if (char === "\\") {
        const next = command[++index]
        if (next === undefined) return undefined
        text += '$"\\`'.includes(next) ? next : `\\${next}`
      } else {
        text += char
        if ("*?[".includes(char)) quotedGlob = true
      }
      continue
    }
    if (char === " " || char === "\t") {
      if (!push()) return undefined
      continue
    }
    if (char === "'" || char === '"') {
      quote = char
      started = true
      continue
    }
    if (char === "\\") {
      const next = command[++index]
      if (next === undefined || next === "\n") return undefined
      text += next
      started = true
      if ("*?[".includes(next)) quotedGlob = true
      continue
    }
    if (";&|<>()$`{}\n\r".includes(char)) return undefined
    if (char === "#" && !started) return undefined
    if (char === "~" && !started) return undefined
    if ("*?[".includes(char)) glob = true
    text += char
    started = true
  }
  if (quote) return undefined
  if (!push()) return undefined
  return tokens
}

type PreviewInput = { command: string; cwd: string; signal: AbortSignal; environment?: Record<string, string | undefined> | undefined }

/** The preview text for `command` (header line first, one affected path per row), or undefined when it is outside the closed set. */
export async function blastRadiusPreview(input: PreviewInput): Promise<string | undefined> {
  const tokens = tokenize(input.command.trim())
  if (!tokens || tokens.length < 2) return undefined
  const [head, ...args] = tokens as [Token, ...Token[]]
  try {
    if (head.text === "rm") return await previewRm(args, input)
    if (head.text === "find") return await previewFind(args, input)
    if (head.text === "git") return await previewGit(args, input)
  } catch {
    return undefined
  }
  return undefined
}

const plural = (count: number, one: string, many = `${one}s`) => `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`
}

// ---------------------------------------------------------------------------------------------- rm

type RmTarget = { abs: string; shown: string }

async function expandGlob({ pattern, cwd }: { pattern: string; cwd: string }): Promise<string[]> {
  const segments = pattern.split("/")
  const firstGlob = segments.findIndex((segment) => /[*?[]/.test(segment))
  const baseSegments = segments.slice(0, Math.max(0, firstGlob))
  const base = resolve(cwd, baseSegments.join("/") || ".")
  const rest = segments.slice(Math.max(0, firstGlob)).join("/")
  const dot = rest.split("/").some((segment) => segment.startsWith("."))
  const found: string[] = []
  try {
    for await (const match of new Bun.Glob(rest).scan({ cwd: base, onlyFiles: false, dot, followSymlinks: false })) {
      found.push(join(base, match))
      if (found.length > GLOB_MATCHES) break
    }
  } catch {
    // A missing base directory matches nothing, like the shell's literal fallback.
  }
  return found.sort()
}

/** Counts what a recursive delete of `root` removes, bounded in entries and time; `listed` is the first files it would take. */
async function measure(root: string): Promise<{ files: number; dirs: number; bytes: number; capped: boolean; listed: string[] }> {
  const deadline = Date.now() + WALK_MS
  const stack = [root]
  let files = 0
  let dirs = 0
  let bytes = 0
  let visited = 0
  const listed: string[] = []
  while (stack.length > 0) {
    if (visited >= WALK_ENTRIES || Date.now() > deadline) return { files, dirs, bytes, capped: true, listed }
    const current = stack.pop()!
    const entries = await readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries.sort((a, b) => b.name.localeCompare(a.name))) {
      visited++
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        dirs++
        stack.push(path)
        continue
      }
      files++
      const info = await lstat(path).catch(() => undefined)
      if (info) bytes += info.size
      if (listed.length < LISTED_PER_DIRECTORY) listed.push(path)
    }
  }
  return { files, dirs, bytes, capped: false, listed }
}

async function previewRm(args: Token[], { cwd }: PreviewInput): Promise<string | undefined> {
  let recursive = false
  let force = false
  let dirs = false
  const operands: Token[] = []
  let operandsOnly = false
  for (const arg of args) {
    if (operandsOnly || !arg.text.startsWith("-") || arg.text === "-") {
      operands.push(arg)
      continue
    }
    if (arg.text === "--") operandsOnly = true
    else if (arg.text === "--recursive") recursive = true
    else if (arg.text === "--force") force = true
    else if (arg.text === "--dir") dirs = true
    else if (arg.text === "--verbose") continue
    else if (/^-[rRfvd]+$/.test(arg.text)) {
      if (/[rR]/.test(arg.text)) recursive = true
      if (arg.text.includes("f")) force = true
      if (arg.text.includes("d")) dirs = true
    } else return undefined
  }
  if (operands.length === 0 || operands.length > 40) return undefined

  const targets: RmTarget[] = []
  const notes: string[] = []
  let tooMany = false
  for (const operand of operands) {
    if (operand.glob) {
      const matches = await expandGlob({ pattern: operand.text, cwd })
      if (matches.length === 0) notes.push(`  no match: ${operand.text}`)
      for (const match of matches.slice(0, GLOB_MATCHES)) targets.push({ abs: match, shown: displayPath({ cwd, path: match }) })
      if (matches.length > GLOB_MATCHES) tooMany = true
      continue
    }
    const abs = resolvePath({ cwd, path: operand.text })
    targets.push({ abs, shown: displayPath({ cwd, path: abs }) })
  }

  const rows: string[] = []
  let files = 0
  let bytes = 0
  let paths = 0
  let capped = false
  for (const target of targets) {
    const info = await lstat(target.abs).catch(() => undefined)
    if (!info) {
      notes.push(`  missing: ${target.shown}${force ? " (ignored by -f)" : " (rm will fail)"}`)
      continue
    }
    if (info.isSymbolicLink()) {
      paths++
      files++
      rows.push(`- ${target.shown} · symlink (the link goes, not its target)`)
    } else if (info.isDirectory()) {
      if (!recursive && !dirs) {
        notes.push(`  ${target.shown}/ is a directory: rm needs -r (nothing removed)`)
        continue
      }
      paths++
      if (!recursive) {
        const empty = (await readdir(target.abs).catch(() => ["?"])).length === 0
        if (!empty) notes.push(`  ${target.shown}/ is not empty: rm -d refuses it`)
        else rows.push(`- ${target.shown}/ · empty directory`)
        continue
      }
      const sizes = await measure(target.abs)
      files += sizes.files
      bytes += sizes.bytes
      capped ||= sizes.capped
      rows.push(`- ${target.shown}/ · ${plural(sizes.files, "file")}${sizes.dirs ? ` · ${plural(sizes.dirs, "subdirectory", "subdirectories")}` : ""} · ${formatBytes(sizes.bytes)}${sizes.capped ? " · count capped" : ""}`)
      for (const file of sizes.listed) rows.push(`-   ${displayPath({ cwd, path: file })}`)
      if (sizes.files > sizes.listed.length) rows.push(`… ${(sizes.files - sizes.listed.length).toLocaleString("en-US")} more files${sizes.capped ? "+" : ""}`)
    } else {
      paths++
      files++
      bytes += info.size
      rows.push(`- ${target.shown} · ${formatBytes(info.size)}`)
    }
  }
  if (tooMany) notes.push(`  more than ${GLOB_MATCHES} matches: list cut`)
  const header = `*** rm would delete ${plural(paths, "path")} · ${plural(files, "file")}${capped ? "+" : ""} · ${formatBytes(bytes)}`
  return boundPreview([header, ...rows, ...notes].join("\n"))
}

// ---------------------------------------------------------------------------------------------- find

async function previewFind(args: Token[], { cwd, signal, environment }: PreviewInput): Promise<string | undefined> {
  if (process.platform === "win32") return undefined
  if (!args.some((arg) => arg.text === "-delete" && !arg.glob)) return undefined
  if (args.some((arg) => arg.glob || FIND_WRITERS.has(arg.text))) return undefined
  // `-delete` becomes `-print` in place, so every test around it still gates exactly the same entries.
  const argv = ["/usr/bin/find", ...args.map((arg) => (arg.text === "-delete" ? "-print" : arg.text))]
  const result = await runManaged({ argv, cwd, env: gitEnvironment(environment), timeoutMs: FIND_TIMEOUT_MS, signal })
  if (result.spawnError || result.cancelled) return undefined
  const found = result.output.split("\n").filter((line) => line && !/^find: /.test(line))
  if (found.length === 0 && result.exitCode !== 0) return undefined
  const rows = found.map((line) => `- ${displayPath({ cwd, path: resolve(cwd, line) })}`)
  const header = `*** find -delete would remove ${plural(found.length, "path")} (dry run)`
  return boundPreview([header, ...rows, ...(result.timedOut ? [`… dry run stopped after ${FIND_TIMEOUT_MS / 1000}s: the list is partial`] : [])].join("\n"))
}

// ---------------------------------------------------------------------------------------------- git

function gitEnvironment(environment?: Record<string, string | undefined>): Record<string, string | undefined> {
  // A preview runs before approval: neither PATH nor dynamic loader injection may execute project code.
  const env = Object.fromEntries(Object.entries(environment ?? process.env).filter(([key]) => !/^(?:LD_|DYLD_)/.test(key)))
  return { ...env, PATH: "/usr/bin:/bin", GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" }
}

async function git(args: string[], { cwd, signal, environment }: PreviewInput): Promise<string | undefined> {
  if (process.platform === "win32") return undefined
  const argv = ["/usr/bin/git", "-c", "core.fsmonitor=false", "-c", "core.quotepath=false", "--no-pager", ...args]
  const result = await runManaged({ argv, cwd, env: gitEnvironment(environment), timeoutMs: GIT_TIMEOUT_MS, signal })
  return result.spawnError || result.cancelled || result.timedOut || result.exitCode !== 0 ? undefined : result.output
}

type Numstat = { path: string; added: number; removed: number; binary: boolean }

function parseNumstat(output: string): Numstat[] {
  const rows: Numstat[] = []
  for (const line of output.split("\n")) {
    const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line)
    if (match) rows.push({ path: match[3]!, added: match[1] === "-" ? 0 : Number(match[1]), removed: match[2] === "-" ? 0 : Number(match[2]), binary: match[1] === "-" })
  }
  return rows
}

function numstatRows(rows: Numstat[]): string[] {
  return rows.map((row) => (row.binary ? `${row.path} · binary` : `${row.path} · +${row.added} -${row.removed}`))
}

function plainPaths(args: Token[]): string[] | undefined {
  const paths: string[] = []
  for (const arg of args) {
    if (arg.glob) return undefined
    paths.push(arg.text)
  }
  return paths
}

async function previewGit(args: Token[], input: PreviewInput): Promise<string | undefined> {
  const [sub, ...rest] = args as [Token, ...Token[]]
  if (sub.text === "clean") return previewClean(rest, input)
  if (sub.text === "reset") return previewReset(rest, input)
  if (sub.text === "restore") return previewRestore({ args: rest, input, verb: "restore" })
  if (sub.text === "checkout") return previewRestore({ args: rest, input, verb: "checkout" })
  return undefined
}

async function previewClean(args: Token[], input: PreviewInput): Promise<string | undefined> {
  const letters = new Set<string>()
  const excludes: string[] = []
  const paths: string[] = []
  let operandsOnly = false
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (operandsOnly) {
      if (arg.glob) return undefined
      paths.push(arg.text)
    } else if (arg.text === "--") operandsOnly = true
    else if (arg.text === "-e" || arg.text === "--exclude") {
      const next = args[++index]
      if (!next || next.glob) return undefined
      excludes.push("-e", next.text)
    } else if (arg.text.startsWith("--exclude=")) {
      if (arg.glob) return undefined
      excludes.push(arg.text)
    } else if (["--force", "--dry-run", "--quiet"].includes(arg.text)) {
      continue
    } else if (/^-[dfxXnq]+$/.test(arg.text)) {
      for (const letter of arg.text.slice(1)) if ("dxX".includes(letter)) letters.add(letter)
    } else if (arg.text.startsWith("-")) {
      return undefined
    } else {
      if (arg.glob) return undefined
      paths.push(arg.text)
    }
  }
  const output = await git(["clean", "-n", ...[...letters].map((letter) => `-${letter}`), ...excludes, ...(paths.length ? ["--", ...paths] : [])], input)
  if (output === undefined) return undefined
  const removed: string[] = []
  const skipped: string[] = []
  for (const line of output.split("\n")) {
    const remove = /^Would remove (.+)$/.exec(line)
    const skip = /^Would skip repository (.+)$/.exec(line)
    if (remove) removed.push(remove[1]!)
    else if (skip) skipped.push(skip[1]!)
  }
  const header = removed.length === 0 ? "*** git clean would remove nothing (dry run)" : `*** git clean would remove ${plural(removed.length, "path")} (dry run)`
  return boundPreview([header, ...removed.map((path) => `- ${path}`), ...skipped.map((path) => `  skips nested repository ${path}`)].join("\n"))
}

async function previewReset(args: Token[], input: PreviewInput): Promise<string | undefined> {
  let hard = false
  let rev: string | undefined
  for (const arg of args) {
    if (arg.text === "--hard") hard = true
    else if (arg.text === "-q" || arg.text === "--quiet") continue
    else if (arg.text.startsWith("-") || arg.glob || rev !== undefined || !SAFE_REV.test(arg.text)) return undefined
    else rev = arg.text
  }
  if (!hard) return undefined
  const [diff, ahead] = await Promise.all([
    git(["diff", "--numstat", "--no-ext-diff", "--no-textconv", "--no-color", rev ?? "HEAD", "--"], input),
    rev ? git(["rev-list", "--count", `${rev}..HEAD`], input) : Promise.resolve("0"),
  ])
  if (diff === undefined) return undefined
  const rows = parseNumstat(diff)
  const dropped = Number((ahead ?? "0").trim()) || 0
  const added = rows.reduce((sum, row) => sum + row.added, 0)
  const removed = rows.reduce((sum, row) => sum + row.removed, 0)
  const header = rows.length === 0 ? "*** git reset --hard: no tracked changes to discard" : `*** git reset --hard rewrites ${plural(rows.length, "tracked file")} (+${added} -${removed} against ${rev ?? "HEAD"})`
  return boundPreview([header, ...numstatRows(rows), ...(dropped > 0 ? [`  the branch loses ${plural(dropped, "commit")} (still in the reflog)`] : []), "  untracked files stay"].join("\n"))
}

async function previewRestore({ args, input, verb }: { args: Token[]; input: PreviewInput; verb: "restore" | "checkout" }): Promise<string | undefined> {
  let source: string | undefined
  const paths: Token[] = []
  let operandsOnly = false
  let sawDashes = false
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (operandsOnly) paths.push(arg)
    else if (arg.text === "--") {
      operandsOnly = true
      sawDashes = true
    } else if (verb === "restore" && (arg.text === "--worktree" || arg.text === "-W")) continue
    else if (verb === "restore" && (arg.text === "--source" || arg.text === "-s")) {
      const next = args[++index]
      if (!next || next.glob || !SAFE_REV.test(next.text)) return undefined
      source = next.text
    } else if (verb === "restore" && arg.text.startsWith("--source=")) {
      const value = arg.text.slice("--source=".length)
      if (arg.glob || !SAFE_REV.test(value)) return undefined
      source = value
    } else if (arg.text.startsWith("-")) return undefined
    else if (verb === "checkout" && source === undefined && paths.length === 0 && !arg.glob && SAFE_REV.test(arg.text)) source = arg.text
    else paths.push(arg)
  }
  if (verb === "checkout" && !sawDashes) return undefined
  const operands = plainPaths(paths)
  if (!operands || operands.length === 0) return undefined
  const diff = await git(["diff", "--numstat", "--no-ext-diff", "--no-textconv", "--no-color", ...(source ? [source] : []), "--", ...operands], input)
  if (diff === undefined) return undefined
  const rows = parseNumstat(diff)
  const header = rows.length === 0 ? `*** git ${verb}: no tracked changes in these paths` : `*** git ${verb} discards changes in ${plural(rows.length, "file")}`
  return boundPreview([header, ...numstatRows(rows)].join("\n"))
}
