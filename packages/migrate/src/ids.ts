import { createIdFactory, type IdKind } from "@mendcode/protocol"

const ID_RANDOM_BYTES = 16

/**
 * A valid v2 id computed from a v1 key: the same key always gives the same id, so a rerun finds what an earlier
 * run imported without any lookup table. `at` only places the id in time; it does not have to be unique.
 */
export function derivedId<K extends IdKind>(kind: K, key: string, at: number) {
  const digest = new Bun.CryptoHasher("sha256").update(`${kind}:${key}`).digest()
  const random = digest.subarray(0, ID_RANDOM_BYTES)
  return createIdFactory({ now: () => Math.max(0, Math.floor(at)), random: () => random })(kind)
}
