import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"

/**
 * Project identity for moving sessions between machines: the normalized git remote plus the path inside the repository.
 * `git@host:Org/Repo.git`, `https://user@host/org/repo/` and `ssh://git@host:22/org/repo` all become `host/org/repo`.
 */
export function normalizeGitRemote(url: string): string | undefined {
  const text = url.trim()
  if (!text) return undefined
  let host: string
  let rest: string
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(text)
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    try {
      const parsed = new URL(text)
      host = parsed.hostname
      rest = parsed.pathname
    } catch { return undefined }
  } else if (scp) {
    host = scp[1]!
    rest = scp[2]!
  } else return undefined
  const repo = rest.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/i, "")
  if (!host || !repo) return undefined
  return `${host.toLowerCase()}/${repo.toLowerCase()}`
}

export type ProjectIdentity = { id?: string; url?: string; top?: string; rel: string; directory: string }
export type RemoteRepo = { top: string; url?: string }
export type PathRule = { from: string; to: string }
export type ProjectMapping = { directory: string; how: "path-map" | "git" | "clone" } | { directory?: undefined; reason: string; clone?: { url: string; name: string; rel: string } }

const trimSlash = (value: string) => value.length > 1 ? value.replace(/\/+$/, "") : value

/** `--path-map /Users/x/Code=/home/x/code`: the longest matching prefix wins. */
export function parsePathRule(text: string): PathRule {
  const at = text.indexOf("=")
  const from = trimSlash(text.slice(0, at))
  const to = trimSlash(text.slice(at + 1))
  if (at < 1 || !path.isAbsolute(from) || !to.startsWith("/")) throw new Error("--path-map needs ABSOLUTE_LOCAL=ABSOLUTE_REMOTE")
  return { from, to }
}

export function applyPathRule(directory: string, rules: readonly PathRule[]): string | undefined {
  const rule = [...rules].sort((a, b) => b.from.length - a.from.length).find((candidate) => directory === candidate.from || directory.startsWith(`${candidate.from}/`))
  return rule ? `${rule.to}${directory.slice(rule.from.length)}` : undefined
}

/** Decides where a local project lives on the host: an explicit rule first, then a clone with the same git remote, then (only if asked) a fresh clone. */
export function mapProject(input: { project: ProjectIdentity; rules: readonly PathRule[]; repos: readonly RemoteRepo[]; cloneMissing: boolean; cloneRoot: string }): ProjectMapping {
  const { project } = input
  const ruled = applyPathRule(project.directory, input.rules)
  if (ruled) return { directory: ruled, how: "path-map" }
  if (!project.id) return { reason: "not a git project with a remote, and no --path-map rule matches" }
  const repo = input.repos.find((candidate) => candidate.url && normalizeGitRemote(candidate.url) === project.id)
  if (repo) return { directory: project.rel ? `${repo.top}/${project.rel}` : repo.top, how: "git" }
  const name = project.id.split("/").at(-1)!.replace(/[^A-Za-z0-9._-]/g, "-")
  if (!input.cloneMissing || !project.url || !/^[A-Za-z0-9._-]+$/.test(name) || name.startsWith(".")) return { reason: `no clone of ${project.id} on the host (use --clone-missing or --path-map)` }
  return { reason: "clone needed", clone: { url: project.url, name, rel: project.rel } }
}

/** What a setup run has already done for one saved remote; never a secret. Lets an interrupted run continue and a repeated one skip finished work. */
export type SetupLedger = { version: 1; host: string; settings?: { at: number; importId?: string }; acpAgents?: { at: number; names: string[] }; sessions: Record<string, { at: number; remoteId?: string; directory: string; truncated?: boolean }> }

export const ledgerFile = (dir: string, name: string) => path.join(dir, "remote-setup", `${name}.json`)

export function readLedger(dir: string, name: string, host: string): SetupLedger {
  try {
    const value = JSON.parse(readFileSync(ledgerFile(dir, name), "utf8")) as SetupLedger
    if (value?.version === 1 && value.host === host && value.sessions && typeof value.sessions === "object") return value
  } catch {}
  return { version: 1, host, sessions: {} }
}

export function writeLedger(dir: string, name: string, ledger: SetupLedger) {
  const file = ledgerFile(dir, name)
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 })
  chmodSync(temporary, 0o600)
  renameSync(temporary, file)
}
