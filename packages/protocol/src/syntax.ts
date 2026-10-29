/**
 * A tiny per-line syntax tokenizer for fenced code (comments, strings, numbers, keywords, function
 * calls, types). One linear regex pass per line, no parse tree: good enough to read, cheap enough to
 * run on every streamed frame. Multi-line block comments, Python triple quotes and Markdown code fences carry `state`.
 *
 * It lives in the protocol package because the daemon needs it too: a window of a file that starts inside a block comment is lexed
 * from the state `lexEntry` finds by running this same tokenizer over the lines above it (docs/file-viewer.md). The terminal re-exports
 * it from `view/syntax.ts`; `Span` and `ColorName` here are the subset of the theme's that the tokenizer uses.
 *
 * Languages (aliases in brackets): typescript [tsx, js, jsx, mjs, cjs], json [jsonc, json5], bash [sh, zsh, shell, console],
 * python [py], go, rust [rs], c [h], cpp [c++, cc, hpp], java, csharp [cs], kotlin [kt], swift, ruby [rb], php, sql, yaml [yml],
 * toml, css [scss, less], html [xml, svg, vue], lua, dockerfile; diff [patch] and markdown [md] are styled by line.
 */
export type HighlightState = {
  block?: boolean
  triple?: string
  /** Inside a Markdown code fence: what closes it and the language of its lines (colored by that language, with its own state). */
  fence?: { marker: string; lang: string; inner: HighlightState }
}

/** The theme roles the tokenizer paints with (a subset of the terminal's `ColorName`). */
export type ColorName = "code" | "text" | "muted" | "info" | "success" | "error" | "heading" | "synComment" | "synString" | "synKeyword" | "synNumber" | "synFunction" | "synType" | "synFlag" | "synPrompt"
export type Span = { text: string; fg?: ColorName; bold?: boolean }

type Language = {
  keywords: ReadonlySet<string>
  /** Regex source for a line comment start, e.g. `//`. */
  line?: string
  /** Regex source for a whole comment token, for comments that are not "start to end of line" (HTML's `<!-- … -->`). */
  comment?: string
  /** C-style block comments. */
  block?: boolean
  /** Regex source alternatives for string literals. */
  strings: string
  /** Python-style triple quotes. */
  triple?: boolean
  /** Identifiers that start with a capital letter are types. */
  types?: boolean
  /** `$NAME` / `${NAME}` variables. */
  variables?: boolean
  /** Regex source for another kind of variable (`$name` in PHP, `@name` in Ruby), coloured like a type. */
  variable?: string
  /** The first word of a line is a command (shell). */
  commands?: boolean
  /** `-x` / `--long` options (shell). */
  flags?: boolean
  /** A leading `$ `, `% `, `❯ ` or `> ` is a prompt, not code (shell sessions). */
  prompt?: boolean
  /** Keywords match in any case (SQL, Dockerfile). */
  ignoreCase?: boolean
  /** Regex source for an identifier; the default is `[A-Za-z_$][\w$]*`. */
  word?: string
  /** A word followed by text matching `after` (tested on the rest of the line) is a key in `role`. */
  keys?: { after: RegExp; role: ColorName }
  /** `<tag` and `>` are keywords (HTML, XML). */
  tags?: boolean
  /** `@rule` is a keyword (CSS). */
  atRules?: boolean
  /** `#fff` colour literals are numbers (CSS). */
  hex?: boolean
}

const words = (text: string): ReadonlySet<string> => new Set(text.split(/\s+/).filter(Boolean))

const QUOTES = String.raw`"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|` + "`(?:[^`\\\\]|\\\\.)*`?"
const DOUBLE = String.raw`"(?:[^"\\]|\\.)*"?`
const CHAR = String.raw`'(?:\\.|[^'\\])'`
const DASHED = String.raw`[A-Za-z_][\w-]*`

const ECMA: Language = {
  keywords: words(
    "const let var function return if else for while do switch case break continue new class extends implements interface type enum import export from as default async await try catch finally throw typeof instanceof in of void delete yield static readonly public private protected abstract declare namespace this super null undefined true false satisfies keyof",
  ),
  line: "//",
  block: true,
  strings: QUOTES,
  types: true,
}

/** C and its descendants: `//` and block comments, double-quoted strings and character literals, capitalised types. */
const cLike = (keywords: string, extra: Partial<Language> = {}): Language => ({ keywords: words(keywords), line: "//", block: true, strings: `${DOUBLE}|${CHAR}`, types: true, ...extra })

const C_WORDS = "auto break case char const continue default do double else enum extern float for goto if inline int long register return short signed sizeof static struct switch typedef union unsigned void volatile while bool true false NULL nullptr"

const LANGUAGES: Record<string, Language> = {
  ts: ECMA,
  json: { keywords: words("true false null"), strings: DOUBLE },
  bash: {
    keywords: words("if then else elif fi for while until do done case esac function in return export local readonly set unset source alias exit break continue"),
    line: "#",
    strings: QUOTES,
    variables: true,
    commands: true,
    flags: true,
    prompt: true,
  },
  py: {
    keywords: words(
      "def class return if elif else for while in not and or is import from as with try except finally raise pass break continue lambda yield global nonlocal async await None True False self del assert",
    ),
    line: "#",
    strings: QUOTES,
    triple: true,
    types: true,
  },
  go: {
    keywords: words("package import func return if else for range switch case default break continue go defer select chan map struct interface type var const fallthrough goto nil true false"),
    line: "//",
    block: true,
    strings: `${DOUBLE}|\`[^\`]*\`?|${CHAR}`,
    types: true,
  },
  rust: {
    keywords: words(
      "fn let mut const static struct enum impl trait pub use mod crate self Self super as if else match for while loop in return break continue move ref where async await dyn unsafe type true false None Some Ok Err",
    ),
    line: "//",
    block: true,
    strings: `${DOUBLE}|${CHAR}`,
    types: true,
  },
  c: cLike(C_WORDS),
  cpp: cLike(`${C_WORDS} class namespace template typename using public private protected virtual override final new delete this try catch throw operator constexpr noexcept static_cast dynamic_cast reinterpret_cast const_cast explicit friend mutable`),
  java: cLike("abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while var record sealed permits yield true false null"),
  csharp: cLike("abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly ref return sbyte sealed short sizeof static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using var virtual void volatile while async await record init get set yield"),
  kotlin: cLike("as break class continue do else false for fun if in interface is null object package return super this throw true try typealias typeof val var when while by catch constructor delegate dynamic field file finally get import init param property receiver set setparam value where abstract actual annotation companion const crossinline data enum expect external final infix inline inner internal lateinit noinline open operator out override private protected public reified sealed suspend tailrec vararg"),
  swift: cLike("associatedtype class deinit enum extension fileprivate func import init inout internal let open operator private precedencegroup protocol public rethrows static struct subscript typealias var break case catch continue default defer do else fallthrough for guard if in repeat return throw switch where while as Any await catch false is nil self Self super throw throws true try async actor some any final override lazy weak unowned mutating nonmutating convenience required dynamic indirect nonisolated isolated consuming borrowing macro get set willSet didSet"),
  ruby: {
    keywords: words("alias and begin break case class def defined? do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield require require_relative attr_accessor attr_reader attr_writer puts"),
    line: "#",
    strings: QUOTES,
    types: true,
    variable: String.raw`@{1,2}[A-Za-z_]\w*|\$[A-Za-z_]\w*`,
  },
  php: {
    keywords: words("abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use var while xor yield true false null self parent"),
    line: "(?://|#(?!\\[))",
    block: true,
    strings: QUOTES,
    types: true,
    variable: String.raw`\$[A-Za-z_]\w*`,
  },
  sql: {
    keywords: words("select from where and or not in is null like between join inner left right full outer cross on as group by order having limit offset union all distinct insert into values update set delete create table alter drop index view primary key foreign references default unique check constraint case when then else end exists asc desc with returning begin commit rollback transaction int integer bigint text varchar boolean timestamp date true false"),
    line: "--",
    block: true,
    strings: `'(?:[^']|'')*'?|${DOUBLE}`,
    ignoreCase: true,
  },
  yaml: {
    keywords: words("true false null yes no on off ~"),
    line: "#",
    strings: QUOTES,
    word: DASHED,
    keys: { after: /^:(?:\s|$)/, role: "synFunction" },
  },
  toml: {
    keywords: words("true false"),
    line: "#",
    strings: `"""|'''|${QUOTES}`,
    word: DASHED,
    keys: { after: /^\s*=/, role: "synFunction" },
  },
  css: {
    keywords: words("important inherit initial unset none auto"),
    block: true,
    strings: QUOTES,
    word: String.raw`-?[A-Za-z_][\w-]*`,
    keys: { after: /^\s*:/, role: "synFunction" },
    atRules: true,
    hex: true,
  },
  html: {
    keywords: words(""),
    comment: "<!--.*?(?:-->|$)",
    strings: QUOTES,
    word: String.raw`[A-Za-z_:@][\w:.-]*`,
    keys: { after: /^=/, role: "synType" },
    tags: true,
  },
  lua: {
    keywords: words("and break do else elseif end false for function goto if in local nil not or repeat return then true until while self require"),
    line: "--",
    strings: QUOTES,
  },
  dockerfile: {
    keywords: words("from run cmd label maintainer expose env add copy entrypoint volume user workdir arg onbuild stopsignal healthcheck shell as"),
    line: "#",
    strings: QUOTES,
    variables: true,
    ignoreCase: true,
    word: DASHED,
    flags: true,
  },
}

const ALIASES: Record<string, string> = {
  typescript: "ts",
  tsx: "ts",
  javascript: "ts",
  js: "ts",
  jsx: "ts",
  mjs: "ts",
  cjs: "ts",
  jsonc: "json",
  json5: "json",
  jsonl: "json",
  ndjson: "json",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  "shell-session": "bash",
  python: "py",
  golang: "go",
  rs: "rust",
  h: "c",
  "c++": "cpp",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  cs: "csharp",
  "c#": "csharp",
  kt: "kotlin",
  kts: "kotlin",
  rb: "ruby",
  yml: "yaml",
  scss: "css",
  less: "css",
  xml: "html",
  svg: "html",
  vue: "html",
  htm: "html",
  psql: "sql",
  pgsql: "sql",
  mysql: "sql",
  docker: "dockerfile",
}

/** The canonical names `highlight` colours, for the docs and for tests that check every one has a tokenizer. */
export const HIGHLIGHT_LANGUAGES: readonly string[] = [...Object.keys(LANGUAGES), "diff", "md"]

const compiled = new Map<string, RegExp>()
const NEVER = "(?!)"

function tokenizer(name: string, language: Language) {
  let rx = compiled.get(name)
  if (!rx) {
    const variable = language.variable ?? (language.variables ? String.raw`\$(?:\{[^}]*\}?|[A-Za-z_]\w*|[@#?$!*0-9])` : undefined)
    const number = String.raw`\b(?:0[xX][0-9a-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)\b`
    const parts = [
      language.comment ? `(?<comment>${language.comment})` : language.line ? `(?<comment>${language.line}.*)` : `(?<comment>${NEVER})`,
      `(?<string>${language.strings})`,
      `(?<variable>${variable ?? NEVER})`,
      `(?<flag>${language.flags ? String.raw`(?<![\w$.\\/-])--?[A-Za-z][\w-]*` : NEVER})`,
      `(?<tag>${language.tags ? String.raw`</?[A-Za-z][\w:.-]*|/?>` : NEVER})`,
      `(?<rule>${language.atRules ? String.raw`@[A-Za-z][\w-]*` : NEVER})`,
      `(?<number>${language.hex ? String.raw`#[0-9a-fA-F]{3,8}\b|` : ""}${number})`,
      `(?<word>${language.word ?? String.raw`[A-Za-z_$][\w$]*`})`,
    ]
    rx = new RegExp(parts.join("|"), "g")
    compiled.set(name, rx)
  }
  rx.lastIndex = 0
  return rx
}

function languageOf(lang: string): { name: string; language: Language } | undefined {
  const key = lang.toLowerCase()
  const name = ALIASES[key] ?? key
  const language = LANGUAGES[name]
  return language ? { name, language } : undefined
}

/** Whether `lang` (as written after a fence) is one `highlight` colours. */
export const isHighlighted = (lang: string) => {
  const key = lang.toLowerCase()
  return !!languageOf(key) || key === "diff" || key === "patch" || key === "md" || key === "markdown"
}

const plain = (text: string, fg: ColorName = "code"): Span => ({ text, fg })

/** Lines of a unified diff, TOML section headers and Markdown are styled by their first characters, not tokens. */
function lineStyled(name: string, line: string): Span[] | undefined {
  if (name === "diff") {
    if (line.startsWith("+++") || line.startsWith("---")) return [{ text: line, fg: "muted", bold: true }]
    if (line.startsWith("@@")) return [{ text: line, fg: "info" }]
    if (line.startsWith("+")) return [{ text: line, fg: "success" }]
    if (line.startsWith("-")) return [{ text: line, fg: "error" }]
    return [plain(line, "muted")]
  }
  if (name === "toml" && /^\s*\[\[?[^\]]+\]\]?\s*(?:#.*)?$/.test(line)) return [{ text: line, fg: "synType", bold: true }]
  if (name === "md") {
    // A document, not a block of code: prose is the normal text color, the `#` marker alone is the accent and the title is bold.
    const heading = /^(\s*#{1,6}\s+)(.*)$/.exec(line)
    if (heading) return [{ text: heading[1]!, fg: "heading", bold: true }, ...(heading[2] ? [{ text: heading[2], fg: "text" as const, bold: true }] : [])]
    const item = /^(\s*(?:[-*+]|\d+[.)])\s+)(.*)$/.exec(line)
    if (item) return [{ text: item[1]!, fg: "muted" }, ...inlineCode(item[2]!)]
    if (/^\s*>/.test(line)) return [plain(line, "muted")]
    return inlineCode(line)
  }
  return undefined
}

/** Prose of a Markdown line: the normal text color, `code` spans in the code role (as the chat paints them), the address of a link muted. */
function inlineCode(text: string): Span[] {
  const spans: Span[] = []
  let last = 0
  for (const match of text.matchAll(/`[^`]*`?|(\[[^\]]*\])(\([^)\s]*\))/g)) {
    if (match.index! > last) spans.push(plain(text.slice(last, match.index), "text"))
    if (match[1] !== undefined) spans.push(plain(match[1], "text"), plain(match[2]!, "muted"))
    else spans.push(plain(match[0], "code"))
    last = match.index! + match[0].length
  }
  if (last < text.length) spans.push(plain(text.slice(last), "text"))
  return spans
}

const PROMPT = /^(\s*)([$%❯>])(\s+)(?=\S)/

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)(.*)$/
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/

/**
 * One line of a Markdown document: a code fence opens on ``` or ~~~ (the first word after it names the language), its lines are colored
 * by that language until a fence of the same character, at least as long, closes it. Lines outside a fence are styled by their start.
 */
function markdownLine(line: string, state: HighlightState): Span[] {
  const fence = state.fence
  if (fence) {
    const closing = FENCE_CLOSE.exec(line)
    if (closing && closing[1]![0] === fence.marker[0] && closing[1]!.length >= fence.marker.length) {
      delete state.fence
      return [{ text: line, fg: "muted" }]
    }
    return fence.lang && isHighlighted(fence.lang) ? highlight(line, fence.lang, fence.inner) : line ? [plain(line)] : []
  }
  const open = FENCE_OPEN.exec(line)
  // A backtick fence's info string cannot hold a backtick (that is inline code, not a fence).
  if (open && !(open[1]![0] === "`" && open[3]!.includes("`"))) {
    state.fence = { marker: open[1]!, lang: open[2]!.replace(/^\{?\.?/, "").replace(/[{}].*$/, "").toLowerCase(), inner: {} }
    return [{ text: line, fg: "muted" }]
  }
  return lineStyled("md", line)!
}

/** A state that came over the wire, kept to what the tokenizer can hold (a daemon is trusted to be right, not to be well formed). */
export function sanitizeState(value: unknown, depth = 0): HighlightState {
  const out: HighlightState = {}
  if (!value || typeof value !== "object") return out
  const given = value as Record<string, unknown>
  if (given.block === true) out.block = true
  if (given.triple === '"""' || given.triple === "'''") out.triple = given.triple
  const fence = given.fence as Record<string, unknown> | undefined
  if (depth < 2 && fence && typeof fence.marker === "string" && /^(`{3,40}|~{3,40})$/.test(fence.marker) && typeof fence.lang === "string" && fence.lang.length <= 32) {
    out.fence = { marker: fence.marker, lang: fence.lang, inner: sanitizeState(fence.inner, depth + 1) }
  }
  return out
}

/** Whether `state` is the start of a file (nothing open): a window that starts there needs no entry state. */
export const isFreshState = (state: HighlightState) => !state.block && !state.triple && !state.fence

/**
 * The state the tokenizer is in after `lines`: what a window that starts right below them begins with. It is the tokenizer itself run over
 * the lines (nothing else lexes a file), so a block comment opened at line 10 of a 5,000-line file is still open at line 3,000.
 */
export function lexEntry(lines: Iterable<string>, lang: string): HighlightState {
  const state: HighlightState = {}
  for (const line of lines) highlight(line, lang, state)
  return sanitizeState(state)
}

/** One code line as styled spans; unknown languages come back as a single `code` span. */
export function highlight(line: string, lang: string, state: HighlightState = {}): Span[] {
  if (!line) return []
  const key = lang.toLowerCase()
  const kind = key === "patch" ? "diff" : key === "markdown" ? "md" : key
  if (kind === "md") return markdownLine(line, state)
  const styled = lineStyled(kind, line)
  if (styled) return styled
  const found = languageOf(lang)
  if (!found) return [plain(line)]
  const { name, language } = found

  if (language.prompt) {
    const prompt = PROMPT.exec(line)
    if (prompt) return [...(prompt[1] ? [plain(prompt[1])] : []), { text: prompt[2]!, fg: "synPrompt" }, plain(prompt[3]!), ...highlight(line.slice(prompt[0].length), lang, state)]
  }

  const spans: Span[] = []
  let start = 0
  const push = (text: string, fg: ColorName) => {
    if (text) spans.push(plain(text, fg))
  }
  if (state.block) {
    const end = line.indexOf("*/")
    if (end < 0) return [plain(line, "synComment")]
    push(line.slice(0, end + 2), "synComment")
    state.block = false
    start = end + 2
  } else if (state.triple) {
    const end = line.indexOf(state.triple)
    if (end < 0) return [plain(line, "synString")]
    push(line.slice(0, end + 3), "synString")
    delete state.triple
    start = end + 3
  }

  /** Shell: the word in command position (line start, after a pipe, `;`, `&&`, `(`) is a command. */
  let commandPos = true
  const rx = tokenizer(name, language)
  rx.lastIndex = start
  let last = start
  for (let match = rx.exec(line); match; match = rx.exec(line)) {
    const groups = match.groups!
    const at = match.index
    // Block comments and triple quotes start inside the regexes' blind spots (`/` and quote runs): handle them by hand.
    const before = line.slice(last, at)
    if (language.block && before.includes("/*")) break
    if (before) {
      push(before, "code")
      if (language.commands && /[|;&(]/.test(before)) commandPos = true
    }
    last = at + match[0].length
    if (groups.comment !== undefined) push(match[0], "synComment")
    else if (groups.string !== undefined) {
      if (language.triple && (line.startsWith('"""', at) || line.startsWith("'''", at))) {
        const marker = line.slice(at, at + 3)
        const closing = line.indexOf(marker, at + 3)
        if (closing < 0) {
          push(line.slice(at), "synString")
          state.triple = marker
          return spans
        }
        push(line.slice(at, closing + 3), "synString")
        last = closing + 3
        rx.lastIndex = last
      } else push(match[0], "synString")
    } else if (groups.variable !== undefined) push(match[0], "synType")
    else if (groups.flag !== undefined) push(match[0], "synFlag")
    else if (groups.tag !== undefined || groups.rule !== undefined) push(match[0], "synKeyword")
    else if (groups.number !== undefined) push(match[0], "synNumber")
    else {
      const word = match[0]
      const next = line.slice(last).match(/^\s*(.)/)?.[1]
      if (language.keywords.has(language.ignoreCase ? word.toLowerCase() : word)) {
        push(word, "synKeyword")
        continue
      }
      if (language.commands && commandPos) push(word, "synFunction")
      else if (language.keys?.after.test(line.slice(last))) push(word, language.keys.role)
      else if (next === "(") push(word, "synFunction")
      else if (language.types && /^[A-Z]/.test(word)) push(word, "synType")
      else if (name === "json" && next === ":") push(word, "synFunction")
      else push(word, "code")
    }
    if (language.commands) commandPos = false
  }
  const rest = line.slice(last)
  if (language.block) {
    const open = rest.indexOf("/*")
    if (open >= 0) {
      push(rest.slice(0, open), "code")
      const close = rest.indexOf("*/", open + 2)
      if (close < 0) {
        push(rest.slice(open), "synComment")
        state.block = true
      } else {
        push(rest.slice(open, close + 2), "synComment")
        push(rest.slice(close + 2), "code")
      }
      return spans
    }
  }
  push(rest, "code")
  return spans
}
