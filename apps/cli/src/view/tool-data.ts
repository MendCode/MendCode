/**
 * What a finished tool's text says, read back into data the cards draw from: the numbered rows of a file read, the entries of a
 * listing, the matches of a search grouped by file, a test run's counts, a fetched page's size. Pure and bounded: text in, data out.
 * Display only: the model still received the whole result.
 */

const NOTE = /^\[output (?:truncated|capped)/
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\r/g
const number = (text: string) => Number(text.replace(/,/g, ""))

/** The rows a read tool numbered (`    12\ttext`), where they start, and how many lines follow them that it did not send. */
export type ReadRows = {
  rows: Array<{ n: number; text: string }>
  first: number
  last: number
  more: number
  capped: boolean
  kind: "text" | "image" | "pdf" | "directory"
  /** The text carried its own line numbers; otherwise (another engine's read) the rows are numbered from 1 and drawn without a gutter. */
  numbered: boolean
}

export function parseRead(text: string): ReadRows {
  const clean = text.replace(ANSI, "")
  if (/^(Image|PDF) read successfully/.test(clean)) return { rows: [], first: 0, last: 0, more: 0, capped: false, kind: clean.startsWith("PDF") ? "pdf" : "image", numbered: false }
  if (/^<path>.*<\/path>\n<type>directory<\/type>/.test(clean)) return { rows: [], first: 0, last: 0, more: 0, capped: false, kind: "directory", numbered: false }
  const rows: ReadRows["rows"] = []
  const lines = clean.split("\n")
  for (const line of lines) {
    const hit = /^\s*(\d+)[\t→](.*)$/.exec(line)
    if (!hit) {
      // Numbered rows are one run from the top; what follows (a truncation note, loaded instructions) is not content.
      if (rows.length) break
      continue
    }
    rows.push({ n: Number(hit[1]), text: hit[2]! })
  }
  const more = /\[output truncated: ([\d,]+) more lines\]/.exec(clean)
  const plain = rows.length === 0
  if (plain) lines.filter((line) => line.trim().length > 0 && !NOTE.test(line)).forEach((line, at) => rows.push({ n: at + 1, text: line }))
  return { rows, first: rows[0]?.n ?? 0, last: rows.at(-1)?.n ?? 0, more: more ? number(more[1]!) : 0, capped: /\[output capped at/.test(clean), kind: "text", numbered: !plain }
}

/** The entries between `<entries>` tags of a directory read. */
export function directoryEntries(text: string): string[] {
  const body = /<entries>\n?([\s\S]*?)\n?<\/entries>/.exec(text.replace(ANSI, ""))?.[1] ?? ""
  return body.split("\n").filter((line) => line.length > 0)
}

export type Listing = { entries: string[]; hidden: number; dirs: number }

/** Names one per line, directories with a trailing slash, then maybe a `[output truncated: N more …]` note. */
export function parseListing(text: string): Listing {
  const lines = text.replace(ANSI, "").replace(/\s+$/, "").split("\n").filter((line) => line.trim().length > 0)
  const entries = lines.filter((line) => !NOTE.test(line) && line.trim() !== "(empty)" && !/^No files found/.test(line.trim()))
  const hidden = /\[output truncated: ([\d,]+) more/.exec(text)
  return { entries, hidden: hidden ? number(hidden[1]!) : 0, dirs: entries.filter((entry) => entry.endsWith("/")).length }
}

export type GrepFile = { path: string; matches: Array<{ line: number; text: string }>; count: number }
export type Grouped = { files: GrepFile[]; matches: number; capped: boolean }

/** `path:line:text` rows grouped by file, files in order of first match. */
export function parseGrep(text: string): Grouped {
  const files = new Map<string, GrepFile>()
  let matches = 0
  for (const row of text.replace(ANSI, "").split("\n")) {
    const hit = /^(.+?):(\d+):(.*)$/.exec(row)
    if (!hit) continue
    matches++
    const file = files.get(hit[1]!) ?? { path: hit[1]!, matches: [], count: 0 }
    files.set(hit[1]!, file)
    file.count++
    file.matches.push({ line: Number(hit[2]), text: hit[3]! })
  }
  return { files: [...files.values()], matches, capped: /\[output truncated: more than/.test(text) }
}

const RUNNER = /(?:^|[\s;&|(])(?:(?:bun|npm|pnpm|yarn)\s+(?:run\s+)?test|bun\s+test|vitest|jest|pytest|cargo\s+test|go\s+test|mocha|node\s+--test)\b/
const COMPILER = /(?:^|[\s;&|(])(?:tsc|tsgo|bunx?\s+tsc|npx\s+tsc|pnpm\s+(?:exec\s+)?tsc)\b/

/**
 * `241 pass · 0 fail` for a test run, `no errors` / `12 errors` for a type check: the one line that says what the output says.
 * Undefined when the command is not a runner or compiler this knows, or its summary is not in the text.
 */
export function shellSummary({ command, text, exitCode }: { command: string; text: string; exitCode: number | undefined }): string | undefined {
  const clean = text.replace(ANSI, "")
  if (RUNNER.test(command)) {
    const pass = /^\s*(\d+) pass\b/m.exec(clean)
    const fail = /^\s*(\d+) fail\b/m.exec(clean)
    if (pass || fail) return `${pass?.[1] ?? 0} pass · ${fail?.[1] ?? 0} fail`
    const jest = /^\s*Tests?:?\s+(.*)$/m.exec(clean)?.[1]
    if (jest) {
      const passed = /(\d[\d,]*) passed/.exec(jest)?.[1]
      const failed = /(\d[\d,]*) failed/.exec(jest)?.[1]
      if (passed || failed) return `${passed ?? 0} pass · ${failed ?? 0} fail`
    }
    const python = /=+ (?:(\d+) failed,? ?)?(?:(\d+) passed)?.* in [\d.]+s/.exec(clean)
    if (python && (python[1] || python[2])) return `${python[2] ?? 0} pass · ${python[1] ?? 0} fail`
    const cargo = /test result: \w+\. (\d+) passed; (\d+) failed/.exec(clean)
    if (cargo) return `${cargo[1]} pass · ${cargo[2]} fail`
    return undefined
  }
  if (COMPILER.test(command)) {
    const found = /Found (\d+) errors?/.exec(clean)
    const counted = clean.split("\n").filter((line) => /\berror TS\d+:/.test(line)).length
    const errors = found ? Number(found[1]) : counted
    if (errors > 0) return `${errors} error${errors === 1 ? "" : "s"}`
    if (exitCode === 0 && clean.trim() === "") return "no errors"
  }
  return undefined
}

export type WebInfo = { title: string; host: string; path: string; size: string; status: number | undefined; lines: string[] }

/** `12.4 KB` / `3 B` / `1.2 MB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`
  if (bytes < 1_000_000) return `${(bytes / 1000).toFixed(bytes < 10_000 ? 1 : 0).replace(/\.0$/, "")} KB`
  return `${(bytes / 1_000_000).toFixed(1).replace(/\.0$/, "")} MB`
}

/** A fetched page: its first heading (or first line) as the title, where it came from, its size and the text after the title. */
export function webInfo({ detail, text, meta }: { detail: string; text: string; meta: Readonly<Record<string, unknown>> | undefined }): WebInfo {
  const url = (() => {
    try {
      return new URL(typeof meta?.finalUrl === "string" ? meta.finalUrl : detail)
    } catch {
      return undefined
    }
  })()
  const body = text.replace(ANSI, "").replace(/^HTTP \d+[^\n]*\n\n/, "")
  const lines = body.split("\n")
  const at = lines.findIndex((line) => line.trim().length > 0)
  // Only a heading names the page; any other first line is just text.
  const heading = at >= 0 ? /^#{1,6}\s+(.+)$/.exec(lines[at]!.trim())?.[1]?.trim() : undefined
  const first = heading ?? ""
  const bytes = typeof meta?.bytes === "number" ? meta.bytes : Buffer.byteLength(text)
  const path = url ? `${url.pathname === "/" ? "" : url.pathname}${url.search}` : ""
  return {
    title: first,
    host: url?.hostname.replace(/^www\./, "") ?? detail,
    path,
    size: formatBytes(bytes),
    status: typeof meta?.status === "number" ? meta.status : undefined,
    lines: lines.slice(heading ? at + 1 : Math.max(0, at)).filter((line) => line.trim().length > 0 && !line.trim().startsWith("```")),
  }
}

/** `object · 14 keys`, `array · 20 items`, `text · 2.1 KB`: what shape an MCP or custom tool's result has, without drawing it. */
export function resultShape(text: string): string {
  const body = text.replace(ANSI, "").trim()
  if (!body) return "empty"
  if (body.length < 400_000 && (body.startsWith("{") || body.startsWith("["))) {
    try {
      const value: unknown = JSON.parse(body)
      if (Array.isArray(value)) return `array · ${value.length} item${value.length === 1 ? "" : "s"}`
      if (value && typeof value === "object") {
        const keys = Object.keys(value).length
        return `object · ${keys} key${keys === 1 ? "" : "s"}`
      }
    } catch {
      // Not JSON after all: it is text.
    }
  }
  return `text · ${formatBytes(Buffer.byteLength(body))}`
}

/**
 * What a shell printed when it is one JSON value: `object · 4 keys` or `array · 20 items` when it parses, `json · 1,155 lines` when it
 * is shaped like one but the shell cut its middle (`{` first, `}` last). Undefined for anything else, which is drawn as rows.
 */
export function jsonShape(lines: readonly string[]): string | undefined {
  const whole = resultShape(lines.join("\n"))
  if (/^(object|array) · /.test(whole)) return whole
  const first = lines[0]?.trimStart() ?? ""
  const last = lines.at(-1)?.trimEnd() ?? ""
  if (lines.length < 3 || !/^[{[]/.test(first) || !/[}\]]$/.test(last)) return undefined
  return `json · ${lines.length.toLocaleString("en-US")} lines`
}

/** The call arguments a card draws from, picked out of the call's JSON; nothing else is kept. */
export type CallArgs = { pattern?: string; agent?: string; model?: string; background?: boolean; description?: string; written?: WrittenText }
/**
 * A write's content from its call: the first `WRITTEN_LINES` lines (at most `WRITTEN_BYTES`) and how many it has in all; `cut`
 * when the event kept only the start of the call (a call's arguments are stored up to 4000 characters), so the total is unknown.
 */
export type WrittenText = { lines: string[]; total: number; cut?: true }
const WRITTEN_LINES = 400
const WRITTEN_BYTES = 64 * 1024

/** The `content` string of a call's arguments that were cut off: decoded up to where the text stops, its last partial line dropped. */
function cutContent(input: string): string | undefined {
  const start = /"content"\s*:\s*"/.exec(input)
  if (!start) return undefined
  let out = ""
  for (let at = start.index + start[0].length; at < input.length; at++) {
    const char = input[at]!
    if (char === "\"") return out
    if (char !== "\\") {
      out += char
      continue
    }
    const next = input[at + 1]
    if (next === undefined) break
    if (next === "u") {
      const code = input.slice(at + 2, at + 6)
      if (!/^[0-9a-fA-F]{4}$/.test(code)) break
      out += String.fromCharCode(Number.parseInt(code, 16))
      at += 5
      continue
    }
    out += ({ n: "\n", t: "\t", r: "\r", b: "\b", f: "\f" } as Record<string, string>)[next] ?? next
    at++
  }
  const whole = out.lastIndexOf("\n")
  return whole < 0 ? undefined : out.slice(0, whole + 1)
}

function writtenText(content: string, cut = false): WrittenText {
  const all = content === "" ? [] : content.replace(/\n$/, "").split("\n")
  const lines: string[] = []
  let bytes = 0
  for (const line of all) {
    bytes += line.length + 1
    if (lines.length >= WRITTEN_LINES || bytes > WRITTEN_BYTES) break
    lines.push(line)
  }
  return { lines, total: all.length, ...(cut ? { cut: true as const } : {}) }
}

export function callArgs(tool: string, input: string): CallArgs | undefined {
  try {
    const args = JSON.parse(input) as Record<string, unknown> | null
    if (!args || typeof args !== "object") return undefined
    // A longer value is cut to `max` cells and says so: a header never shows a pattern or a name that just stops.
    const text = (key: string, max = 120) => {
      const value = typeof args[key] === "string" && args[key] ? (args[key] as string).split("\n")[0]! : undefined
      return value && value.length > max ? `${value.slice(0, max - 1)}…` : value
    }
    if (tool === "grep" || tool === "glob") {
      // A glob may carry a list: the header shows every pattern, in order, as one line.
      const listed = tool === "glob" && Array.isArray(args.patterns) ? args.patterns.filter((entry): entry is string => typeof entry === "string" && entry.length > 0) : []
      const joined = [text("pattern"), ...listed].filter(Boolean).join(", ")
      const pattern = joined.length > 120 ? `${joined.slice(0, 119)}…` : joined
      return pattern ? { pattern } : undefined
    }
    if (tool === "task") {
      const agent = text("agent", 64) ?? text("subagent_type", 64)
      const model = text("model", 80)
      const description = text("description", 80)
      return { ...(agent ? { agent } : {}), ...(model ? { model } : {}), ...(description ? { description } : {}), ...(args.background === true ? { background: true } : {}) }
    }
    // The card shows what a write put in the file: its tool says only the path and the size.
    if (tool === "write" && typeof args.content === "string") return { written: writtenText(args.content) }
    return undefined
  } catch {
    // Arguments stored cut off are not JSON: a write still shows the start of what it wrote.
    const content = tool === "write" ? cutContent(input) : undefined
    return content ? { written: writtenText(content, true) } : undefined
  }
}
