import path from "node:path"

/**
 * File references in drawn text (docs/file-viewer.md): `src/app.rs:120`, `src/ui.rs:300:5`, `src/files/link.rs:56-79`,
 * `DESIGN.md#L10-L20`, `./AGENTS.md`, `/abs/path/inside/the/project.ts`. Pure: nothing is read from disk. It accepts what `links.ts`
 * links as a file (a path with a slash and an extension, or one that starts with `/`, `./`, `../` or `~/`) plus line ranges and
 * bare file names with a known extension. URLs, `std::collections::HashMap` and dates are not references.
 */

/** The palette's title while it lists the file paths of the item in view (the `file.open` key). */
export const OPEN_FILE_TITLE = "Open file"

export type FileRef = {
  /** As written, without the line suffix and trailing punctuation. */
  raw: string
  line?: number
  /** The last line of a range (`56-79`, `#L10-L20`); equal to or after `line`. */
  endLine?: number
  /** Index of the first character in the text and one past the last (the line suffix included). */
  start: number
  end: number
}

const SEGMENT = "[\\w@.+-]+"
/** `:56-79`, `:300:5`, `:120`, `#L10-L20`, `#L10`, `#L10-20`. */
const SUFFIX = "(?::(\\d{1,7})(?:-(\\d{1,7})|:\\d{1,5})?|#L(\\d{1,7})(?:C\\d{1,5})?(?:-L?(\\d{1,7})(?:C\\d{1,5})?)?)"
const PATH = new RegExp(`(?<![\\w@.+/~:#-])(?:(?:~|\\.{1,2})\\/${SEGMENT}(?:\\/${SEGMENT})*|\\/?${SEGMENT}(?:\\/${SEGMENT})+|${SEGMENT})\\/?${SUFFIX}?`, "g")
const SUFFIX_END = /(?::\d{1,7}(?:-\d{1,7}|:\d{1,5})?|#L\d{1,7}(?:C\d{1,5})?(?:-L?\d{1,7}(?:C\d{1,5})?)?)$/
const URL = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>"'`]+/g
const EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,7}$/
/** A bare `name.ext` counts only for these: prose is full of `e.g.` and `Node.js`, and a bare name is only opened when it exists. */
const BARE_EXTENSIONS = new Set("md mdx txt rst json jsonc yaml yml toml lock ini env cfg conf ts tsx mts cts js jsx mjs cjs py rs go java kt kts rb php c h cc cpp hpp cs swift sh bash zsh fish css scss less html htm vue svelte sql graphql proto xml svg gradle makefile dockerfile tf lua ex exs hs".split(" "))
const BARE_NAMES = new Set(["Makefile", "Dockerfile", "LICENSE", "README", "AGENTS", "CLAUDE", "Cargo.lock"])

const number = (value: string | undefined) => (value ? Number(value) : undefined)

/** Every file reference in `text`, in order, without overlapping a URL. */
export function findFileRefs(text: string): FileRef[] {
  if (text.length < 3) return []
  const urls = text.includes("://") ? [...text.matchAll(URL)].map((match) => [match.index!, match.index! + match[0].length] as const) : []
  const out: FileRef[] = []
  for (const match of text.matchAll(PATH)) {
    const start = match.index!
    let end = start + match[0].length
    if (urls.some(([from, to]) => start < to && end > from)) continue
    const suffixed = match[1] !== undefined || match[3] !== undefined
    let raw = suffixed ? match[0].slice(0, match[0].length - (SUFFIX_END.exec(match[0])?.[0].length ?? 0)) : match[0]
    // Sentence punctuation after a path is not part of it; a line suffix already ended the name.
    if (!suffixed) {
      while (/[.+\-]$/.test(raw)) raw = raw.slice(0, -1)
      end = start + raw.length
    }
    const trimmed = raw.endsWith("/") ? raw.slice(0, -1) : raw
    if (!trimmed) continue
    const prefixed = /^(?:~|\.{1,2})?\//.test(trimmed) || trimmed === "~"
    // A path with a slash needs an extension, or a slash at the end that says it is a folder (`src/view/`); a bare name needs to be a known file.
    if (!trimmed.includes("/")) {
      // A bare name: a known file name or extension, or any name with an extension when a line suffix says "this is a file".
      const dotted = EXTENSION.test(trimmed)
      const known = BARE_NAMES.has(trimmed) || dotted && BARE_EXTENSIONS.has(trimmed.slice(trimmed.lastIndexOf(".") + 1).toLowerCase())
      if (!known && !(suffixed && dotted) || /^[\d.]+$/.test(trimmed)) continue
    } else if (!prefixed && (!(EXTENSION.test(trimmed) || raw.endsWith("/")) || trimmed.split("/").every((part) => /^[\d.]+$/.test(part)))) continue
    const line = number(match[1] ?? match[3])
    const last = number(match[2] ?? match[4])
    out.push({ raw: trimmed, ...(line ? { line } : {}), ...(line && last && last >= line ? { endLine: last } : {}), start, end })
  }
  return out
}

/** The reference whose characters include index `at` of `text`. */
export const refAt = (text: string, at: number): FileRef | undefined => findFileRefs(text).find((ref) => at >= ref.start && at < ref.end)

export type RefContext = {
  /** The session's directory: relative paths start here. */
  cwd: string
  home?: string
  /** The workspace: the session's directory first, then its extra directories. A reference outside all of them is refused. */
  roots: readonly string[]
}

export type ResolvedRef =
  | { ok: true; root: string; /** Relative to `root`, forward slashes. */ path: string; absolute: string; line?: number; endLine?: number }
  | { ok: false; reason: "outside" | "unusable"; absolute: string }

const within = (file: string, root: string) => file === root || file.startsWith(root.endsWith(path.sep) ? root : root + path.sep)

/** Where `ref` points and which root of the workspace holds it. The daemon still checks symlinks; this decides what is never asked. */
export function resolveRef(ref: Pick<FileRef, "raw" | "line" | "endLine">, context: RefContext): ResolvedRef {
  const raw = ref.raw
  if (raw.includes("\0")) return { ok: false, reason: "unusable", absolute: raw }
  const absolute = raw === "~" || raw.startsWith("~/") ? (context.home ? path.join(context.home, raw.slice(1)) : raw) : path.resolve(context.cwd || "/", raw)
  const root = context.roots.find((candidate) => within(absolute, candidate))
  if (!root || !path.isAbsolute(absolute)) return { ok: false, reason: "outside", absolute }
  const relative = path.relative(root, absolute).split(path.sep).join("/") || "."
  return { ok: true, root, path: relative, absolute, ...(ref.line ? { line: ref.line } : {}), ...(ref.endLine ? { endLine: ref.endLine } : {}) }
}

/** `/open` and `ask agent` use the same spelling: `src/a.ts`, `src/a.ts:12`, `src/a.ts:12-20`. */
export function parseOpenTarget(text: string): { raw: string; line?: number; endLine?: number } | undefined {
  const value = text.trim().replace(/^["'`](.*)["'`]$/, "$1").replace(/^@/, "")
  if (!value) return undefined
  const found = /^(.*?)(?::(\d{1,7})(?:-(\d{1,7})|:\d{1,5})?|#L(\d{1,7})(?:C\d{1,5})?(?:-L?(\d{1,7})(?:C\d{1,5})?)?)?$/.exec(value)
  const raw = (found?.[1] ?? value).trim()
  if (!raw) return undefined
  const line = number(found?.[2] ?? found?.[4])
  const last = number(found?.[3] ?? found?.[5])
  return { raw, ...(line ? { line } : {}), ...(line && last && last >= line ? { endLine: last } : {}) }
}

/** A line range spelled the way a prompt and an editor read it. */
export const rangeLabel = (line: number, endLine?: number) => (endLine && endLine > line ? `${line}-${endLine}` : `${line}`)
