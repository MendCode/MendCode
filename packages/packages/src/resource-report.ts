import { BUILTIN_PACKAGE, type ExtensionLayer } from "./layers"

/**
 * What a resource loader (skills, commands, agents) tells the user instead of dropping silently: which entry another
 * layer overrides, which ones a cap left out, fields no loader reads, notes about fields that are read but not enforced,
 * and files that could not be loaded. One shape for all three loaders so `/doctor` and the pages print the same thing.
 */
export type ResourceKindName = "skill" | "command" | "agent"
export type ResourceDiagnostics = {
  overridden: Array<{ kind: ResourceKindName; name: string; layer: string; by: string }>
  dropped: Array<{ kind: ResourceKindName; name: string; layer: string; reason: string }>
  ignored: Array<{ kind: ResourceKindName; name: string; layer: string; fields: string[] }>
  notes: Array<{ kind: ResourceKindName; name: string; layer: string; note: string }>
  problems: Array<{ file: string; message: string }>
}

export const emptyDiagnostics = (): ResourceDiagnostics => ({ overridden: [], dropped: [], ignored: [], notes: [], problems: [] })

/** `package user:acme`, `.claude (project)`, `built in`, `user`, `project`: how a layer is named in reports. The scope keeps a user and a project package of one name apart. */
export function layerLabel(layer: Pick<ExtensionLayer, "source" | "pkg" | "foreign">) {
  if (layer.pkg === BUILTIN_PACKAGE) return "built in"
  if (layer.pkg) return `package ${layer.source}:${layer.pkg}`
  if (layer.foreign?.origin === "parent") return "a parent folder's .mendcode (project)"
  if (layer.foreign) return `.${layer.foreign.origin} (${layer.source})`
  return layer.source
}

export type Candidate<T> = { name: string; layer: string; value: T }

/**
 * Candidates arrive lowest precedence first. The last one with a name wins and the others are reported as overridden;
 * only then is `cap` applied, dropping the lowest-priority winners, so a full user folder can never push a project
 * entry out of the quota. The kept entries come back lowest priority first.
 */
export function resolvePrecedence<T>(kind: ResourceKindName, candidates: Array<Candidate<T>>, cap: number, diagnostics: ResourceDiagnostics): Array<Candidate<T>> {
  const byName = new Map<string, Candidate<T>>()
  for (const candidate of candidates) {
    const previous = byName.get(candidate.name)
    if (previous) {
      diagnostics.overridden.push({ kind, name: candidate.name, layer: previous.layer, by: candidate.layer })
      byName.delete(candidate.name)
    }
    byName.set(candidate.name, candidate)
  }
  const kept = [...byName.values()]
  if (kept.length <= cap) return kept
  for (const dropped of kept.slice(0, kept.length - cap)) diagnostics.dropped.push({ kind, name: dropped.name, layer: dropped.layer, reason: `more than ${cap} ${kind}s; lowest-priority layers are dropped first` })
  return kept.slice(kept.length - cap)
}

/** `skill review (user): overridden by project`, one line per finding, bounded. */
export function diagnosticLines(diagnostics: ResourceDiagnostics, limit = 20): string[] {
  const lines = [
    ...diagnostics.overridden.map((entry) => `${entry.kind} ${entry.name} (${entry.layer}) is overridden by ${entry.by}`),
    ...diagnostics.dropped.map((entry) => `${entry.kind} ${entry.name} (${entry.layer}) was left out: ${entry.reason}`),
    ...diagnostics.ignored.map((entry) => `${entry.kind} ${entry.name} (${entry.layer}) has ignored fields: ${entry.fields.join(", ")}`),
    ...diagnostics.notes.map((entry) => `${entry.kind} ${entry.name} (${entry.layer}): ${entry.note}`),
    ...diagnostics.problems.map((entry) => `${entry.file}: ${entry.message}`),
  ]
  return lines.length > limit ? [...lines.slice(0, limit), `… and ${lines.length - limit} more`] : lines
}

export function mergeDiagnostics(...all: ResourceDiagnostics[]): ResourceDiagnostics {
  const out = emptyDiagnostics()
  for (const one of all) {
    out.overridden.push(...one.overridden)
    out.dropped.push(...one.dropped)
    out.ignored.push(...one.ignored)
    out.notes.push(...one.notes)
    out.problems.push(...one.problems)
  }
  return out
}
