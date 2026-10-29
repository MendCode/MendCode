import fs from "node:fs"
import path from "node:path"

/**
 * `/export [markdown|json|html] [path] [--copy] [--force]`: the text of `session.export` goes to a file inside the session's
 * directory (default `<title-slug>.md`, `.json` or `.html`) or, with `--copy`, to the clipboard through the terminal (OSC 52).
 * Nothing leaves the directory, and an existing file is never overwritten unless `--force` is given (the default name
 * picks the next free `-2`, `-3`… instead).
 */
export type ExportFormat = "markdown" | "json" | "html"
export type ExportRequest = { format: ExportFormat; path?: string; copy: boolean; force: boolean; editor?: boolean; noSave?: boolean; reasoning?: boolean; toolDetails?: boolean; assistantMetadata?: boolean; timestamps?: boolean; sanitize?: boolean }

export const EXPORT_USAGE = "usage: /export [markdown|json|html] [path] [--copy|--editor|--no-save] [--reasoning] [--no-tools] [--metadata] [--timestamps] [--sanitize] [--force]"

const FORMAT_WORDS: Readonly<Record<string, ExportFormat>> = { markdown: "markdown", md: "markdown", json: "json", html: "html" }
const EXTENSION: Readonly<Record<ExportFormat, string>> = { markdown: "md", json: "json", html: "html" }
const SLUG_MAX = 60

/** The command's arguments; an unknown flag is an error, never part of a path. */
export function parseExportArgs(args: string): ExportRequest | { error: string } {
  const words = args.split(/\s+/).filter(Boolean)
  let copy = false
  let force = false
  const options: Partial<ExportRequest> = {}
  const rest: string[] = []
  for (const word of words) {
    if (word === "--copy") copy = true
    else if (word === "--force") force = true
    else if (word === "--editor") options.editor = true
    else if (word === "--no-save") { options.noSave = true; options.editor = true }
    else if (word === "--reasoning") options.reasoning = true
    else if (word === "--no-reasoning") options.reasoning = false
    else if (word === "--tools") options.toolDetails = true
    else if (word === "--no-tools") options.toolDetails = false
    else if (word === "--metadata") options.assistantMetadata = true
    else if (word === "--timestamps") options.timestamps = true
    else if (word === "--sanitize") options.sanitize = true
    else if (word.startsWith("--")) return { error: `unknown option ${word} · ${EXPORT_USAGE}` }
    else rest.push(word)
  }
  let format: ExportFormat = "markdown"
  const named = rest[0] ? FORMAT_WORDS[rest[0].toLowerCase()] : undefined
  if (named) {
    format = named
    rest.shift()
  }
  const target = rest.join(" ")
  if (copy && target) return { error: `--copy takes no path · ${EXPORT_USAGE}` }
  if (copy && options.editor || options.noSave && target) return { error: `choose one destination · ${EXPORT_USAGE}` }
  return { format, copy, force, ...options, ...(target ? { path: target } : {}) }
}

/** `Fix the flaky reconnect!` becomes `fix-the-flaky-reconnect`; nothing usable becomes `session`. */
export function titleSlug(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, "")
  return slug || "session"
}

export const defaultExportName = (title: string, format: ExportFormat) => `${titleSlug(title)}.${EXTENSION[format]}`

export type ExportWrite = { ok: true; path: string } | { ok: false; error: string }

const inside = (root: string, target: string) => {
  const relative = path.relative(root, target)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

/** `name-2.ext`, `name-3.ext`… until one does not exist. */
function freeName(file: string): string {
  if (!fs.existsSync(file)) return file
  const { dir, name, ext } = path.parse(file)
  for (let n = 2; n < 1000; n++) {
    const candidate = path.join(dir, `${name}-${n}${ext}`)
    if (!fs.existsSync(candidate)) return candidate
  }
  return file
}

/** Writes `text` under `cwd`; the returned path is relative to it. Refuses anything outside `cwd`, symlinks included. */
export function writeExport(input: { cwd: string; text: string; target: string; explicit: boolean; force: boolean }): ExportWrite {
  try {
    const root = fs.realpathSync(input.cwd)
    const wanted = path.resolve(root, input.target)
    if (!inside(root, wanted)) return { ok: false, error: "[EXPORT]: the file must be inside the working directory" }
    let parent = path.dirname(wanted)
    while (!fs.existsSync(parent)) parent = path.dirname(parent)
    if (!inside(root, fs.realpathSync(parent))) return { ok: false, error: "[EXPORT]: the file must be inside the working directory" }
    fs.mkdirSync(path.dirname(wanted), { recursive: true })
    if (!inside(root, fs.realpathSync(path.dirname(wanted)))) return { ok: false, error: "[EXPORT]: the file must be inside the working directory" }
    if (fs.existsSync(wanted) && fs.lstatSync(wanted).isDirectory()) return { ok: false, error: `[EXPORT]: ${path.relative(root, wanted)} is a directory` }
    const file = input.explicit || input.force ? wanted : freeName(wanted)
    try { if (fs.lstatSync(file).isSymbolicLink()) return { ok: false, error: "[EXPORT]: the file cannot be a symlink" } } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error }
    if (input.explicit && !input.force && fs.existsSync(file)) return { ok: false, error: `[EXPORT]: ${path.relative(root, file)} exists · add --force to overwrite it` }
    fs.writeFileSync(file, input.text.endsWith("\n") ? input.text : `${input.text}\n`, { flag: input.force ? "w" : "wx" })
    return { ok: true, path: path.relative(root, file) }
  } catch (error) {
    return { ok: false, error: `[EXPORT]: could not write the file: ${error instanceof Error ? error.message : String(error)}` }
  }
}
