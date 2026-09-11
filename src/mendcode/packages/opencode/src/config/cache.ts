import path from "path"
import { Schema } from "effect"
import { zod } from "@/util/effect-zod"
import { withStatics } from "@/util/schema"

export const Mode = Schema.Literals(["off", "smart"])
export type Mode = Schema.Schema.Type<typeof Mode>

const Project = Schema.Struct({
  mode: Schema.optional(Mode),
})

const Provider = Schema.Struct({
  mode: Schema.optional(Mode),
  models: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  exclude_models: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
})

const Sessions = Schema.Struct({
  mode: Schema.optional(Schema.Literals(["all", "selected", "none"])),
  include: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
  exclude: Schema.optional(Schema.mutable(Schema.Array(Schema.String))),
})

export const Info = Schema.Struct({
  mode: Schema.optional(Mode).annotate({
    description:
      "Prompt-cache policy. Omit to preserve existing provider behavior, off to suppress cache controls, or smart to allow only verified passive bindings.",
  }),
  projects: Schema.optional(Schema.Record(Schema.String, Project)).annotate({
    description: "Project-path overrides for the prompt-cache policy",
  }),
  sessions: Schema.optional(Sessions).annotate({
    description: "Session include/exclude controls for passive prompt caching",
  }),
  providers: Schema.optional(Schema.Record(Schema.String, Provider)).annotate({
    description: "Provider and exact-model allowlists or exclusions for verified cache bindings",
  }),
})
  .annotate({ identifier: "CacheConfig" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))

export type Info = Schema.Schema.Type<typeof Info>

export type EffectiveMode = "legacy" | Mode

export type CacheSelection = {
  mode: EffectiveMode
  source: "default" | "project" | "session" | "provider" | "model"
  reason: string
}

function normalizedProjectPath(value: string) {
  const resolved = path.resolve(value)
  const root = path.parse(resolved).root
  return resolved === root ? resolved : resolved.replace(/[\\/]+$/, "")
}

function projectOverride(config: Info | undefined, projectScope: string | undefined) {
  if (!config?.projects || !projectScope) return undefined
  const normalized = normalizedProjectPath(projectScope)
  for (const [candidate, override] of Object.entries(config.projects)) {
    if (normalizedProjectPath(candidate) === normalized) return override
  }
  return undefined
}

function modelCandidates(modelID: string | undefined, apiModelID: string | undefined) {
  return [
    ...new Set([modelID, apiModelID, modelID?.split("/").pop(), apiModelID?.split("/").pop()].filter(Boolean)),
  ] as string[]
}

function includesModel(models: readonly string[] | undefined, candidates: readonly string[]) {
  if (!models) return true
  return candidates.some((candidate) => models.includes(candidate))
}

export function selectCacheConfig(input: {
  config?: Info
  projectScope?: string
  sessionID?: string
  providerID?: string
  modelID?: string
  apiModelID?: string
}): CacheSelection {
  const config = input.config
  const project = projectOverride(config, input.projectScope)
  const provider = input.providerID ? config?.providers?.[input.providerID] : undefined
  const candidates = modelCandidates(input.modelID, input.apiModelID)
  const session = config?.sessions

  if (config?.mode === "off") {
    return { mode: "off", source: "default", reason: "cache.mode is off" }
  }

  if (project?.mode === "off") {
    return { mode: "off", source: "project", reason: "the active project is excluded" }
  }

  if (session?.mode === "none") {
    return { mode: "off", source: "session", reason: "session caching is disabled" }
  }

  if (input.sessionID && session?.exclude?.includes(input.sessionID)) {
    return { mode: "off", source: "session", reason: "the session is excluded" }
  }

  if (input.sessionID && session?.mode === "selected" && !session.include?.includes(input.sessionID)) {
    return { mode: "off", source: "session", reason: "the session is not selected" }
  }

  if (provider?.mode === "off") {
    return { mode: "off", source: "provider", reason: `provider ${input.providerID} is disabled` }
  }

  if (provider && input.modelID) {
    if (!includesModel(provider.models, candidates)) {
      return { mode: "off", source: "model", reason: "the model is not in the provider allowlist" }
    }
    if (provider.exclude_models?.some((model) => candidates.includes(model))) {
      return { mode: "off", source: "model", reason: "the model is excluded" }
    }
  }

  if (config?.mode === "smart") {
    return { mode: "smart", source: "default", reason: "cache.mode is smart" }
  }

  if (project?.mode === "smart") {
    return { mode: "smart", source: "project", reason: "the active project enables smart caching" }
  }

  if (
    provider &&
    (provider.mode === "smart" || provider.models !== undefined || provider.exclude_models !== undefined)
  ) {
    return { mode: "smart", source: provider.models ? "model" : "provider", reason: "the provider is selected" }
  }

  if (input.sessionID && session?.include?.includes(input.sessionID)) {
    return { mode: "smart", source: "session", reason: "the session is explicitly selected" }
  }

  return { mode: "legacy", source: "default", reason: "cache policy is not configured" }
}

export type CacheMutation = {
  action: "enable" | "disable"
  providerID?: string
  modelID?: string
  sessionID?: string
  projectPath?: string
}

function unique(values: readonly string[]) {
  return [...new Set(values)]
}

function without(values: readonly string[] | undefined, value: string) {
  return (values ?? []).filter((item) => item !== value)
}

export function updateCacheConfig(current: Info | undefined, mutation: CacheMutation): Info {
  const next = current ? { ...current } : {}
  const enabled = mutation.action === "enable"
  const targetCount = [mutation.providerID, mutation.modelID, mutation.sessionID, mutation.projectPath].filter(
    Boolean,
  ).length
  if (mutation.modelID && !mutation.providerID) throw new Error("A model requires --provider")
  if (mutation.projectPath && (mutation.providerID || mutation.modelID || mutation.sessionID)) {
    throw new Error("A project target cannot be combined with provider, model, or session")
  }
  if (mutation.sessionID && (mutation.providerID || mutation.modelID)) {
    throw new Error("A session target cannot be combined with provider or model")
  }

  if (targetCount === 0) return { ...next, mode: enabled ? "smart" : "off" }

  if (mutation.projectPath) {
    const key = normalizedProjectPath(mutation.projectPath)
    return {
      ...next,
      projects: {
        ...(next.projects ?? {}),
        [key]: { ...(next.projects?.[key] ?? {}), mode: enabled ? "smart" : "off" },
      },
    }
  }

  if (mutation.sessionID) {
    const sessions = next.sessions ?? {}
    const include = enabled
      ? unique([...without(sessions.include, mutation.sessionID), mutation.sessionID])
      : without(sessions.include, mutation.sessionID)
    const exclude = enabled
      ? without(sessions.exclude, mutation.sessionID)
      : unique([...without(sessions.exclude, mutation.sessionID), mutation.sessionID])
    return {
      ...next,
      sessions: {
        ...sessions,
        ...(enabled ? { mode: "selected" as const } : {}),
        include,
        exclude,
      },
    }
  }

  const provider = next.providers?.[mutation.providerID!]
  const updatedProvider = { ...(provider ?? {}) }
  if (!mutation.modelID) {
    updatedProvider.mode = enabled ? "smart" : "off"
  } else if (enabled) {
    updatedProvider.mode = "smart"
    updatedProvider.models = unique([...(updatedProvider.models ?? []), mutation.modelID])
    updatedProvider.exclude_models = without(updatedProvider.exclude_models, mutation.modelID)
  } else {
    updatedProvider.exclude_models = unique([...(updatedProvider.exclude_models ?? []), mutation.modelID])
    updatedProvider.models = without(updatedProvider.models, mutation.modelID)
  }

  return {
    ...next,
    providers: {
      ...(next.providers ?? {}),
      [mutation.providerID!]: updatedProvider,
    },
  }
}

export * as ConfigCache from "./cache"
