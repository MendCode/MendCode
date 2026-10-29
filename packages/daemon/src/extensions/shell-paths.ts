import { statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"

/** The most paths one call is asked about as reads, so a long command line costs a bounded number of hook runs. */
export const MAX_DERIVED_PATHS = 16
const MAX_WORD_CHARS = 4096
const OPERATORS = new Set([";", "&", "|", "<", ">", "(", ")", "\n", "\r", "`"])
/** Tools whose arguments name a place they read without being `read` itself. */
const PATH_TOOLS: Record<string, readonly string[]> = { grep: ["path"], glob: ["path", "pattern"], ls: ["path"] }

/**
 * Words of a command line as `sh` would split them, leniently: quotes group, operators (`;`, `&&`, `|`, redirections,
 * `$(…)`) end a word and start a new command. Nothing is expanded or run. Each command's words come as one array.
 */
export function shellCommands(command: string): string[][] {
  const commands: string[][] = [[]]
  let word = ""
  let started = false
  let quote: "" | "'" | '"' = ""
  const end = () => {
    if (started) commands.at(-1)!.push(word.slice(0, MAX_WORD_CHARS))
    word = ""
    started = false
  }
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!
    if (quote) {
      if (char === quote) quote = ""
      else if (char === "\\" && quote === '"' && index + 1 < command.length) word += command[++index]
      else word += char
      continue
    }
    if (char === "'" || char === '"') { quote = char; started = true; continue }
    if (char === "\\" && index + 1 < command.length) { word += command[++index]; started = true; continue }
    if (char === " " || char === "\t") { end(); continue }
    if (OPERATORS.has(char) || char === "$" && command[index + 1] === "(") {
      end()
      if (char === "$") index++
      // A redirection's target is a word of the same command (`cat < a`); every other operator starts a new one.
      if (char !== "<" && char !== ">" && commands.at(-1)!.length) commands.push([])
      continue
    }
    word += char
    started = true
  }
  end()
  return commands.filter((words) => words.length)
}

const exists = (file: string) => statSync(file, { throwIfNoEntry: false }) !== undefined

/**
 * The paths a shell command line names, as the command would see them (relative words follow a `cd` earlier on the line):
 * words with a slash, and plain words that name something in the directory. Flags are skipped, but the value of
 * `--flag=value` and of `NAME=value` counts. URLs never do.
 */
export function shellPaths(command: string, cwd: string): string[] {
  const found: string[] = []
  let base = ""
  const add = (value: string, always = false) => {
    if (!value || value.includes("://") || found.length >= MAX_DERIVED_PATHS) return
    const named = base && !path.isAbsolute(value) && !value.startsWith("~") ? path.join(base, value) : value
    if (always || named.includes("/") || exists(path.resolve(cwd, named))) if (!found.includes(named)) found.push(named)
  }
  for (const words of shellCommands(command)) {
    const [program, ...rest] = words
    if (program === "cd") {
      const target = rest.find((word) => !word.startsWith("-"))
      if (target) { add(target, true); base = path.isAbsolute(target) ? target : path.join(base, target) }
      continue
    }
    // The program is a path only when it is spelled as one (`./run.sh`); `cat` is never a file of the project.
    for (const word of program?.includes("/") ? words : rest) {
      const value = word.startsWith("-") ? (word.includes("=") ? word.slice(word.indexOf("=") + 1) : "") : /^[A-Za-z_][A-Za-z0-9_]*=/.test(word) ? word.slice(word.indexOf("=") + 1) : word
      add(value)
    }
  }
  return found
}

/**
 * What a call reads besides a `read` of its own: the paths a shell command names, and the path arguments of grep, glob and
 * ls. A rule written for reads is asked about each one (`tool: "read"`, `via` the real tool), so "never read private/" also
 * stops `cat private/a` and `grep -r x private`.
 */
export function derivedReads(tool: string, args: Record<string, unknown>, cwd: string): string[] {
  return withDirectorySlash(namedPaths(tool, args, cwd), cwd)
}

function namedPaths(tool: string, args: Record<string, unknown>, cwd: string): string[] {
  if ((tool === "shell" || tool === "shell_session") && typeof args.command === "string") return shellPaths(args.command, cwd)
  // `read` of several files sends `paths: [{ path }]`; a rule that tests `e.args.path` is asked about each of them.
  if (tool === "read") return typeof args.path === "string" || !Array.isArray(args.paths) ? [] : [...new Set(args.paths.map((entry) => (entry as { path?: unknown } | null)?.path).filter((value): value is string => typeof value === "string" && value.length > 0 && value.length <= MAX_WORD_CHARS))].slice(0, MAX_DERIVED_PATHS)
  const fields = PATH_TOOLS[tool]
  if (!fields) return []
  return [...new Set(fields.map((field) => args[field]).filter((value): value is string => typeof value === "string" && value.length > 0 && value.length <= MAX_WORD_CHARS))].slice(0, MAX_DERIVED_PATHS)
}

/**
 * A folder is also asked as `folder/`: `grep -r x private` reads what is inside `private/`, and a rule is usually written for that
 * spelling (`/private\//`). Both spellings are asked, so a rule that tests the bare name holds too.
 */
function withDirectorySlash(paths: string[], cwd: string): string[] {
  const out: string[] = []
  for (const named of paths) {
    if (out.length >= MAX_DERIVED_PATHS) break
    if (!out.includes(named)) out.push(named)
    if (named.endsWith("/") || out.length >= MAX_DERIVED_PATHS) continue
    const resolved = path.resolve(cwd, named.startsWith("~/") ? path.join(homedir(), named.slice(2)) : named)
    if (statSync(resolved, { throwIfNoEntry: false })?.isDirectory() && !out.includes(`${named}/`)) out.push(`${named}/`)
  }
  return out
}
