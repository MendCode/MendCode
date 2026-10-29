import path from "node:path"
import type { Line } from "../ui/theme"
import { safeLink } from "../ui/hyperlink"

/**
 * Terminal hyperlinks for the transcript (docs/layout.md "Links"): URLs and file paths found in drawn rows become OSC 8 targets.
 * Pure: a path is linked by how it looks (nothing is read from disk), so the editor opens it or reports a missing file.
 */

export const FILE_OPENERS = ["file", "vscode", "vscode-insiders", "cursor", "windsurf", "zed", "idea", "none"] as const
export type FileOpener = (typeof FILE_OPENERS)[number]

export type LinkContext = { cwd: string; home?: string; opener: FileOpener }
export type LinkMatch = { start: number; end: number; uri: string }
type Row = { spans: Line; text: string; soft?: "space" | "none"; gutter?: number }

const URL = /https?:\/\/[^\s<>"'`]+/g
const SEGMENT = "[\\w@.+-]+"
const PATH = new RegExp(`(?<![\\w@.+/~:-])(?:(?:~|\\.{1,2})\\/${SEGMENT}(?:\\/${SEGMENT})*|\\/?${SEGMENT}(?:\\/${SEGMENT})+)\\/?(?::(\\d{1,7})(?::(\\d{1,5}))?)?`, "g")
const EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,7}$/

/** A URL without the punctuation a sentence puts after it (a closing bracket stays when the URL opened one). */
function trimUrl(url: string): string {
  let end = url.length
  while (end > 0) {
    const last = url[end - 1]!
    if (/[.,;:!?'"*]/.test(last)) end--
    else if (last === ")" && (url.slice(0, end).match(/\(/g)?.length ?? 0) < (url.slice(0, end).match(/\)/g)?.length ?? 0)) end--
    else if (last === "]" || last === "}") end--
    else break
  }
  return url.slice(0, end)
}

const encodePath = (value: string) => encodeURI(value).replace(/#/g, "%23").replace(/\?/g, "%3F")

/** The URI that opens `file` (absolute) at `line` and `column` in the chosen editor; undefined for `none` or an unusable result. */
export function fileUri({ file, line, column, opener }: { file: string; line?: number; column?: number; opener: FileOpener }): string | undefined {
  if (opener === "none") return undefined
  const place = line ? `:${line}${column ? `:${column}` : ""}` : ""
  const uri = opener === "file" ? `file://${encodePath(file)}`
    : opener === "idea" ? `idea://open?file=${encodeURIComponent(file)}${line ? `&line=${line}${column ? `&column=${column}` : ""}` : ""}`
    : `${opener}://file${encodePath(file)}${place}`
  return safeLink(uri)
}

function resolveFile(raw: string, context: LinkContext): string {
  const home = context.home
  if (raw === "~" || raw.startsWith("~/")) return home ? path.join(home, raw.slice(1)) : raw
  return path.resolve(context.cwd || "/", raw)
}

/** Every URL and file path in `text`, in order and without overlaps. */
export function findLinks(text: string, context: LinkContext): LinkMatch[] {
  if (text.length < 4 || (!text.includes("/") && !text.includes("://"))) return []
  const out: LinkMatch[] = []
  for (const match of text.matchAll(URL)) {
    const url = trimUrl(match[0])
    const uri = safeLink(url)
    if (uri) out.push({ start: match.index!, end: match.index! + url.length, uri })
  }
  if (context.opener === "none") return out
  for (const match of text.matchAll(PATH)) {
    const start = match.index!
    let end = start + match[0].length
    if (out.some((link) => start < link.end && end > link.start)) continue
    const line = match[1] ? Number(match[1]) : undefined
    const column = match[2] ? Number(match[2]) : undefined
    let raw = match[0].slice(0, match[0].length - (match[1] ? match[1].length + 1 + (match[2] ? match[2].length + 1 : 0) : 0))
    if (!match[1]) {
      while (/[.+\-]$/.test(raw)) raw = raw.slice(0, -1)
      end = start + raw.length
    }
    const trimmed = raw.endsWith("/") ? raw.slice(0, -1) : raw
    const prefixed = /^(?:~|\.{1,2})?\//.test(trimmed) || trimmed === "~"
    if (!prefixed && !EXTENSION.test(trimmed)) continue
    if (!prefixed && trimmed.split("/").every((part) => /^[\d.]+$/.test(part))) continue
    const uri = fileUri({ file: resolveFile(trimmed, context), ...(line ? { line } : {}), ...(column ? { column } : {}), opener: context.opener })
    if (uri) out.push({ start, end, uri })
  }
  return out.sort((a, b) => a.start - b.start)
}

/** `line` with the character ranges in `matches` marked as links; spans that are links already stay as they are. */
export function applyLinks(line: Line, matches: readonly LinkMatch[]): Line {
  if (!matches.length) return line
  const out: Line = []
  let at = 0
  for (const span of line) {
    const from = at
    const to = at + span.text.length
    at = to
    const inside = span.link ? [] : matches.filter((match) => match.start < to && match.end > from)
    if (!inside.length) {
      out.push(span)
      continue
    }
    let cursor = from
    for (const match of inside) {
      const start = Math.max(match.start, from)
      const end = Math.min(match.end, to)
      if (start > cursor) out.push({ ...span, text: span.text.slice(cursor - from, start - from) })
      out.push({ ...span, text: span.text.slice(start - from, end - from), link: match.uri })
      cursor = end
    }
    if (cursor < to) out.push({ ...span, text: span.text.slice(cursor - from) })
  }
  return out
}

/**
 * The drawn rows with links marked. A URL that ends a row the layout cut in the middle of a word continues on the next row:
 * both pieces point at the whole address.
 */
export function linkRows(rows: readonly Row[], context: LinkContext): Line[] {
  const found = rows.map((row) => findLinks(row.text, context))
  rows.forEach((row, index) => {
    const next = rows[index + 1]
    const last = found[index]!.at(-1)
    if (!next || next.soft !== "none" || !last || !/^https?:/.test(last.uri) || last.end < row.text.trimEnd().length) return
    const gutter = next.gutter ?? 0
    const rest = next.text.slice(gutter).match(/^[^\s<>"'`]+/)?.[0]
    if (!rest) return
    const whole = trimUrl(last.uri + rest)
    const uri = safeLink(whole)
    if (!uri) return
    found[index]![found[index]!.length - 1] = { ...last, uri }
    const continued = whole.length - last.uri.length
    found[index + 1] = [{ start: gutter, end: gutter + Math.max(0, continued), uri }, ...found[index + 1]!.filter((match) => match.start >= gutter + continued)]
  })
  return rows.map((row, index) => applyLinks(row.spans, found[index]!))
}
