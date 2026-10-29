import { UpgradeError } from "./errors"
import type { Channel } from "./releases"

export type ReleaseIndex = {
  formatVersion: 1
  repository: string
  tag: string
  channel: Channel
  schema: { version: number; fingerprint: string }
  assets: Array<{ name: string; sha256: string; size: number }>
}
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value)

/** Verified metadata binds binary bytes and rollback compatibility to the exact release. */
export function validateReleaseIndex(value: unknown, expected: { repo: string; tag: string; channel: Channel; asset: string; sha256: string; size: number }): ReleaseIndex {
  const row = value as ReleaseIndex | null
  const fail = () => { throw new UpgradeError("provenance", "release index identity, assets or schema are invalid; use external recovery for legacy releases") }
  if (!row || row.formatVersion !== 1 || row.repository !== expected.repo || row.tag !== expected.tag || row.channel !== expected.channel || !row.schema || !Number.isSafeInteger(row.schema.version) || row.schema.version < 1 || !digest(row.schema.fingerprint) || !Array.isArray(row.assets) || row.assets.length === 0 || row.assets.length > 64) return fail()
  const names = new Set<string>()
  for (const asset of row.assets) {
    if (!asset || typeof asset.name !== "string" || !/^mendcode-[a-zA-Z0-9.-]+$/.test(asset.name) || names.has(asset.name) || !digest(asset.sha256) || !Number.isSafeInteger(asset.size) || asset.size < 1) return fail()
    names.add(asset.name)
  }
  const asset = row.assets.find((asset) => asset.name === expected.asset)
  if (!asset || asset.sha256 !== expected.sha256 || asset.size !== expected.size) return fail()
  return row
}
