import { readdir, readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { languageOf } from "./scan"
import { MAX_FILE_BYTES, type Language, type WorkspacePackage } from "./types"
import { workspacePackage } from "./workspace"

export type WalkedFile = { mtimeMs: number; ctimeMs: number; size: number; language: Language }
export type Walk = { files: Map<string, WalkedFile>; partial: boolean; packages: WorkspacePackage[] }

const SKIPPED_DIRS: ReadonlySet<string> = new Set(["node_modules", ".git", "dist", "build", "graft", "__pycache__", "coverage"])

type Ignore = { glob: Bun.Glob; anchored: boolean; dirOnly: boolean; negated: boolean; base: string }

/** Ordered gitignore rules, relative to the directory containing the ignore file. */
export function parseGitignore(text: string, base = ""): Ignore[] {
  const rules: Ignore[] = []
  for (const raw of text.split("\n")) {
    let line = raw.replace(/\r$/, "").replace(/(?<!\\) +$/, "")
    if (line === "" || line.startsWith("#")) continue
    const negated = line.startsWith("!")
    if (negated) line = line.slice(1)
    // Bun treats a leading ! as glob negation too; git's escaped ! must stay literal.
    if (line.startsWith("!")) line = `\\${line}`
    const dirOnly = line.endsWith("/")
    if (dirOnly) line = line.slice(0, -1)
    const anchored = line.startsWith("/") || line.includes("/")
    if (line.startsWith("/")) line = line.slice(1)
    if (line === "") continue
    rules.push({ glob: new Bun.Glob(line), anchored, dirOnly, negated, base })
  }
  return rules
}

function ignored({ rules, rel, name, isDir }: { rules: Ignore[]; rel: string; name: string; isDir: boolean }): boolean {
  let result = false
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue
    if (rule.base && !rel.startsWith(`${rule.base}/`)) continue
    const scoped = rule.base ? rel.slice(rule.base.length + 1) : rel
    if (rule.glob.match(rule.anchored ? scoped : name)) result = !rule.negated
  }
  return result
}

/** Deterministic source walk; excluded directories are never followed, including symlinks. */
export async function walkProject({ cwd, signal, maxFiles }: { cwd: string; signal: AbortSignal; maxFiles: number }): Promise<Walk> {
  const files = new Map<string, WalkedFile>()
  const packages: WorkspacePackage[] = []
  let partial = false
  const pending: Array<{ dir: string; rules: Ignore[] }> = [{ dir: "", rules: [] }]
  while (pending.length > 0) {
    if (signal.aborted) throw new DOMException("aborted", "AbortError")
    const { dir: relDir, rules: inherited } = pending.pop()!
    const entries = await readdir(join(cwd, relDir), { withFileTypes: true }).catch(() => undefined)
    if (!entries) { partial = true; continue }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    const gitignore = entries.some((entry) => entry.name === ".gitignore" && entry.isFile())
      ? await readFile(join(cwd, relDir, ".gitignore"), "utf8").catch(() => { partial = true; return "" }) : ""
    const rules = [...inherited, ...parseGitignore(gitignore, relDir)]
    if (entries.some((entry) => entry.name === "package.json" && entry.isFile())) {
      const manifest = join(cwd, relDir, "package.json")
      const info = await stat(manifest).catch(() => undefined)
      if (info && info.size <= MAX_FILE_BYTES) {
        const pkg = workspacePackage(await readFile(manifest, "utf8").catch(() => ""), relDir)
        if (pkg) packages.push(pkg)
      }
    }
    const hasCargo = entries.some((entry) => entry.name === "Cargo.toml")
    const subdirs: string[] = []
    for (const entry of entries) {
      if (signal.aborted) throw new DOMException("aborted", "AbortError")
      const rel = relDir === "" ? entry.name : `${relDir}/${entry.name}`
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(entry.name) || entry.name.startsWith(".") || (entry.name === "target" && hasCargo)) continue
        if (ignored({ rules, rel, name: entry.name, isDir: true })) continue
        subdirs.push(rel)
        continue
      }
      if (!entry.isFile()) continue
      const language = languageOf(entry.name)
      if (!language || entry.name.includes(".min.")) continue
      if (ignored({ rules, rel, name: entry.name, isDir: false })) continue
      const info = await stat(join(cwd, rel)).catch(() => undefined)
      if (!info || info.size > MAX_FILE_BYTES) { partial = true; continue }
      if (files.size >= maxFiles) return { files, partial: true, packages }
      files.set(rel, { mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs, size: info.size, language })
    }
    for (let i = subdirs.length - 1; i >= 0; i--) pending.push({ dir: subdirs[i]!, rules })
  }
  return { files, partial, packages }
}
