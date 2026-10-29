import { createHash } from "node:crypto"
import { UpgradeError } from "./errors"

const SUM_LINE = /^([0-9a-fA-F]{64}) [ *]?(.+)$/

export function sha256Hex(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex")
}

/** Reads `sha256sum` output: `<64 hex>  <name>` (a `*` before the name marks binary mode). */
export function parseSums(text: string) {
  const sums = new Map<string, string>()
  for (const line of text.split("\n")) {
    const match = SUM_LINE.exec(line.trim())
    if (!match) continue
    const name = match[2]!.trim()
    if (sums.has(name)) throw new UpgradeError("checksum-mismatch", `SHA256SUMS has duplicate entries for ${name}; refusing to install`)
    sums.set(name, match[1]!.toLowerCase())
  }
  return sums
}

/** The expected digest of `name`; a missing entry refuses the install like a mismatch does. */
export function expectedSum(sums: Map<string, string>, name: string) {
  const sum = sums.get(name)
  if (!sum) throw new UpgradeError("checksum-missing", `SHA256SUMS has no entry for ${name}; refusing to install an unverified binary`)
  return sum
}

export function verifyChecksum({ name, bytes, expected }: { name: string; bytes: Uint8Array; expected: string }) {
  const actual = sha256Hex(bytes)
  if (actual !== expected) throw new UpgradeError("checksum-mismatch", `${name} does not match SHA256SUMS (expected ${expected}, got ${actual}); refusing to install`)
}
