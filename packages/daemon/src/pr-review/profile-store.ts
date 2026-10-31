import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { z } from "zod"
import { PR_REVIEW_PROVIDERS } from "@mendcode/protocol"
import { checkLayer, type ConfigLayer } from "./config-layers"

/**
 * A developer's own reviewer profile for one repository (docs/pr-review.md, personal profiles): the personal config layer, kept
 * under the data directory at `<dataDir>/pr-review/profiles/<provider>/<owner>/<repo>/<login>.json`, never in the repository and
 * never shared with the global reviewer. Every save is a new version with a summary and a time; the newest 50 are kept. A revert
 * is a new version equal to an old one, so history only grows forward and a revert can itself be reverted. Writes are atomic
 * (temp file and rename, 0600 in 0700 directories). Each path segment is checked like `repoParts`, so no input leaves the
 * directory.
 */

export const PROFILE_HISTORY_LIMIT = 50
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
/** GitLab nests groups (`group/subgroup/project`); GitHub and Gitea have two segments. */
const MAX_REPO_SEGMENTS = 6

export type ProfileKey = { provider: typeof PR_REVIEW_PROVIDERS[number]; repo: string; login: string }

const ProfileVersion = z.strictObject({
  version: z.number().int().positive(),
  at: z.number().int(),
  summary: z.string().min(1).max(200),
  config: z.record(z.string(), z.unknown()),
})
export type ProfileVersion = z.infer<typeof ProfileVersion>
const ProfileFile = z.strictObject({
  format: z.literal(1),
  provider: z.enum(PR_REVIEW_PROVIDERS),
  repo: z.string().min(1).max(200),
  login: z.string().min(1).max(100),
  /** Oldest first; the last one is the profile in effect. */
  versions: z.array(ProfileVersion).max(PROFILE_HISTORY_LIMIT),
})
type ProfileFile = z.infer<typeof ProfileFile>

const segment = (value: string, what: string) => {
  if (!SEGMENT.test(value) || value.includes("..")) throw new RangeError(`[PR_REVIEW]: invalid ${what} ${JSON.stringify(value.slice(0, 120))}`)
  return value
}

/** The profile's file; throws `RangeError` for a provider, repository or login that could leave the data directory. */
export function profilePath(dataDir: string, key: ProfileKey): string {
  if (!(PR_REVIEW_PROVIDERS as readonly string[]).includes(key.provider)) throw new RangeError(`[PR_REVIEW]: invalid provider ${JSON.stringify(String(key.provider).slice(0, 40))}`)
  const parts = key.repo.split("/")
  if (parts.length < 2 || parts.length > MAX_REPO_SEGMENTS) throw new RangeError(`[PR_REVIEW]: invalid repository ${JSON.stringify(key.repo.slice(0, 120))}`)
  parts.forEach((part) => segment(part, "repository"))
  return path.join(dataDir, "pr-review", "profiles", key.provider, ...parts, `${segment(key.login, "login")}.json`)
}

export type ProfileStore = ReturnType<typeof createProfileStore>

export function createProfileStore({ dataDir, now = Date.now }: { dataDir: string; now?: () => number }) {
  /** The saved file; a damaged one is a problem, not an empty profile, so it is never silently written over. */
  const load = (key: ProfileKey): { file?: ProfileFile; problem?: string } => {
    const file = profilePath(dataDir, key)
    if (!existsSync(file)) return {}
    try {
      const parsed = ProfileFile.safeParse(JSON.parse(readFileSync(file, "utf8")))
      if (parsed.success) return { file: parsed.data }
      return { problem: `[PR_REVIEW]: personal profile ${file} is damaged (${parsed.error.issues[0]?.path.join(".") || "root"}: ${parsed.error.issues[0]?.message})` }
    } catch (error) {
      return { problem: `[PR_REVIEW]: personal profile ${file} cannot be read (${error instanceof Error ? error.message : String(error)})` }
    }
  }

  const write = (key: ProfileKey, data: ProfileFile) => {
    const file = profilePath(dataDir, key)
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const temp = `${file}.${crypto.randomUUID()}.tmp`
    writeFileSync(temp, `${JSON.stringify(ProfileFile.parse(data), null, 2)}\n`, { mode: 0o600, flag: "wx" })
    renameSync(temp, file)
  }

  /** Appends a version; a damaged file is moved aside (`.damaged-<time>`) first so its text is kept for the user. */
  const append = (key: ProfileKey, config: ConfigLayer, summary: string): ProfileVersion => {
    const loaded = load(key)
    const file = profilePath(dataDir, key)
    if (loaded.problem && existsSync(file)) renameSync(file, `${file}.damaged-${now()}`)
    const versions = loaded.file?.versions ?? []
    const entry: ProfileVersion = { version: (versions.at(-1)?.version ?? 0) + 1, at: now(), summary: summary.trim().slice(0, 200) || "updated", config: structuredClone(config) }
    write(key, { format: 1, provider: key.provider, repo: key.repo, login: key.login, versions: [...versions, entry].slice(-PROFILE_HISTORY_LIMIT) })
    return entry
  }

  return {
    path: (key: ProfileKey) => profilePath(dataDir, key),
    /** Whether a profile exists, its version in effect (0: none) and its layer, plus a problem when the file is damaged. */
    current(key: ProfileKey): { exists: boolean; version: number; config: ConfigLayer; at?: number; problem?: string } {
      const loaded = load(key)
      const last = loaded.file?.versions.at(-1)
      return { exists: !!last, version: last?.version ?? 0, config: last ? structuredClone(last.config) : {}, ...(last ? { at: last.at } : {}), ...(loaded.problem ? { problem: loaded.problem } : {}) }
    },
    /** Newest first, at most 50. */
    history(key: ProfileKey): Array<Omit<ProfileVersion, "config">> {
      return (load(key).file?.versions ?? []).map(({ version, at, summary }) => ({ version, at, summary })).reverse()
    },
    version(key: ProfileKey, version: number): ProfileVersion | undefined {
      return load(key).file?.versions.find((entry) => entry.version === version)
    },
    /** A new version; throws `TypeError` when the layer has an unknown key or a bad value (each named with its key path). */
    save(key: ProfileKey, input: { config: ConfigLayer; summary: string }): ProfileVersion {
      const checked = checkLayer(input.config, "personal")
      if (checked.problems.length) throw new TypeError(checked.problems.join("\n"))
      return append(key, checked.layer, input.summary)
    },
    /** A new version equal to `version`; throws `RangeError` when that version is not in the kept history. */
    revert(key: ProfileKey, version: number, summary?: string): ProfileVersion {
      const old = load(key).file?.versions.find((entry) => entry.version === version)
      if (!old) throw new RangeError(`[PR_REVIEW]: personal profile version ${version} is not in the kept history (the newest ${PROFILE_HISTORY_LIMIT} are kept)`)
      return append(key, old.config, summary ?? `revert to version ${version}`)
    },
  }
}
