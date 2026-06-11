import { existsSync } from "fs"
import { readFile } from "fs/promises"
import path from "path"
import { ConfigParse } from "@/config/parse"
import type { MendPackageManifest } from "@/mend/sdk/package"

function ensureObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`)
  return value as Record<string, unknown>
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : []
}

function parseArtifacts(value: unknown): MendPackageManifest["artifacts"] | undefined {
  if (!value) return undefined
  const obj = ensureObject(value, "Package artifacts")
  return {
    ...(stringArray(obj.commands).length ? { commands: stringArray(obj.commands) } : {}),
    ...(stringArray(obj.agents).length ? { agents: stringArray(obj.agents) } : {}),
    ...(stringArray(obj.modes).length ? { modes: stringArray(obj.modes) } : {}),
    ...(stringArray(obj.skills).length ? { skills: stringArray(obj.skills) } : {}),
    ...(stringArray(obj.plugins).length ? { plugins: stringArray(obj.plugins) } : {}),
    ...(stringArray(obj.prompts).length ? { prompts: stringArray(obj.prompts) } : {}),
    ...(stringArray(obj.mcp).length ? { mcp: stringArray(obj.mcp) } : {}),
    ...(typeof obj.tuiProfile === "string" ? { tuiProfile: obj.tuiProfile } : {}),
    ...(stringArray(obj.themes).length ? { themes: stringArray(obj.themes) } : {}),
    ...(stringArray(obj.context).length ? { context: stringArray(obj.context) } : {}),
    ...(typeof obj.worktreePolicy === "string" ? { worktreePolicy: obj.worktreePolicy } : {}),
    ...(stringArray(obj.extensions).length ? { extensions: stringArray(obj.extensions) } : {}),
  }
}

export const MEND_PACKAGE_MANIFEST_CANDIDATES = ["mend-package.json", path.join(".mendcode", "package.json")]

export function parseMendPackageManifest(raw: unknown, sourceLabel = "Mend package manifest"): MendPackageManifest {
  const value = ensureObject(raw, sourceLabel)
  if (value.version !== 0) throw new Error(`${sourceLabel} version is unsupported`)
  if (typeof value.id !== "string" || !value.id.trim()) throw new Error(`${sourceLabel} requires string id`)
  const compatibility = value.compatibility ? ensureObject(value.compatibility, `${sourceLabel} compatibility`) : null
  const distribution = value.distribution ? ensureObject(value.distribution, `${sourceLabel} distribution`) : null
  const source = distribution?.source ? ensureObject(distribution.source, `${sourceLabel} distribution.source`) : null
  const trust = distribution?.trust ? ensureObject(distribution.trust, `${sourceLabel} distribution.trust`) : null
  return {
    version: 0,
    id: value.id,
    ...(typeof value.packageVersion === "string" ? { packageVersion: value.packageVersion } : {}),
    ...(typeof value.title === "string" ? { title: value.title } : {}),
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    ...(typeof value.kind === "string" ? { kind: value.kind } : {}),
    ...(typeof value.channel === "string" ? { channel: value.channel } : {}),
    ...(compatibility ? {
      compatibility: {
        ...(typeof compatibility.mendcode === "string" ? { mendcode: compatibility.mendcode } : {}),
        ...(typeof compatibility.runtimePack === "string" ? { runtimePack: compatibility.runtimePack } : {}),
      },
    } : {}),
    ...(parseArtifacts(value.artifacts) ? { artifacts: parseArtifacts(value.artifacts) } : {}),
    ...(distribution ? {
      distribution: {
        ...(source ? {
          source: {
            ...(typeof source.type === "string" ? { type: source.type } : {}),
            ...(typeof source.url === "string" || source.url === null ? { url: source.url } : {}),
          },
        } : {}),
        ...(trust ? {
          trust: {
            ...(typeof trust.signatureRequired === "boolean" ? { signatureRequired: trust.signatureRequired } : {}),
          },
        } : {}),
      },
    } : {}),
  }
}

export async function readMendPackageManifest(stageDir: string) {
  for (const candidate of MEND_PACKAGE_MANIFEST_CANDIDATES) {
    const file = path.join(stageDir, candidate)
    if (!existsSync(file)) continue
    const parsed = ConfigParse.jsonc(await readFile(file, "utf8"), file)
    return {
      path: path.relative(stageDir, file),
      manifest: parseMendPackageManifest(parsed, `Mend package manifest ${path.relative(stageDir, file)}`),
    }
  }
  return null
}
