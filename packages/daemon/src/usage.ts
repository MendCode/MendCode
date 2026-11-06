import { existsSync, readFileSync, realpathSync, statSync } from "node:fs"
import path from "node:path"
import type { Command, Settings, UsageReport, UsageWasteReport } from "@mendcode/protocol"
import type { Store } from "@mendcode/store"
import { localDay } from "./usage-today"
import { analyzeWaste, CHANGE_DAYS, type WastePrice } from "./usage-waste"

function canonical(directory: string) {
  try { return realpathSync(directory) } catch { return path.resolve(directory) }
}

/** V2 project identity: canonical checkout root; linked worktrees share their common Git root. No Git writes. */
export function usageProject(directory: string): { id: string; directory: string } {
  const exact = canonical(directory)
  let root = exact
  for (let level = 0; level < 40; level++) {
    const dot = path.join(root, ".git")
    if (existsSync(dot)) {
      try {
        let git = dot
        if (statSync(dot).isFile()) {
          const target = /^gitdir:\s*(.+)$/m.exec(readFileSync(dot, "utf8"))?.[1]?.trim()
          if (!target) break
          git = path.resolve(root, target)
        }
        const commonFile = path.join(git, "commondir")
        const common = canonical(existsSync(commonFile) ? path.resolve(git, readFileSync(commonFile, "utf8").trim()) : git)
        const project = path.basename(common) === ".git" ? path.dirname(common) : root
        return { id: project, directory: project }
      } catch { break }
    }
    const parent = path.dirname(root)
    if (parent === root) break
    root = parent
  }
  return { id: exact, directory: exact }
}

type ScopeQuery = Pick<Extract<Command, { type: "usage.query" }>, "scope" | "directory" | "project">

/** The scope of a usage query: its kind and identity, the known projects, and the session directories it covers (every known one for global). */
export function usageScope(store: Store, query: ScopeQuery, defaultDirectory = process.cwd()) {
  const kind = query.scope ?? (query.project ? "project" : "global")
  const directory = canonical(query.directory ?? defaultDirectory)
  const known = store.usageScopes.directories()
  const identities = new Map(known.map((dir) => [dir, usageProject(dir)]))
  const current = usageProject(directory)
  const projects = [...new Map([...identities.values(), current].map((project) => [project.id, project])).values()].sort((a, b) => a.directory.localeCompare(b.directory))
  const project = query.project ? usageProject(query.project).id : current.id
  const gitProject = existsSync(path.join(current.directory, ".git"))
  const directories = kind === "directory" ? known.filter((dir) => {
    const relative = path.relative(directory, canonical(dir))
    const within = relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
    return within && (!gitProject || identities.get(dir)?.id === current.id)
  }) : known.filter((dir) => identities.get(dir)?.id === project)
  const scope: NonNullable<UsageReport["scope"]> = { kind, ...(kind === "directory" ? { directory } : kind === "project" ? { directory: projects.find((p) => p.id === project)?.directory ?? project, project } : {}) }
  return { kind, scope, projects, known, directories }
}

export function createUsageQuery(store: Store, defaultDirectory = process.cwd(), breakdown?: typeof import("./usage-breakdown").usageBreakdown) {
  return (query: Omit<Extract<Command, { type: "usage.query" }>, "type" | "id" | "clientId">, today: string): Omit<UsageReport, "quotas"> => {
    const { kind, scope, projects, known, directories } = usageScope(store, query, defaultDirectory)
    const range = { from: query.from, to: query.to }
    const scoped = { ...range, directories }
    // Zero requests all tools; the default dashboard stays at ten.
    const toolLimit = query.toolLimit === 0 ? -1 : query.toolLimit ?? 10
    const savings = store.usageScopes.savings({ ...range, directories: kind === "global" ? known : directories })
    // Calls outside turns: global shows every one, sessionless ones included; a scope shows those made for its directories.
    const auxiliary = store.usageAuxiliary.report(kind === "global" ? range : scoped)
    const report = {
      ...(savings.length ? { savings } : {}),
      ...(auxiliary.length ? { auxiliary } : {}),
      ...range,
      scope,
      projects,
      ...store.usageWidgets({ ...range, ...(kind === "global" ? {} : { directories }) }),
      ...(kind === "global" ? {
        days: store.usageDaily(range), models: store.usageByModel(range), sessions: store.usageSessions(range),
        activity: store.usageActivity(range), tools: store.usageTools(range, toolLimit), insights: store.usageInsights({ ...range, today }),
      } : {
        days: store.usageScopes.daily(scoped), models: store.usageScopes.models(scoped), sessions: store.usageScopes.sessions(scoped),
        activity: store.usageScopes.activity(scoped), tools: store.usageScopes.tools(scoped, toolLimit < 0 ? Infinity : toolLimit), insights: store.usageScopes.insights({ ...scoped, today }),
      }),
    }
    // Recovered external-harness usage is kept apart and added on top, never written into the native projections.
    for (const row of store.usageRecovery.rows({ ...range, ...(kind === "global" ? {} : { directories }) })) {
      if (!row.input && !row.output && !row.cacheRead && !row.cacheWrite) continue
      let day = report.days.find((entry) => entry.day === row.day)
      if (!day) {
        day = { day: row.day, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, costMicros: 0, costUnknownCalls: 0, calls: 0, sessions: 0 }
        report.days.push(day)
      }
      day.input += row.input; day.output += row.output; day.cacheRead += row.cacheRead; day.cacheWrite += row.cacheWrite
      const model = `recovered:${row.engine}`
      let group = report.models.find((entry) => entry.model === model)
      if (!group) { group = { provider: row.engine, model, input: 0, output: 0, calls: 0, costMicros: 0, costUnknownCalls: 0, cacheRead: 0, cacheWrite: 0 }; report.models.push(group) }
      group.input += row.input; group.output += row.output
      group.cacheRead = (group.cacheRead ?? 0) + row.cacheRead; group.cacheWrite = (group.cacheWrite ?? 0) + row.cacheWrite
    }
    report.days.sort((a, b) => a.day.localeCompare(b.day))
    // By harness and the calls outside turns per day: only when the caller loaded the breakdown (the daemon's `usage.query` does).
    return breakdown ? { ...report, ...breakdown({ store, range: kind === "global" ? range : scoped, days: report.days }) } : report
  }
}

/** `usage.waste`: the waste report for a range, with the comparison around the settings changes of the last 90 days. */
export function createUsageWaste(input: {
  store: Store
  defaultDirectory?: string
  now(): number
  settings(): Settings
  price(provider: string, model: string): WastePrice | undefined
  providerType(id: string): string | undefined
  feature(id: "idle_compact" | "wait_cache"): boolean
}) {
  return (query: Omit<Extract<Command, { type: "usage.waste" }>, "type" | "id" | "clientId">): UsageWasteReport => {
    const { store } = input
    const { kind, scope, directories } = usageScope(store, query, input.defaultDirectory)
    const visible = kind === "global" ? {} : { directories }
    const now = input.now()
    // The comparison needs the two weeks before the oldest change it shows.
    const recent = { from: localDay(now - (CHANGE_DAYS + 15) * 86_400_000), to: localDay(now), ...visible }
    return analyzeWaste({
      from: query.from, to: query.to, scope, now,
      calls: store.usageCalls.calls({ from: query.from, to: query.to, ...visible }),
      compactions: store.usageCalls.compactions({ from: query.from, to: query.to, ...visible }),
      recentCalls: store.usageCalls.calls(recent),
      recentCompactions: store.usageCalls.compactions(recent),
      history: store.usageCalls.settingsHistory(),
      settings: input.settings(),
      titles: (ids) => new Map(store.usageCalls.sessions(ids).map((row) => [row.id, row.title])),
      price: input.price,
      providerType: input.providerType,
      feature: input.feature,
    })
  }
}
