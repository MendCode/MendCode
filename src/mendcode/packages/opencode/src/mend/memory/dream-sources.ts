import { existsSync } from "fs"
import { readdir, readFile, stat } from "fs/promises"
import path from "path"
import { redactMemoryText } from "./proposals"

export type DreamSourcePermissions = {
  sessions?: boolean
  git?: boolean
  files?: boolean
  allowRawDiff?: boolean
  roots?: string[]
  maxFiles?: number
  maxBytes?: number
}

export type DreamEvidenceRef = {
  id: string
  sourceType: "memory" | "proposal" | "dream-log" | "session" | "git" | "file"
  sourcePath: string | null
  excerpt: string
  hash: string | null
  redacted: boolean
}

const excludedPathPattern = /(^|\/)(\.git|node_modules|dist|build|coverage|\.next|\.cache)(\/|$)|(^|\/)\.env[^/]*$|(^|\/)[^/]*\.env$|\b(secret|token|credential|password)\b/i

export function redactDreamExcerpt(text: string) {
  const redacted = redactMemoryText(text)
  return { excerpt: redacted.text.slice(0, 2_000), redacted: redacted.redactions.length > 0, redactions: redacted.redactions }
}

export function isDreamFileAllowed(file: string, roots: string[]) {
  if (!roots.length) return false
  const resolved = path.resolve(file)
  const inside = roots.some((root) => {
    const relative = path.relative(path.resolve(root), resolved)
    return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative))
  })
  if (!inside) return false
  return !excludedPathPattern.test(resolved)
}

async function walkAllowedFiles(root: string, limit: number, maxBytes: number) {
  const out: string[] = []
  async function walk(current: string) {
    if (out.length >= limit || !isDreamFileAllowed(current, [root])) return
    const entries = await readdir(current, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (out.length >= limit) break
      const file = path.join(current, entry.name)
      if (!isDreamFileAllowed(file, [root])) continue
      if (entry.isDirectory()) await walk(file)
      else if (/^(README|AGENTS|package|pnpm-workspace|bunfig)|\.(md|json|toml|yaml|yml)$/i.test(entry.name)) {
        const info = await stat(file).catch(() => null)
        if (info && info.size > 0 && info.size <= maxBytes) out.push(file)
      }
    }
  }
  await walk(root)
  return out
}

export async function collectDreamFileEvidence(permissions: DreamSourcePermissions = {}) {
  if (!permissions.files) return { evidence: [] as DreamEvidenceRef[], skipped: ["filesystem source disabled"] }
  const roots = (permissions.roots ?? []).map((root) => path.resolve(root)).filter((root) => existsSync(root))
  const maxFiles = Math.max(0, Math.min(permissions.maxFiles ?? 8, 50))
  const maxBytes = Math.max(512, Math.min(permissions.maxBytes ?? 32_000, 256_000))
  const evidence: DreamEvidenceRef[] = []
  for (const root of roots) {
    for (const file of await walkAllowedFiles(root, maxFiles - evidence.length, maxBytes)) {
      const text = await readFile(file, "utf8").catch(() => "")
      const redacted = redactDreamExcerpt(text)
      evidence.push({
        id: `file:${file}`,
        sourceType: "file",
        sourcePath: file,
        excerpt: redacted.excerpt,
        hash: `${text.length}:${text.charCodeAt(0) || 0}:${text.charCodeAt(text.length - 1) || 0}`,
        redacted: redacted.redacted,
      })
      if (evidence.length >= maxFiles) break
    }
  }
  return { evidence, skipped: roots.length ? [] : ["no allowed filesystem roots"] }
}

export function allowedDreamGitCommands(permissions: DreamSourcePermissions = {}) {
  if (!permissions.git) return []
  const commands = [
    "git status --short --branch",
    "git rev-parse --show-toplevel HEAD",
    "git branch --show-current",
    "git log --oneline --decorate -n 20",
    "git diff --stat",
    "git diff --name-only",
  ]
  return permissions.allowRawDiff ? [...commands, "git diff --stat"] : commands
}
