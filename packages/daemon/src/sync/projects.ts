import { existsSync } from "node:fs"
import type { SyncProjectRef } from "@mendcode/protocol"
import { applyPathRule, gitIdentity, invertPathRules, mapProject, type PathRule, type ProjectIdentity, type RemoteRepo } from "../project-identity"

const MAX_KNOWN = 2000
/** A project of the other machine missing here makes the index look again, but not more often than this. */
const RESCAN_MS = 60_000

/**
 * Where the projects of the other machine are on this one: an explicit `pathMap` rule, then a clone with the same git remote
 * (and the same path inside it), then the same path if it exists here. Identities are read from git once per folder and kept.
 */
export function createProjectIndex(input: { directories: () => string[]; rules: readonly PathRule[]; now: () => number }) {
  const identities = new Map<string, Promise<ProjectIdentity>>()
  let repos: Promise<RemoteRepo[]> | undefined
  let scannedAt = 0
  const remoteToLocal = invertPathRules(input.rules)
  function identity(directory: string) {
    let known = identities.get(directory)
    if (!known) {
      if (identities.size >= MAX_KNOWN) identities.delete(identities.keys().next().value!)
      identities.set(directory, (known = gitIdentity(directory)))
    }
    return known
  }
  async function localRepos(fresh: boolean) {
    if (!repos || fresh && input.now() - scannedAt > RESCAN_MS) {
      scannedAt = input.now()
      repos = Promise.all([...new Set(input.directories())].filter((directory) => existsSync(directory)).slice(0, 500).map(identity))
        .then((all) => [...new Map(all.filter((item) => item.top && item.url).map((item) => [item.top!, { top: item.top!, url: item.url! }])).values()])
    }
    return repos
  }
  return {
    /** How the other machine can find this folder's project. */
    async ref(directory: string): Promise<SyncProjectRef | undefined> {
      if (!existsSync(directory)) return undefined
      const found = await identity(directory)
      return found.id ? { id: found.id, rel: found.rel } : undefined
    },
    /** This machine's folder for a folder of the other machine; `mapped: false` when the project is not here. */
    async resolve(remote: { directory: string; project?: SyncProjectRef }): Promise<{ directory: string; mapped: boolean }> {
      const ruled = applyPathRule(remote.directory, remoteToLocal)
      if (ruled) return { directory: ruled, mapped: true }
      if (remote.project) {
        const project = { directory: remote.directory, id: remote.project.id, rel: remote.project.rel }
        for (const fresh of [false, true]) {
          const mapping = mapProject({ project, rules: [], repos: await localRepos(fresh), cloneMissing: false, cloneRoot: "" })
          if (mapping.directory !== undefined) return { directory: mapping.directory, mapped: true }
        }
      }
      return { directory: remote.directory, mapped: existsSync(remote.directory) }
    },
    /** The other machine's folder for a folder here, by explicit rule only (the other side resolves the project itself). */
    toRemote: (directory: string) => applyPathRule(directory, input.rules) ?? directory,
  }
}
export type ProjectIndex = ReturnType<typeof createProjectIndex>
