/**
 * Pure helpers that find the shell source hidden inside a command: `bash -lc '…'`, `eval '…'`, `trap '…' EXIT`,
 * `$(…)`, backticks and `<(…)`. Smart mode (and the deny rules) judge that inner source like any other command line, so
 * wrapping `rm -rf build` in `bash -c` or `$( )` no longer hides it. Same idea as Codex's `parse_shell_lc_literal_commands`.
 */

/** Nesting deeper than this is judged high risk: nobody writes it by hand, and it is what a bypass looks like. */
export const MAX_SHELL_DEPTH = 8

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "fish"])
const SAFE_LONG_SHELL_FLAGS = new Set(["--login", "--noprofile", "--norc", "--posix", "--restricted", "--noediting"])

/** The program name of a command word without its directory. */
export const programName = (word: string): string => word.slice(word.lastIndexOf("/") + 1)

/**
 * The shell source a command runs, when the command is a shell with `-c` (`bash -lc 'ls && pwd'`, `sh -c …`), `eval …`
 * or `trap 'action' SIGNAL`; undefined for anything else, including a shell that runs a file or reads its script from
 * an option that cannot be read here (`--rcfile`).
 */
export function wrappedScript(words: readonly string[]): string | undefined {
  const name = words[0] === undefined ? undefined : programName(words[0])
  if (name === undefined) return undefined
  if (name === "eval") return words.length > 1 ? words.slice(1).join(" ") : undefined
  if (name === "trap") {
    let at = 1
    if (words[at] === "--") at++
    const action = words[at]
    return action !== undefined && action !== "" && action !== "-" && !action.startsWith("-") ? action : undefined
  }
  if (!SHELLS.has(name)) return undefined
  for (let at = 1; at < words.length; at++) {
    const word = words[at]!
    if (/^-[A-Za-z]+$/.test(word)) {
      if (word.includes("c")) return words[at + 1]
      if (/[oO]$/.test(word)) at++
    } else if (/^\+[A-Za-z]+$/.test(word) || SAFE_LONG_SHELL_FLAGS.has(word)) continue
    else return undefined
  }
  return undefined
}

/** The index just after the `)` that closes the `(` before `from`, honoring quotes; the end of the text when it never closes. */
function closeParen(text: string, from: number): number {
  let depth = 1
  let quote: "'" | '"' | undefined
  for (let i = from; i < text.length; i++) {
    const char = text[i]!
    if (char === "\\" && quote !== "'") i++
    else if (quote) {
      if (char === quote) quote = undefined
    } else if (char === "'" || char === '"') quote = char
    else if (char === "(") depth++
    else if (char === ")" && --depth === 0) return i + 1
  }
  return text.length
}

/**
 * The command lines run by `$(…)`, backticks, `<(…)` and `>(…)` in a command line (outermost only; each result is
 * scanned again by whoever judges it). Single quotes hide everything; double quotes do not. `$((…))` is arithmetic, not a
 * command, but anything substituted inside it is still found.
 */
export function commandSubstitutions(command: string): string[] {
  const found: string[] = []
  let quote: "'" | '"' | undefined
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!
    if (char === "\\" && quote !== "'") {
      i++
      continue
    }
    if (quote === "'") {
      if (char === "'") quote = undefined
      continue
    }
    if (char === '"') {
      quote = quote === '"' ? undefined : '"'
      continue
    }
    if (char === "'" && quote === undefined) {
      quote = "'"
      continue
    }
    if (char === "$" && command[i + 1] === "(" && command[i + 2] !== "(") {
      const end = closeParen(command, i + 2)
      found.push(command.slice(i + 2, command[end - 1] === ")" ? end - 1 : end))
      i = end - 1
    } else if ((char === "<" || char === ">") && command[i + 1] === "(" && quote === undefined) {
      const end = closeParen(command, i + 2)
      found.push(command.slice(i + 2, command[end - 1] === ")" ? end - 1 : end))
      i = end - 1
    } else if (char === "`") {
      let end = i + 1
      while (end < command.length && command[end] !== "`") end += command[end] === "\\" ? 2 : 1
      found.push(command.slice(i + 1, end))
      i = end
    }
  }
  return found
}

const ENV_FLAGS_WITH_VALUE = new Set(["-u", "--unset"])
const TIMEOUT_FLAGS_WITH_VALUE = new Set(["-k", "--kill-after", "-s", "--signal"])
const DURATION = /^\d+(?:\.\d+)?[smhd]?$/

/** `words` without the wrappers that only run what follows (`env`, `time`, `command`, `nohup`, `exec`, `timeout 30`, `nice -n 5`, and `VAR=x` assignments). */
export function withoutTransparentWrappers(words: readonly string[]): string[] {
  let at = 0
  for (;;) {
    const word = words[at]
    if (word === undefined) break
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word) || word === "time" || word === "command" || word === "nohup" || word === "exec") at++
    else if (word === "env") {
      at++
      for (;;) {
        const flag = words[at]
        if (flag === "-i" || flag === "--ignore-environment" || flag === "-" || flag === "--") at++
        else if (flag !== undefined && ENV_FLAGS_WITH_VALUE.has(flag)) at += 2
        else if (flag?.startsWith("--unset=")) at++
        else break
      }
    } else if (word === "nice") {
      at++
      const flag = words[at]
      if (flag === "-n" || flag === "--adjustment") at += 2
      else if (flag !== undefined && /^(?:-\d+|--adjustment=.+)$/.test(flag)) at++
    } else if (word === "timeout") {
      at++
      for (;;) {
        const flag = words[at]
        if (flag === undefined) break
        if (TIMEOUT_FLAGS_WITH_VALUE.has(flag)) at += 2
        else if (flag.startsWith("-") && flag !== "-") at++
        else break
      }
      if (words[at] !== undefined && DURATION.test(words[at]!)) at++
    } else break
  }
  return words.slice(at)
}

const XARGS_FLAGS_WITH_VALUE = new Set(["-n", "-P", "-I", "-L", "-d", "-E", "-s", "-a", "--max-args", "--max-procs", "--delimiter", "--arg-file", "--max-lines", "--max-chars"])

/** The command `xargs` runs with the options skipped; empty when it only runs the default `echo`. */
export function xargsCommand(words: readonly string[]): string[] {
  let at = 1
  while (at < words.length && words[at]!.startsWith("-") && words[at] !== "--") {
    at += XARGS_FLAGS_WITH_VALUE.has(words[at]!) ? 2 : 1
  }
  if (words[at] === "--") at++
  return words.slice(at)
}
