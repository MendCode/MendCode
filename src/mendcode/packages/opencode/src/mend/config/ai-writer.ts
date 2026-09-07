import { createHash, randomUUID } from "node:crypto"
import { access, link, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import { Global } from "@mendcode/core/global"
import { applyEdits, modify, parse } from "jsonc-parser"
import { Lock } from "@/util/lock"

export type ConfigScope = "project" | "global"

export type ConfigTarget = {
  scope: ConfigScope
  path: string
  format: "json" | "jsonc"
  exists: boolean
  writable: boolean
  digest: string
}

export type AIConfigPatch = {
  ai?: unknown
  compaction?: unknown
}

export type ResolveTargetInput = {
  scope: ConfigScope
  root: string
  target?: string
  globalDir?: string
}

export type AIConfigWriteResult = {
  target: ConfigTarget
  changed: boolean
  beforeHash: string
  afterHash: string
  backupPath?: string
}

export type AIConfigWriteErrorCode = "invalid" | "ambiguous" | "conflict" | "permission" | "io"

export class AIConfigWriteError extends Error {
  readonly code: AIConfigWriteErrorCode
  readonly status: 400 | 403 | 409 | 422 | 500
  readonly details?: Record<string, unknown>

  constructor(
    code: AIConfigWriteErrorCode,
    message: string,
    options?: { details?: Record<string, unknown>; cause?: unknown },
  ) {
    super(message, { cause: options?.cause })
    this.name = "AIConfigWriteError"
    this.code = code
    this.status = code === "permission" ? 403 : code === "conflict" ? 409 : code === "ambiguous" ? 422 : code === "io" ? 500 : 400
    this.details = options?.details
  }
}

const EMPTY_DIGEST = createHash("sha256").update("").digest("hex")
const PROJECT_NAMES = [
  ["mendcode.jsonc", "jsonc"],
  ["mendcode.json", "json"],
  [".mendcode/mendcode.jsonc", "jsonc"],
  [".mendcode/mendcode.json", "json"],
  ["opencode.jsonc", "jsonc"],
  ["opencode.json", "json"],
  [".opencode/opencode.jsonc", "jsonc"],
  [".opencode/opencode.json", "json"],
] as const

function digest(text: string) {
  return createHash("sha256").update(text).digest("hex")
}

function absolute(value: string) {
  if (!value || !path.isAbsolute(value)) throw new AIConfigWriteError("invalid", "Configuration paths must be absolute.")
  return path.resolve(value)
}

function formatFor(file: string): ConfigTarget["format"] {
  return file.endsWith(".jsonc") ? "jsonc" : "json"
}

function candidatePaths(input: Pick<ResolveTargetInput, "scope" | "root" | "globalDir">) {
  if (input.scope === "global") {
    const directory = absolute(input.globalDir ?? Global.Path.config)
    return [path.join(directory, "mendcode.jsonc"), path.join(directory, "mendcode.json")]
  }
  const root = absolute(input.root)
  return PROJECT_NAMES.map(([file]) => path.join(root, file))
}

async function exists(file: string) {
  return access(file, constants.F_OK).then(
    () => true,
    (error: unknown) => {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false
      throw error
    },
  )
}

async function writable(file: string, present: boolean) {
  if (present) return access(file, constants.W_OK).then(() => true, () => false)
  let directory = path.dirname(file)
  for (;;) {
    if (await exists(directory)) return access(directory, constants.W_OK).then(() => true, () => false)
    const parent = path.dirname(directory)
    if (parent === directory) return false
    directory = parent
  }
}

async function targetFor(scope: ConfigScope, file: string): Promise<ConfigTarget> {
  const present = await exists(file)
  const text = present ? await readFile(file, "utf8") : ""
  return {
    scope,
    path: file,
    format: formatFor(file),
    exists: present,
    writable: await writable(file, present),
    digest: present ? digest(text) : EMPTY_DIGEST,
  }
}

export async function discoverConfigTargets(input: Pick<ResolveTargetInput, "scope" | "root" | "globalDir">) {
  const files = candidatePaths(input)
  return Promise.all(files.map((file) => targetFor(input.scope, file)))
}

export async function resolveConfigTarget(input: ResolveTargetInput) {
  const root = absolute(input.root)
  const globalDir = absolute(input.globalDir ?? Global.Path.config)
  const candidates = await discoverConfigTargets({ scope: input.scope, root, globalDir })
  if (input.target) {
    const requested = absolute(input.target)
    const target = candidates.find((candidate) => candidate.path === requested)
    if (!target) {
      throw new AIConfigWriteError("invalid", "Target is not one of the supported project/global configuration files.", {
        details: { scope: input.scope, target: requested, candidates: candidates.map((candidate) => candidate.path) },
      })
    }
    return target
  }

  const present = candidates.filter((candidate) => candidate.exists)
  if (present.length > 1) {
    throw new AIConfigWriteError("ambiguous", "More than one supported configuration file exists; choose an exact target.", {
      details: { scope: input.scope, candidates: present.map((candidate) => candidate.path) },
    })
  }
  if (present.length === 1) return present[0]
  return candidates[0]
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

export function validatePatch(patch: unknown): asserts patch is AIConfigPatch {
  if (!record(patch)) throw new AIConfigWriteError("invalid", "Configuration patch must be a JSON object.")
  const keys = Object.keys(patch)
  const unsupported = keys.filter((key) => key !== "ai" && key !== "compaction")
  if (unsupported.length) {
    throw new AIConfigWriteError("invalid", "Configuration patches may change only ai and compaction.", {
      details: { unsupported },
    })
  }
  for (const key of keys) {
    if (patch[key] === undefined) throw new AIConfigWriteError("invalid", `Patch field '${key}' cannot be undefined.`)
  }
}

export function parseConfigObject(text: string, file: string) {
  const errors: Array<{ offset: number; length: number; error: number }> = []
  const value = parse(text || "{}", errors, { allowTrailingComma: true })
  if (errors.length || !record(value)) {
    throw new AIConfigWriteError("invalid", `Configuration file '${file}' is not a valid JSON object.`, {
      details: { parseErrors: errors.length },
    })
  }
  return value
}

function applyPatchAt(text: string, patch: Record<string, unknown>, pathPrefix: string[] = []): string {
  return Object.entries(patch).reduce((result, [key, value]) => {
    if (record(value)) return applyPatchAt(result, value, [...pathPrefix, key])
    return applyEdits(
      result,
      modify(result, [...pathPrefix, key], value, {
        formattingOptions: {
          insertSpaces: true,
          tabSize: 2,
          eol: result.includes("\r\n") ? "\r\n" : "\n",
        },
      }),
    )
  }, text)
}

export function applyJsoncPatch(text: string, patch: unknown, file = "configuration") {
  validatePatch(patch)
  parseConfigObject(text, file)
  return applyPatchAt(text || "{}", patch)
}

export async function readConfigTarget(target: ConfigTarget) {
  if (!target.exists) return ""
  try {
    return await readFile(target.path, "utf8")
  } catch (error) {
    throw new AIConfigWriteError("io", `Unable to read configuration target '${target.path}'.`, { cause: error })
  }
}

function tempName(file: string) {
  return path.join(path.dirname(file), `.${path.basename(file)}.mendcode-${process.pid}-${randomUUID()}.tmp`)
}

export async function writeAIConfig(input: {
  root: string
  scope: ConfigScope
  target?: string
  expectedHash: string
  patch: unknown
  globalDir?: string
}): Promise<AIConfigWriteResult> {
  validatePatch(input.patch)
  if (!/^[a-f0-9]{64}$/.test(input.expectedHash)) {
    throw new AIConfigWriteError("invalid", "expectedHash must be a SHA-256 digest.")
  }
  // Shared-backend clients must serialize discovery, digest validation and commit.
  using lock = await Lock.write(`ai-config:${input.scope}:${absolute(input.scope === "global" ? input.globalDir ?? Global.Path.config : input.root)}`)
  const selected = await resolveConfigTarget(input)
  const before = await readConfigTarget(selected)
  const beforeHash = selected.exists ? digest(before) : EMPTY_DIGEST
  if (beforeHash !== input.expectedHash) {
    throw new AIConfigWriteError("conflict", "Configuration target changed since the preview was created.", {
      details: { target: selected.path, expectedHash: input.expectedHash, actualHash: beforeHash },
    })
  }

  const next = applyJsoncPatch(before, input.patch, selected.path)
  parseConfigObject(next, selected.path)
  const afterHash = digest(next)
  if (next === before) return { target: selected, changed: false, beforeHash, afterHash }

  if (!selected.writable) {
    throw new AIConfigWriteError("permission", `Configuration target '${selected.path}' is not writable.`)
  }

  let backupPath: string | undefined
  let temp: string | undefined
  try {
    await mkdir(path.dirname(selected.path), { recursive: true })
    if (selected.exists) {
      const backupDir = path.join(path.dirname(selected.path), ".mendcode-backups")
      await mkdir(backupDir, { recursive: true, mode: 0o700 })
      backupPath = path.join(backupDir, `${path.basename(selected.path)}.${beforeHash}.bak`)
      // Preserve exactly the validated bytes, never a later concurrent edit.
      await writeFile(backupPath, before, { mode: 0o600, flag: "wx" }).catch(async (error: unknown) => {
        if (error && typeof error === "object" && "code" in error && error.code === "EEXIST" && await readFile(backupPath!, "utf8") === before) return
        throw error
      })
    }
    temp = tempName(selected.path)
    const mode = selected.exists ? (await stat(selected.path)).mode & 0o777 : 0o600
    await writeFile(temp, next, { encoding: "utf8", mode, flag: "wx" })
    const current = await readFile(selected.path, "utf8").catch((error: unknown) => {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined
      throw error
    })
    if ((current !== undefined) !== selected.exists || (current ?? "") !== before) {
      throw new AIConfigWriteError("conflict", "Configuration target changed during apply; nothing was overwritten.", {
        details: { target: selected.path, expectedHash: beforeHash, actualHash: digest(current ?? "") },
      })
    }
    if (selected.exists) {
      await rename(temp, selected.path)
      temp = undefined
    } else {
      // Atomic create: a file appearing after the final read is never overwritten.
      await link(temp, selected.path).catch((error: unknown) => {
        if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") throw new AIConfigWriteError("conflict", "Configuration target was created during apply; nothing was overwritten.")
        throw error
      })
    }
  } catch (error) {
    if (error instanceof AIConfigWriteError) throw error
    const code = error && typeof error === "object" && "code" in error ? error.code : undefined
    throw new AIConfigWriteError(code === "EACCES" || code === "EPERM" ? "permission" : "io", `Unable to replace configuration target '${selected.path}'.`, {
      cause: error,
      details: { target: selected.path },
    })
  } finally {
    if (temp) await unlink(temp).catch(() => undefined)
  }

  return {
    target: { ...selected, exists: true, digest: afterHash },
    changed: true,
    beforeHash,
    afterHash,
    ...(backupPath ? { backupPath } : {}),
  }
}

export { EMPTY_DIGEST }
