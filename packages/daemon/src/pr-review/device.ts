import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { z } from "zod"

/**
 * This daemon's device identity for the review platform (decision 5): a random id that names the owner of a watch, a lease or a
 * PR claim, and a label (the hostname) that only helps a person tell `laptop` from `vps`. Neither is a secret or a credential:
 * both may appear in a claim marker on a pull request. Kept at `<dataDir>/pr-review/device.json` (0600) so the id survives
 * restarts; a second data directory on the same machine is a second device, which is what it behaves as.
 */

export const DeviceIdentity = z.object({
  version: z.literal(1),
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  label: z.string().max(64),
  createdAt: z.number().int().nonnegative(),
})
export type DeviceIdentity = z.infer<typeof DeviceIdentity>

export const devicePath = (dataDir: string) => path.join(dataDir, "pr-review", "device.json")

/** A hostname cut to something safe to show on a pull request: no spaces, no markup, at most 64 characters. */
const labelOf = (name: string) => name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "device"

const readDevice = (file: string) => {
  try {
    const parsed = DeviceIdentity.safeParse(JSON.parse(readFileSync(file, "utf8")))
    return parsed.success ? parsed.data : undefined
  } catch { return undefined }
}

/**
 * The persisted device identity, created on first use. Two processes starting together agree: the file is published with a hard
 * link, which fails when another one won, and that one is read back. A damaged file is replaced by a new identity (its leases
 * then expire as any absent owner's would).
 */
export function deviceId(dataDir: string, { now = Date.now, hostname = os.hostname }: { now?: () => number; hostname?: () => string } = {}): DeviceIdentity {
  const file = devicePath(dataDir)
  const existing = readDevice(file)
  if (existing) return existing
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const identity: DeviceIdentity = { version: 1, id: crypto.randomUUID(), label: labelOf(hostname()), createdAt: now() }
  const temp = `${file}.${crypto.randomUUID()}.tmp`
  writeFileSync(temp, JSON.stringify(identity), { mode: 0o600, flag: "wx" })
  try {
    try { linkSync(temp, file) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      const winner = readDevice(file)
      if (winner) return winner
      // A damaged file: replace it with this identity (a rename over it is atomic).
      renameSync(temp, file)
    }
    return identity
  } finally { rmSync(temp, { force: true }) }
}
