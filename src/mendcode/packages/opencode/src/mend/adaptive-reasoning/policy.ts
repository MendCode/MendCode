import { createHash, randomUUID } from "node:crypto"
import { mkdir, open, realpath, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { Global } from "@mendcode/core/global"
import { Flock } from "@mendcode/core/util/flock"
import { z } from "zod"

const lease = z.union([z.literal(1), z.literal(2), z.literal(5)])
export const AdaptivePolicySchema = z.object({
  version: z.literal(1),
  mode: z.enum(["off", "shadow", "adaptive"]),
  remoteProcessing: z.boolean(),
  provider: z.literal("openrouter"),
  maxLeaseSteps: lease,
  maxDecisionsPerTurn: z.number().int().min(1).max(20),
  failureMode: z.enum(["pause", "baseline"]),
}).strict()
export type AdaptivePolicy = z.infer<typeof AdaptivePolicySchema>
export const defaultAdaptivePolicy: Readonly<AdaptivePolicy> = Object.freeze({
  version: 1, mode: "off", remoteProcessing: false, provider: "openrouter",
  maxLeaseSteps: 2, maxDecisionsPerTurn: 8, failureMode: "pause",
})
const storedSchema = z.object({ revision: z.string().uuid(), config: AdaptivePolicySchema }).strict()
const restrictionSchema = z.object({
  mode: z.enum(["off", "shadow", "adaptive"]).optional(),
  remoteProcessing: z.boolean().optional(),
  maxLeaseSteps: lease.optional(),
  maxDecisionsPerTurn: z.number().int().min(1).max(20).optional(),
}).strict()
const ranks = { off: 0, shadow: 1, adaptive: 2 }

export type AdaptivePolicyState = {
  config: AdaptivePolicy
  revision: string
  valid: boolean
  reason: "invalid-policy" | null
}

/** Project packages may restrict consent, but only host-owned state can grant it. */
export async function adaptivePaths(root: string, dataDir = path.join(Global.Path.data, "adaptive-reasoning")) {
  const canonical = await realpath(root)
  const project = createHash("sha256").update(canonical).digest("hex")
  const directory = path.join(dataDir, "projects", project)
  return {
    directory,
    consent: path.join(directory, "consent.json"),
    restriction: path.join(canonical, ".mendcode", "adaptive-reasoning.json"),
  }
}

async function readJSON(file: string): Promise<unknown> {
  const handle = await open(file, "r").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (!handle) return undefined
  try {
    const bytes = Buffer.alloc(65_537)
    let count = 0
    while (count < bytes.length) {
      const chunk = await handle.read(bytes, count, bytes.length - count)
      if (!chunk.bytesRead) break
      count += chunk.bytesRead
    }
    if (count > 65_536) throw new Error("Adaptive policy exceeds size limit")
    return JSON.parse(bytes.subarray(0, count).toString("utf8")) as unknown
  } finally {
    await handle.close()
  }
}

async function load(paths: Awaited<ReturnType<typeof adaptivePaths>>): Promise<AdaptivePolicyState> {
  const [raw, restriction] = await Promise.all([readJSON(paths.consent), readJSON(paths.restriction)])
  const stored = raw === undefined ? undefined : storedSchema.parse(raw)
  const limits = restriction === undefined ? undefined : restrictionSchema.parse(restriction)
  const config = { ...(stored?.config ?? defaultAdaptivePolicy) }
  if (limits?.mode && ranks[limits.mode] < ranks[config.mode]) config.mode = limits.mode
  if (limits?.remoteProcessing === false) config.remoteProcessing = false
  if (limits?.maxLeaseSteps && limits.maxLeaseSteps < config.maxLeaseSteps) config.maxLeaseSteps = limits.maxLeaseSteps
  if (limits?.maxDecisionsPerTurn) config.maxDecisionsPerTurn = Math.min(config.maxDecisionsPerTurn, limits.maxDecisionsPerTurn)
  return {
    config,
    revision: createHash("sha256").update(JSON.stringify([stored ?? null, limits ?? null])).digest("hex"),
    valid: true,
    reason: null,
  }
}

export async function readAdaptivePolicy(root: string, dataDir?: string): Promise<AdaptivePolicyState> {
  try {
    return await load(await adaptivePaths(root, dataDir))
  } catch {
    return { config: { ...defaultAdaptivePolicy }, revision: "invalid", valid: false, reason: "invalid-policy" }
  }
}

/** Host UI only. This does not connect a provider or change a session/model. */
export async function writeAdaptiveConsent(root: string, config: AdaptivePolicy, expectedRevision: string, dataDir?: string) {
  const parsed = AdaptivePolicySchema.safeParse(config)
  if (!parsed.success) throw new Error("Invalid adaptive policy")
  // No live binding receipt or spend-accounting integration has been accepted yet.
  if (parsed.data.mode === "adaptive") throw new Error("Adaptive binding is not verified")
  const paths = await adaptivePaths(root, dataDir)
  // Create the private parent before Flock creates its lock directory.
  await mkdir(paths.directory, { recursive: true, mode: 0o700 })
  return Flock.withLock(`adaptive-policy:${paths.consent}`, async () => {
    const current = await readAdaptivePolicy(root, dataDir)
    if (!current.valid || current.revision !== expectedRevision) throw new Error("Adaptive policy changed; reload before saving")
    await mkdir(paths.directory, { recursive: true, mode: 0o700 })
    const temporary = path.join(paths.directory, `${randomUUID()}.tmp`)
    await writeFile(temporary, JSON.stringify({ revision: randomUUID(), config: parsed.data }) + "\n", { mode: 0o600, flag: "wx" })
    await rename(temporary, paths.consent)
    return readAdaptivePolicy(root, dataDir)
  }, { dir: path.join(paths.directory, ".locks"), timeoutMs: 5_000 })
}
