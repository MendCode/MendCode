import type { FileDiff } from "./context"

/**
 * File triage before a review (docs/pr-review.md, "Data files and readers"): which changed files are data, outputs or generated
 * text rather than code a reviewer reads line by line. Such a file's diff does not go to the review pass whole: a cheap reader
 * (readers.ts) summarizes it, and the review pass gets the summary and reads the file with its tools when a finding depends on it.
 *
 * Pure and deterministic: names, extensions, the base branch's `.gitattributes` (never the PR's own, which could mark its code as
 * generated to keep it from the review pass) and the added lines themselves. A small change always stays with the review pass.
 */

export type TriageReason = "binary" | "lockfile" | "minified" | "snapshot" | "asset" | "generated" | "data" | "fixture" | "numeric"

export const TRIAGE_TEXT: Record<TriageReason, string> = {
  binary: "binary file",
  lockfile: "lockfile",
  minified: "minified or source map",
  snapshot: "test snapshot",
  asset: "asset",
  generated: "marked generated in .gitattributes",
  data: "data or results file",
  fixture: "large fixture",
  numeric: "mostly numbers or repeated structure",
}

/** A change smaller than this (added plus removed lines) stays with the review pass whatever it is: summarizing it costs more than reading it. */
export const TRIAGE_MIN_LINES = 40
/** A data-format file (JSON, CSV, ...) outside a data directory goes to a reader from this many changed lines. */
export const DATA_MIN_LINES = 200

const LOCKFILES = new Set(["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb", "Cargo.lock", "poetry.lock", "uv.lock", "Pipfile.lock", "Gemfile.lock", "composer.lock", "go.sum", "flake.lock", "mix.lock", "pubspec.lock", "Podfile.lock", "packages.lock.json", "gradle.lockfile"])
/** Data-format names that are a project's configuration, read by the review pass like code. */
const MANIFESTS = new Set(["package.json", "composer.json", "deno.json", "jsr.json", "app.json", "manifest.json", "renovate.json", "biome.json", ".eslintrc.json", "angular.json", "vercel.json", "turbo.json", "lerna.json", "nx.json", "project.json", "launch.json", "settings.json", "devcontainer.json", "pyproject.toml"])
const DATA_EXTENSIONS = new Set(["json", "jsonl", "ndjson", "geojson", "csv", "tsv", "psv", "parquet", "arrow", "xml", "npy", "npz", "pkl", "h5", "hdf5"])
const ASSET_EXTENSIONS = new Set(["svg", "png", "jpg", "jpeg", "gif", "webp", "avif", "ico", "bmp", "tif", "tiff", "pdf", "woff", "woff2", "ttf", "otf", "eot", "mp3", "mp4", "wav", "ogg", "webm", "mov", "zip", "gz", "tgz", "bz2", "xz", "7z", "jar", "wasm"])
const DATA_DIR = /(^|\/)(results?|outputs?|benchmarks?|fixtures?|testdata|data|datasets?|samples?|snapshots?|generated|artifacts?|golden|goldens)\//i
const FIXTURE_DIR = /(^|\/)(fixtures?|testdata|__fixtures__|golden|goldens)\//i
/**
 * A line that holds a value of data, not logic: an optional quoted key, then numbers, literals, brackets and separators. A string
 * value is not data here: `"name": "value"` lines are what configuration and translations are made of, read like code.
 */
const DATA_LINE = /^\s*(?:"[^"\n]{0,200}"\s*:\s*)?(?:[-+]?(?:\d[\d_]*\.?\d*(?:[eE][-+]?\d+)?|\.\d+)|true|false|null|NaN|-?Infinity|None|[[\]{}(),;:\s])*[,\s]*$/

export type TriageStats = { added: number; removed: number; addedChars: number; longest: number }

/** The added and removed lines of a file's diff, without the `+`/`-` marks; the added text's size and its longest line. */
export function diffLines(file: Pick<FileDiff, "text">): { added: string[]; removed: string[]; stats: TriageStats } {
  const added: string[] = []
  const removed: string[] = []
  let inHunk = false
  let addedChars = 0
  let longest = 0
  for (const line of file.text.split("\n")) {
    if (line.startsWith("@@")) { inHunk = true; continue }
    if (!inHunk) continue
    if (line.startsWith("+")) { const text = line.slice(1); added.push(text); addedChars += text.length + 1; if (text.length > longest) longest = text.length }
    else if (line.startsWith("-")) removed.push(line.slice(1))
  }
  return { added, removed, stats: { added: added.length, removed: removed.length, addedChars, longest } }
}

export const isBinaryDiff = (file: Pick<FileDiff, "text">) => /^(Binary files .* differ|GIT binary patch)$/m.test(file.text.slice(0, 4_000))

const baseName = (file: string) => file.slice(file.lastIndexOf("/") + 1)
const extension = (file: string) => { const name = baseName(file); const dot = name.lastIndexOf("."); return dot > 0 ? name.slice(dot + 1).toLowerCase() : "" }

/** The added lines' share that is data (`DATA_LINE`), and how few distinct shapes they have once numbers and strings are blanked. */
export function contentShape(lines: readonly string[]): { dataShare: number; shapeShare: number } {
  const counted = lines.filter((line) => line.trim()).slice(0, 5_000)
  if (!counted.length) return { dataShare: 0, shapeShare: 1 }
  const data = counted.filter((line) => line.length <= 400 && DATA_LINE.test(line)).length
  const shapes = new Set(counted.map((line) => line.replace(/"[^"]*"/g, "s").replace(/[-+]?\d[\d.eE+-]*/g, "0").replace(/\s+/g, " ")))
  return { dataShare: data / counted.length, shapeShare: shapes.size / counted.length }
}

/**
 * The `linguist-generated` and `linguist-vendored` rules of a `.gitattributes` text, in order (the last match wins, as in git). A
 * pattern without `/` matches a name at any depth; `dir/` matches everything under it.
 */
export function generatedRules(text: string | undefined): Array<{ glob: Bun.Glob; on: boolean }> {
  if (!text) return []
  const rules: Array<{ glob: Bun.Glob; on: boolean }> = []
  for (const raw of text.split("\n").slice(0, 2_000)) {
    const line = raw.trim()
    if (!line || line.startsWith("#")) continue
    const [pattern, ...attributes] = line.split(/\s+/)
    let on: boolean | undefined
    for (const attribute of attributes) {
      const match = /^(-|!)?linguist-(generated|vendored)(?:=(true|false))?$/.exec(attribute)
      if (match) on = !match[1] && match[3] !== "false"
    }
    if (on === undefined || !pattern) continue
    const anchored = pattern.startsWith("/") ? pattern.slice(1) : pattern
    const glob = anchored.endsWith("/") ? `${anchored}**` : anchored
    try { rules.push({ glob: new Bun.Glob(pattern.replace(/\/$/, "").includes("/") ? glob : `**/${glob}`), on }) } catch { /* an invalid pattern marks nothing */ }
  }
  return rules
}

/** Whether the base branch's `.gitattributes` rules mark `file` generated or vendored. */
export function markedGenerated(file: string, rules: ReturnType<typeof generatedRules>): boolean {
  let marked = false
  for (const rule of rules) if (rule.glob.match(file)) marked = rule.on
  return marked
}

/**
 * Why `file` goes to a reader instead of the review pass, or undefined when the review pass reads its diff. Order: binary and asset
 * diffs (which carry no reviewable lines), then a change under `TRIAGE_MIN_LINES` stays, then lockfiles, minified text, snapshots,
 * what the base marks generated, data formats, large fixtures, and last the content: mostly data lines or one repeated shape.
 */
export function triageFile(file: Pick<FileDiff, "path" | "text" | "deleted">, rules: ReturnType<typeof generatedRules> = []): TriageReason | undefined {
  const ext = extension(file.path)
  const name = baseName(file.path)
  if (isBinaryDiff(file)) return "binary"
  const { added, stats } = diffLines(file)
  const changed = stats.added + stats.removed
  if (ASSET_EXTENSIONS.has(ext) && changed >= TRIAGE_MIN_LINES) return "asset"
  if (changed < TRIAGE_MIN_LINES) return undefined
  if (LOCKFILES.has(name)) return "lockfile"
  if (/\.min\.(js|css|mjs)$|\.map$/i.test(name) || (stats.added >= 3 && stats.addedChars / stats.added > 500)) return "minified"
  if (ext === "snap" || /(^|\/)__snapshots__\//.test(file.path)) return "snapshot"
  if (markedGenerated(file.path, rules)) return "generated"
  const configuration = MANIFESTS.has(name) || /(^|\/)tsconfig[^/]*\.json$/.test(file.path) || file.path.startsWith(".github/") || file.path.startsWith(".mendcode/")
  if (configuration) return undefined
  if (DATA_EXTENSIONS.has(ext) && (changed >= DATA_MIN_LINES || DATA_DIR.test(file.path))) return "data"
  if (FIXTURE_DIR.test(file.path) && changed >= DATA_MIN_LINES) return "fixture"
  if (stats.added >= DATA_MIN_LINES) {
    const shape = contentShape(added)
    if (shape.dataShare >= 0.8 || (stats.added >= 500 && shape.shapeShare <= 0.03)) return "numeric"
  }
  return undefined
}

/**
 * The part of `triageFile` that needs no diff text: what `git diff --numstat` (path, lines added and removed, binary) already says.
 * A file this names goes to readers without its whole diff being fetched; a file it does not name may still be data by its content
 * (`triageFile` decides once its diff is read).
 */
export function triageByStat({ path, added, removed, binary }: { path: string; added: number; removed: number; binary: boolean }, rules: ReturnType<typeof generatedRules> = []): TriageReason | undefined {
  if (binary) return "binary"
  const ext = extension(path)
  const name = baseName(path)
  const changed = added + removed
  if (ASSET_EXTENSIONS.has(ext) && changed >= TRIAGE_MIN_LINES) return "asset"
  if (changed < TRIAGE_MIN_LINES) return undefined
  if (LOCKFILES.has(name)) return "lockfile"
  if (/\.min\.(js|css|mjs)$|\.map$/i.test(name)) return "minified"
  if (ext === "snap" || /(^|\/)__snapshots__\//.test(path)) return "snapshot"
  if (markedGenerated(path, rules)) return "generated"
  const configuration = MANIFESTS.has(name) || /(^|\/)tsconfig[^/]*\.json$/.test(path) || path.startsWith(".github/") || path.startsWith(".mendcode/")
  if (configuration) return undefined
  if (DATA_EXTENSIONS.has(ext) && (changed >= DATA_MIN_LINES || DATA_DIR.test(path))) return "data"
  if (FIXTURE_DIR.test(path) && changed >= DATA_MIN_LINES) return "fixture"
  return undefined
}

export type TriagedFile ={ file: FileDiff; reason: TriageReason; stats: TriageStats }

/** The files of a diff split into what the review pass reads and what goes to readers, in diff order. */
export function triageFiles(files: readonly FileDiff[], attributes?: string | undefined): { code: FileDiff[]; data: TriagedFile[] } {
  const rules = generatedRules(attributes)
  const code: FileDiff[] = []
  const data: TriagedFile[] = []
  for (const file of files) {
    const reason = triageFile(file, rules)
    if (reason) data.push({ file, reason, stats: diffLines(file).stats })
    else code.push(file)
  }
  return { code, data }
}
