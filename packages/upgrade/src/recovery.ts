import path from "node:path"
import { sha256Hex } from "./checksum"
import { UpgradeError } from "./errors"
import { binPaths } from "./install"
import type { UpgradeFs } from "./ports"

type Identity = { version: string; sha256: string; schema: { version: number; fingerprint: string } }
export type RecoveryRecord = { current: Identity; previous: Identity | null }
const file = (dir: string) => path.join(dir, "upgrade-recovery.json")
const valid = (value: unknown): value is Identity => {
  const row = value as Identity | null
  return !!row && typeof row.version === "string" && /^(?:v\d{1,9}\.\d{1,9}\.\d{1,9}(?:-(?:beta\.\d{1,9}|nightly\.\d{8}\.[1-9]\d{0,8}))?|dev-[a-f0-9]{7,40})$/.test(row.version) && typeof row.sha256 === "string" && /^[a-f0-9]{64}$/.test(row.sha256) && !!row.schema && Number.isSafeInteger(row.schema.version) && row.schema.version > 0 && /^[a-f0-9]{64}$/.test(row.schema.fingerprint)
}
export async function readRecovery(fs: UpgradeFs, dir: string): Promise<RecoveryRecord | undefined> {
  try {
    const row = JSON.parse(await fs.readText(file(dir)) ?? "null")
    return row && valid(row.current) && (row.previous === null || valid(row.previous)) ? row : undefined
  } catch { return undefined }
}
export async function writeRecovery(fs: UpgradeFs, dir: string, record: RecoveryRecord) {
  const target = file(dir)
  await fs.writeFile(`${target}.tmp`, new TextEncoder().encode(JSON.stringify(record) + "\n"))
  await fs.rename(`${target}.tmp`, target)
}
export async function verifyRecovery(fs: UpgradeFs, dir: string) {
  const record = await readRecovery(fs, dir)
  if (!record?.previous) throw new UpgradeError("no-previous", "no verified rollback identity; use external recovery for legacy installations")
  if (record.previous.schema.version !== record.current.schema.version || record.previous.schema.fingerprint !== record.current.schema.fingerprint) throw new UpgradeError("no-previous", "retained executable schema compatibility differs; use external recovery (data is never restored)")
  const paths = binPaths(dir)
  for (const [target, identity] of [[paths.current, record.current], [paths.prev, record.previous]] as const) {
    if (sha256Hex(await fs.readBytes(target)) !== identity.sha256) throw new UpgradeError("checksum-mismatch", "retained executable identity changed; rollback refused")
  }
  return record
}
