import { existsSync } from "fs"
import { mkdir, readFile, readdir, rename, stat, writeFile } from "fs/promises"
import path from "path"
import { memoryPaths } from "./config"
import { publishMemoryWorkspaceEvent } from "./workspace-events"

export type MemoryWorkspaceSource = "current-session" | "historical-session" | "user-added-root" | "imported-root"

export type MemoryWorkspace = {
  id: string
  root: string
  displayName: string
  firstUserMessageAt: string
  lastActiveAt: string
  gitRoot: string | null
  repoFingerprint: string | null
  worktreePath: string | null
  source: MemoryWorkspaceSource
  groupIDs: string[]
  archived: boolean
}

export type MemoryWorkspaceGroup = {
  id: string
  label: string
  root: string | null
  workspaceIDs: string[]
  manual: boolean
  archived: boolean
}

export type MemoryWorkspaceRegistry = {
  version: 0
  updatedAt: string
  defaultGroupRoots: string[]
  workspaces: MemoryWorkspace[]
  groups: MemoryWorkspaceGroup[]
}

const MAX_DISCOVERY_ROOTS = 10
const MAX_DISCOVERY_DIRS = 2_500
const MAX_DISCOVERY_DEPTH = 5
const SKIP_DISCOVERY_DIRS = new Set([
  ".git",
  ".mendcode",
  ".next",
  ".turbo",
  ".venv",
  "dist",
  "node_modules",
])

function registryFile(root?: string) {
  return path.join(memoryPaths(root).globalDir, "graph", "workspaces.json")
}

function workspaceID(root: string, repoFingerprint?: string | null) {
  const stable = (repoFingerprint || path.resolve(root)).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
  return `ws_${stable.slice(0, 80)}`
}

function defaultGroupRoots() {
  const roots = ["/Users/obed/Code"]
  const home = process.env.HOME
  if (home) roots.push(path.join(home, "Code"))
  return [...new Set(roots)]
}

function currentParentDiscoveryRoot(root?: string) {
  const current = memoryPaths(root).root
  const parent = path.dirname(current)
  const home = process.env.HOME
  if (!home) return null
  if (!parent.startsWith(home)) return null
  const name = path.basename(parent)
  return name === "Code" || name === "Downloads" || name === "Documents" ? parent : null
}

function envDiscoveryRoots() {
  return (process.env.MENDCODE_MEMORY_DISCOVERY_ROOTS || "")
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean)
}

function discoveryRoots(registry: MemoryWorkspaceRegistry, root?: string) {
  return [...new Set([
    ...registry.defaultGroupRoots,
    currentParentDiscoveryRoot(root),
    ...envDiscoveryRoots(),
  ].filter((item): item is string => Boolean(item && existsSync(item))))]
    .slice(0, MAX_DISCOVERY_ROOTS)
}

async function projectMemoryMtime(root: string) {
  const files = [
    path.join(root, ".mendcode", "memory", "entries.jsonl"),
    path.join(root, ".mendcode", "memory", "memory_summary.md"),
    path.join(root, ".mendcode", "memory", "index.json"),
  ]
  const stats = await Promise.all(files.map((file) => stat(file).catch(() => null)))
  const present = stats.filter((item): item is Awaited<ReturnType<typeof stat>> => Boolean(item))
  if (!present.length) return null
  return new Date(Math.max(...present.map((item) => item.mtimeMs))).toISOString()
}

function discoveredWorkspace(root: string, lastActiveAt: string, registry: MemoryWorkspaceRegistry): MemoryWorkspace {
  return {
    id: workspaceID(root),
    root,
    displayName: path.basename(root) || root,
    firstUserMessageAt: lastActiveAt,
    lastActiveAt,
    gitRoot: null,
    repoFingerprint: null,
    worktreePath: null,
    source: "imported-root",
    groupIDs: groupIDsForRoot(root, registry.defaultGroupRoots),
    archived: false,
  }
}

async function discoverPersistedMemoryWorkspaces(registry: MemoryWorkspaceRegistry, root?: string) {
  const found: MemoryWorkspace[] = []
  const visited = new Set<string>()
  let scanned = 0
  for (const base of discoveryRoots(registry, root)) {
    const start = path.resolve(base)
    const queue: Array<{ dir: string; depth: number }> = [{ dir: start, depth: 0 }]
    while (queue.length && scanned < MAX_DISCOVERY_DIRS) {
      const next = queue.shift()!
      const dir = path.resolve(next.dir)
      if (visited.has(dir)) continue
      visited.add(dir)
      scanned++
      const mtime = await projectMemoryMtime(dir)
      if (mtime) found.push(discoveredWorkspace(dir, mtime, registry))
      if (next.depth >= MAX_DISCOVERY_DEPTH) continue
      const children = await readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const child of children) {
        if (!child.isDirectory()) continue
        if (SKIP_DISCOVERY_DIRS.has(child.name)) continue
        queue.push({ dir: path.join(dir, child.name), depth: next.depth + 1 })
      }
    }
  }
  return found
}

async function atomicWrite(file: string, text: string) {
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, text)
  await rename(tmp, file)
}

export function normalizeWorkspaceRegistry(input: unknown): MemoryWorkspaceRegistry {
  const raw = typeof input === "object" && input !== null ? input as Record<string, unknown> : {}
  const workspaces = Array.isArray(raw.workspaces) ? raw.workspaces : []
  const groups = Array.isArray(raw.groups) ? raw.groups : []
  return {
    version: 0,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date().toISOString(),
    defaultGroupRoots: Array.isArray(raw.defaultGroupRoots)
      ? raw.defaultGroupRoots.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : defaultGroupRoots(),
    workspaces: workspaces.flatMap((item): MemoryWorkspace[] => {
      if (typeof item !== "object" || item === null) return []
      const record = item as Record<string, unknown>
      if (typeof record.root !== "string" || !record.root.trim()) return []
      const root = path.resolve(record.root)
      return [{
        id: typeof record.id === "string" && record.id ? record.id : workspaceID(root, typeof record.repoFingerprint === "string" ? record.repoFingerprint : null),
        root,
        displayName: typeof record.displayName === "string" && record.displayName ? record.displayName : path.basename(root),
        firstUserMessageAt: typeof record.firstUserMessageAt === "string" ? record.firstUserMessageAt : new Date().toISOString(),
        lastActiveAt: typeof record.lastActiveAt === "string" ? record.lastActiveAt : new Date().toISOString(),
        gitRoot: typeof record.gitRoot === "string" && record.gitRoot ? record.gitRoot : null,
        repoFingerprint: typeof record.repoFingerprint === "string" && record.repoFingerprint ? record.repoFingerprint : null,
        worktreePath: typeof record.worktreePath === "string" && record.worktreePath ? record.worktreePath : null,
        source: record.source === "historical-session" || record.source === "user-added-root" || record.source === "imported-root" ? record.source : "current-session",
        groupIDs: Array.isArray(record.groupIDs) ? record.groupIDs.filter((group): group is string => typeof group === "string" && group.length > 0) : [],
        archived: record.archived === true,
      }]
    }),
    groups: groups.flatMap((item): MemoryWorkspaceGroup[] => {
      if (typeof item !== "object" || item === null) return []
      const record = item as Record<string, unknown>
      if (typeof record.id !== "string" || !record.id) return []
      return [{
        id: record.id,
        label: typeof record.label === "string" && record.label ? record.label : record.id,
        root: typeof record.root === "string" && record.root ? record.root : null,
        workspaceIDs: Array.isArray(record.workspaceIDs) ? record.workspaceIDs.filter((workspace): workspace is string => typeof workspace === "string" && workspace.length > 0) : [],
        manual: record.manual === true,
        archived: record.archived === true,
      }]
    }),
  }
}

export async function readWorkspaceRegistry(root?: string) {
  const file = registryFile(root)
  if (!existsSync(file)) return normalizeWorkspaceRegistry({})
  return normalizeWorkspaceRegistry(JSON.parse(await readFile(file, "utf8")))
}

export async function writeWorkspaceRegistry(registry: MemoryWorkspaceRegistry, root?: string) {
  const next = normalizeWorkspaceRegistry({ ...registry, updatedAt: new Date().toISOString() })
  await atomicWrite(registryFile(root), `${JSON.stringify(next, null, 2)}\n`)
  return next
}

function groupIDsForRoot(root: string, groupRoots: string[]) {
  return groupRoots.flatMap((groupRoot) => {
    const relative = path.relative(groupRoot, root)
    return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? [`root:${groupRoot}`] : []
  })
}

function automaticGroups(registry: MemoryWorkspaceRegistry) {
  const groups = new Map(registry.groups.map((group) => [group.id, group]))
  for (const groupRoot of registry.defaultGroupRoots) {
    const id = `root:${groupRoot}`
    const workspaceIDs = registry.workspaces.filter((workspace) => groupIDsForRoot(workspace.root, [groupRoot]).includes(id)).map((workspace) => workspace.id)
    if (!workspaceIDs.length) continue
    groups.set(id, {
      id,
      label: groupRoot,
      root: groupRoot,
      workspaceIDs,
      manual: false,
      archived: false,
    })
  }
  return [...groups.values()]
}

export async function registerMemoryWorkspace(input: {
  root: string
  userMessageAt?: string
  gitRoot?: string | null
  repoFingerprint?: string | null
  worktreePath?: string | null
  source?: MemoryWorkspaceSource
}, registryRoot?: string) {
  const registry = await readWorkspaceRegistry(registryRoot)
  const now = input.userMessageAt || new Date().toISOString()
  const root = path.resolve(input.root)
  const id = workspaceID(root, input.repoFingerprint)
  const existing = registry.workspaces.find((workspace) => workspace.id === id || workspace.root === root)
  const groupIDs = groupIDsForRoot(root, registry.defaultGroupRoots)
  const workspace: MemoryWorkspace = {
    id,
    root,
    displayName: path.basename(root) || root,
    firstUserMessageAt: existing?.firstUserMessageAt ?? now,
    lastActiveAt: now,
    gitRoot: input.gitRoot ?? existing?.gitRoot ?? null,
    repoFingerprint: input.repoFingerprint ?? existing?.repoFingerprint ?? null,
    worktreePath: input.worktreePath ?? existing?.worktreePath ?? null,
    source: input.source ?? existing?.source ?? "current-session",
    groupIDs: [...new Set([...(existing?.groupIDs ?? []), ...groupIDs])],
    archived: existing?.archived ?? false,
  }
  const workspaces = existing
    ? registry.workspaces.map((item) => item === existing ? workspace : item)
    : [...registry.workspaces, workspace]
  const next = await writeWorkspaceRegistry({ ...registry, workspaces, groups: automaticGroups({ ...registry, workspaces }) }, registryRoot)
  publishMemoryWorkspaceEvent({ root: memoryPaths(registryRoot).root, workspace, status: existing ? "updated" : "created" })
  return next
}

export async function memoryWorkspaceOverview(root?: string) {
  const registry = await readWorkspaceRegistry(root)
  const discovered = await discoverPersistedMemoryWorkspaces(registry, root)
  const byRoot = new Map(registry.workspaces.map((workspace) => [path.resolve(workspace.root), workspace]))
  for (const workspace of discovered) {
    if (!byRoot.has(path.resolve(workspace.root))) byRoot.set(path.resolve(workspace.root), workspace)
  }
  const workspaces = [...byRoot.values()]
  const withGroups = { ...registry, workspaces, groups: automaticGroups({ ...registry, workspaces }) }
  return {
    ...withGroups,
    activeWorkspaces: withGroups.workspaces.filter((workspace) => !workspace.archived),
    activeGroups: withGroups.groups.filter((group) => !group.archived),
  }
}
