/**
 * The identifiers a text search asks about, read from a shell command line (`grep`, `rg`, `git grep`…) or from a search pattern.
 * Pure text work with no imports: it runs on every search a model makes, before anything of the code graph is loaded.
 */

/** Candidate names one search may yield; the graph decides which of them it knows (search-hint.ts shows at most three). */
export const MAX_SEARCH_TERMS = 6
/** A command line longer than this is not parsed: a search is short, a script is not a search. */
const MAX_COMMAND_CHARS = 4000

/** Whether a command line can hold a text search at all: the cheap test before parsing. */
export const SEARCH_COMMAND = /(?:^|[\s;|&(/])(?:grep|egrep|fgrep|rg|ag|ack|ugrep)(?:\s|$)/

const PROGRAMS: ReadonlySet<string> = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack", "ugrep"])
/** Words that run another command: the search is what follows them. */
const WRAPPERS: ReadonlySet<string> = new Set(["sudo", "command", "time", "env", "nice", "nohup", "xargs", "noglob"])
/** Short options that take a value, per program family: their value is not the pattern. */
const GREP_VALUE_FLAGS = "ABCmfdD"
const RG_VALUE_FLAGS = "ABCmfgtTjMrE"
const VALUE_OPTIONS: ReadonlySet<string> = new Set([
  "--include", "--exclude", "--exclude-dir", "--exclude-from", "--include-dir", "--max-count", "--context", "--after-context", "--before-context", "--file", "--color", "--colour",
  "--glob", "--iglob", "--type", "--type-not", "--type-add", "--max-depth", "--maxdepth", "--max-columns", "--max-filesize", "--threads", "--replace", "--sort", "--sortr", "--encoding",
  "--engine", "--path-separator", "--context-separator", "--field-match-separator", "--pre", "--pre-glob", "--ignore-file", "--depth", "--ignore", "--ignore-dir", "--file-search-regex",
])
/** What may stand before the name in a pattern that looks for a declaration (`function foo`, `def foo`, `class Foo`). */
const DECLARATION_WORDS: ReadonlySet<string> = new Set([
  "function", "def", "class", "fn", "func", "interface", "type", "enum", "struct", "trait", "impl", "const", "let", "var", "export", "async", "static", "public", "private", "protected", "pub", "new", "import", "extends", "implements",
])
/** Words a search for prose or syntax hits and no one means as a symbol. */
const NOT_A_NAME: ReadonlySet<string> = new Set([...DECLARATION_WORDS, "true", "false", "null", "undefined", "return", "from", "todo", "fixme", "error", "warning", "test", "this", "self", "string", "number", "boolean", "void", "the", "and", "for", "not", "with"])

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)?$/

/** A command line as words and separators (`|`, `&&`, `;`…), with shell quoting removed; undefined when a quote never closes. */
function shellWords(command: string): Array<{ word: string } | { separator: true }> | undefined {
  const out: Array<{ word: string } | { separator: true }> = []
  let word = ""
  let has = false
  const flush = () => { if (has) out.push({ word }); word = ""; has = false }
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!
    if (char === "'") {
      const end = command.indexOf("'", i + 1)
      if (end === -1) return undefined
      word += command.slice(i + 1, end)
      has = true
      i = end
    } else if (char === '"') {
      let j = i + 1
      for (; j < command.length && command[j] !== '"'; j++) {
        // Inside double quotes a backslash only escapes these; before anything else it stays (so `"foo\|bar"` keeps its `\|`).
        if (command[j] === "\\" && j + 1 < command.length && '"\\$`'.includes(command[j + 1]!)) j++
        word += command[j]
      }
      if (j >= command.length) return undefined
      has = true
      i = j
    } else if (char === "\\" && i + 1 < command.length) {
      word += command[++i]
      has = true
    } else if (char === "|" || char === "&" || char === ";" || char === "\n" || char === "(" || char === ")") {
      flush()
      out.push({ separator: true })
    } else if (char === " " || char === "\t") flush()
    else { word += char; has = true }
  }
  flush()
  return out
}

/** The pattern arguments of one simple command (`grep -rn foo src`), or none when it is not a text search. */
function commandPatterns(words: string[], gitDirs?: string[]): Array<{ pattern: string; fixed: boolean }> {
  // `find … -exec grep foo {} +`: the search is what `-exec` runs.
  let at = words[0] === "find" ? Math.max(words.indexOf("-exec"), words.indexOf("-execdir")) + 1 : 0
  if (words[0] === "find" && at === 0) return []
  while (at < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[at]!) || WRAPPERS.has(words[at]!))) {
    const wrapper = words[at++]!
    // A wrapper's own options (`xargs -0 -n 1 grep`, `sudo -u x grep`) end where the program's name stands.
    if (WRAPPERS.has(wrapper)) while (at < words.length && !PROGRAMS.has(programName(words[at]!)) && words[at] !== "git" && (words[at]!.startsWith("-") || /^\d+$/.test(words[at]!))) at++
  }
  let program = programName(words[at] ?? "")
  if (program === "git") {
    at++
    while (at < words.length && words[at]!.startsWith("-")) {
      // `-C dir` moves where git searches; a git directory or work tree given another way is a place that cannot be told here.
      if (words[at] === "-C") gitDirs?.push(words[at + 1] ?? "")
      else if (/^--(?:git-dir|work-tree)\b/.test(words[at]!) || words[at] === "-c" && /^core\.worktree=/i.test(words[at + 1] ?? "")) gitDirs?.push("$")
      at += words[at] === "-C" || words[at] === "-c" ? 2 : 1
    }
    if (words[at] !== "grep") return []
    program = "git grep"
  } else if (!PROGRAMS.has(program)) return []
  at++
  const ripgrep = program === "rg" || program === "ag" || program === "ack"
  const valueFlags = ripgrep ? RG_VALUE_FLAGS : GREP_VALUE_FLAGS
  let fixed = program === "fgrep"
  const explicit: string[] = []
  let positional: string | undefined
  for (; at < words.length; at++) {
    const word = words[at]!
    if (word === "--") { positional ??= words[at + 1]; break }
    if (word.startsWith("--")) {
      const equals = word.indexOf("=")
      const name = equals === -1 ? word : word.slice(0, equals)
      if (name === "--fixed-strings" || name === "--literal") fixed = true
      else if (name === "--regexp") { const value = equals === -1 ? words[++at] : word.slice(equals + 1); if (value !== undefined) explicit.push(value) }
      else if (equals === -1 && VALUE_OPTIONS.has(name)) at++
      continue
    }
    if (word.startsWith("-") && word.length > 1) {
      for (let i = 1; i < word.length; i++) {
        const flag = word[i]!
        if (flag === "F") fixed = true
        if (flag === "e") { const value = i + 1 < word.length ? word.slice(i + 1) : words[++at]; if (value !== undefined) explicit.push(value); break }
        if (valueFlags.includes(flag) || /\d/.test(flag)) { if (i + 1 >= word.length && !/\d/.test(flag)) at++; break }
      }
      continue
    }
    positional ??= word
  }
  const patterns = explicit.length ? explicit : positional !== undefined ? [positional] : []
  return patterns.map((pattern) => ({ pattern, fixed }))
}

const programName = (word: string) => word.slice(word.lastIndexOf("/") + 1)

/** One alternative of a pattern as a name, or undefined when it is not plainly one identifier. */
function alternativeName(alternative: string, fixed: boolean): string | undefined {
  let text = alternative.trim()
  if (!fixed) {
    // Anchors, word boundaries and a call's opening bracket around a name are how a symbol is searched; anything else regex-like is not a name.
    text = text.replace(/^(?:\^|\\b|\\<|\\s[*+]?|\\?\((?:\?:)?)+/, "").replace(/(?:\$|\\b|\\>|\\s[*+]?|\\?\(|\\?\)|<)+$/, "").replace(/\\s[+*]?|\\ /g, " ").replace(/\\\./g, "\u0000")
    if (/[\\[\]{}*+?^$.]/.test(text)) return undefined
    text = text.replaceAll("\u0000", ".")
  }
  const words = text.split(/\s+/).filter(Boolean)
  const name = words.pop()
  if (!name || !words.every((word) => DECLARATION_WORDS.has(word))) return undefined
  if (name.length < 3 || name.length > 80 || !IDENTIFIER.test(name) || NOT_A_NAME.has(name.toLowerCase())) return undefined
  return name
}

/** The identifiers a search pattern names: each alternative of `a|b`, `a\|b` or `(a|b)` that is one plain name. `fixed`: the pattern is literal text. */
export function patternTerms(pattern: string, { fixed = false }: { fixed?: boolean } = {}): string[] {
  if (pattern.length > 400) return []
  const alternatives = fixed ? [pattern] : pattern.replace(/\\\|/g, "|").split("|")
  const names: string[] = []
  for (const alternative of alternatives) {
    const name = alternativeName(alternative, fixed)
    if (name && !names.includes(name)) names.push(name)
    if (names.length >= MAX_SEARCH_TERMS) break
  }
  return names
}

/** A directory argument whose place is not known from the text: a variable, `~`, a glob, a command substitution, `-` or nothing. */
const UNKNOWN_DIRECTORY = /^$|^-|[$`~*?[{]/

/**
 * The identifiers the text searches of a command line ask about, and where they are searched: `directories` are the folders the search
 * moved into from the shell's own, in order (`cd` targets and `git -C` values; each relative to the one before). `directories` is
 * undefined when the place cannot be told (a variable, `~`, a `cd` inside brackets, searches in different places), so the caller says nothing.
 */
export function searchPlan(command: string): { terms: string[]; directories: string[] | undefined } {
  if (command.length > MAX_COMMAND_CHARS || !SEARCH_COMMAND.test(command)) return { terms: [], directories: [] }
  const parts = shellWords(command)
  if (!parts) return { terms: [], directories: [] }
  const names: string[] = []
  let words: string[] = []
  const moved: string[] = []
  let place: string[] | undefined
  let certain = !/[({]/.test(command) || !/\b(?:cd|pushd)\b/.test(command)
  const end = () => {
    const first = words[0] === "cd" || words[0] === "pushd" ? words : undefined
    if (first) {
      const target = first[1] === "--" ? first[2] : first[1]
      if (first.length > (first[1] === "--" ? 3 : 2) || target === undefined || UNKNOWN_DIRECTORY.test(target)) certain = false
      else moved.push(target)
      words = []
      return
    }
    const gitDirs: string[] = []
    const patterns = words.length ? commandPatterns(words, gitDirs) : []
    let found = false
    for (const { pattern, fixed } of patterns) for (const name of patternTerms(pattern, { fixed })) { found = true; if (!names.includes(name)) names.push(name) }
    if (found) {
      const here = [...moved, ...gitDirs]
      if (here.some((directory) => UNKNOWN_DIRECTORY.test(directory))) certain = false
      else if (place && place.join("\n") !== here.join("\n")) certain = false
      place ??= here
    }
    words = []
  }
  for (const part of parts) {
    if ("word" in part) words.push(part.word)
    else end()
  }
  end()
  return { terms: names.slice(0, MAX_SEARCH_TERMS), directories: certain ? place ?? [] : undefined }
}

/** The identifiers the text searches of a command line ask about (`grep -rn "foo" src | head`, `rg -w 'a|b'`, `git grep -e x`); empty for any other command. */
export const searchTerms = (command: string): string[] => searchPlan(command).terms
