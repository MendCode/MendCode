import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { Global } from "@mendcode/core/global"
import { Flock } from "@mendcode/core/util/flock"
import { z } from "zod"

export const EvolutionConfigSchema = z.object({
  version: z.literal(1),
  mode: z.enum(["off", "observe", "suggest", "auto-safe"]),
  sources: z.object({ corrections: z.boolean(), toolResults: z.boolean(), testResults: z.boolean() }).strict(),
  outputs: z.object({ memory: z.boolean(), skills: z.boolean(), workflows: z.boolean() }).strict(),
  remoteProcessing: z.boolean(),
  distillerRole: z.string().min(1).nullable(),
  execution: z.enum(["manual", "daily"]),
  dailyAt: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable(),
  timezone: z.string().refine((value) => {
    try { new Intl.DateTimeFormat("en", { timeZone: value }); return true } catch { return false }
  }).nullable(),
}).strict().refine((value) => value.execution !== "daily" || Boolean(value.dailyAt && value.timezone), "Daily execution requires a time and timezone")

export type EvolutionConfig = z.infer<typeof EvolutionConfigSchema>
export type EvolutionMode = EvolutionConfig["mode"]
export const defaultEvolutionConfig: EvolutionConfig = {
  version: 1, mode: "off",
  sources: { corrections: true, toolResults: false, testResults: false },
  outputs: { memory: true, skills: false, workflows: false },
  remoteProcessing: false, distillerRole: null,
  execution: "manual", dailyAt: null, timezone: null,
}

const RestrictionSchema = z.object({
  mode: z.enum(["off", "observe", "suggest", "auto-safe"]).optional(),
  sources: z.object({ corrections: z.boolean().optional(), toolResults: z.boolean().optional(), testResults: z.boolean().optional() }).strict().optional(),
  outputs: z.object({ memory: z.boolean().optional(), skills: z.boolean().optional(), workflows: z.boolean().optional() }).strict().optional(),
  remoteProcessing: z.boolean().optional(),
}).strict()

const StoredSchema = z.object({ revision: z.string().uuid(), config: EvolutionConfigSchema }).strict()
const rank: Record<EvolutionMode, number> = { off: 0, observe: 1, suggest: 2, "auto-safe": 3 }

export function evolutionPaths(root: string, dataDir = path.join(Global.Path.data, "evolution")) {
  const project = createHash("sha256").update(path.resolve(root)).digest("hex")
  return {
    dataDir,
    globalConfig: path.join(dataDir, "config.json"),
    projectDir: path.join(dataDir, "projects", project),
    consent: path.join(dataDir, "projects", project, "consent.json"),
    restriction: path.join(path.resolve(root), ".mendcode", "evolution.json"),
  }
}

export async function readEvolutionJSON(file: string): Promise<unknown> {
  return readFile(file, "utf8").then((text) => JSON.parse(text) as unknown).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
}

export async function writeEvolutionJSON(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, file)
}

export type EvolutionPolicy = {
  adopted: boolean
  config: EvolutionConfig
  revision: string
  reason: string | null
  origin: "legacy" | "global" | "project" | "invalid"
}

/** Only application-owned data can grant consent. Repository configuration can only restrict it. */
export async function readEvolutionPolicy(root: string, dataDir?: string): Promise<EvolutionPolicy> {
  const paths = evolutionPaths(root, dataDir)
  try {
    const [global, project, restriction] = await Promise.all([
      readEvolutionJSON(paths.globalConfig), readEvolutionJSON(paths.consent), readEvolutionJSON(paths.restriction),
    ])
    // Validate even a shadowed global file: malformed consent must fail closed.
    const globalConfig = global === undefined ? undefined : StoredSchema.parse(global)
    const projectConfig = project === undefined ? undefined : StoredSchema.parse(project)
    const limits = restriction === undefined ? undefined : RestrictionSchema.parse(restriction)
    const stored = projectConfig ?? globalConfig
    if (!stored) return { adopted: false, config: defaultEvolutionConfig, revision: "legacy", reason: null, origin: "legacy" }
    const config = structuredClone(stored.config)
    // A project may narrow global consent, never restore a globally denied effect.
    for (const ceiling of [globalConfig?.config, limits]) {
      if (ceiling?.mode && rank[ceiling.mode] < rank[config.mode]) config.mode = ceiling.mode
      for (const key of ["corrections", "toolResults", "testResults"] as const) config.sources[key] &&= ceiling?.sources?.[key] !== false
      for (const key of ["memory", "skills", "workflows"] as const) config.outputs[key] &&= ceiling?.outputs?.[key] !== false
      config.remoteProcessing &&= ceiling?.remoteProcessing !== false
    }
    if (globalConfig?.config.execution === "manual") {
      config.execution = "manual"
      config.dailyAt = null
      config.timezone = null
    }
    const revision = createHash("sha256").update(JSON.stringify([globalConfig?.revision, projectConfig?.revision, config])).digest("hex")
    return { adopted: true, config, revision, reason: null, origin: projectConfig ? "project" : "global" }
  } catch {
    return { adopted: true, config: defaultEvolutionConfig, revision: "invalid", reason: "Invalid Evolution configuration; learning blocked", origin: "invalid" }
  }
}

/** Called only by an explicit host UI action, never by package/project projection. */
export async function writeEvolutionConsent(root: string, config: EvolutionConfig, dataDir?: string) {
  const paths = evolutionPaths(root, dataDir)
  const parsed = EvolutionConfigSchema.parse(config)
  return Flock.withLock(`evolution-policy:${paths.consent}`, async () => {
    await writeEvolutionJSON(paths.consent, { revision: randomUUID(), config: parsed })
    return readEvolutionPolicy(root, dataDir)
  }, { dir: path.join(paths.projectDir, ".locks"), timeoutMs: 5_000 })
}
