import type { CacheMutation, CacheStatus, CacheTarget } from "@mendcode/protocol"
import type { Store } from "@mendcode/store"
import { cacheConfigFor, cacheProject, selectCache, updateCache } from "@mendcode/engine-native"

export function createCacheControl(store: Store) {
  const localFor = (directory: string) => Object.entries(store.settings.get().cacheProjects ?? {}).find(([key]) => cacheProject(key) === cacheProject(directory))?.[1]
  const status = (input: CacheTarget): CacheStatus => {
    const settings = store.settings.get(), project = cacheProject(input.directory)
    const configured = input.global ? settings.cache : cacheConfigFor(settings, project)
    const selection = selectCache({ config: configured, directory: input.projectPath ? cacheProject(input.projectPath) : project, session: input.session, provider: input.provider, model: input.model })
    if (selection.mode === "legacy" && settings.promptCache) { selection.mode = settings.promptCache; selection.reason = "promptCache compatibility setting" }
    return { ...selection, project, configured: configured ?? null, global: settings.cache ?? null, local: localFor(project) ?? null, activeKeeper: false }
  }
  return {
    status,
    set(input: CacheMutation) {
      const directory = cacheProject(input.directory), settings = store.settings.get()
      const config = updateCache(input.global ? settings.cache : localFor(directory), { ...input, ...(input.projectPath ? { projectPath: cacheProject(input.projectPath) } : {}) })
      const projects = Object.fromEntries(Object.entries(settings.cacheProjects ?? {}).filter(([key]) => cacheProject(key) !== directory))
      const saved = store.settings.set(input.global ? { cache: config } : { cacheProjects: { ...projects, [directory]: config } })
      return { settings: saved, report: status(input) }
    },
  }
}
