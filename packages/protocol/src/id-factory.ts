// No runtime dependency on zod: thin clients import this through "@mendcode/protocol/wire" (see wire.ts).
import type { ClientId, CommandId, GoalId, ItemId, JobId, LoopId, MemoryId, QueueId, RequestId, SessionId, TurnId, WorkflowId } from "./ids"

export const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

export const ID_PREFIXES = {
  session: "ses",
  turn: "trn",
  item: "itm",
  job: "job",
  client: "cli",
  request: "req",
  queue: "que",
  command: "cmd",
  memory: "mem",
  loop: "lop",
  workflow: "wfl",
  goal: "gol",
} as const

export type IdKind = keyof typeof ID_PREFIXES

type IdOf = {
  session: SessionId
  turn: TurnId
  item: ItemId
  job: JobId
  client: ClientId
  request: RequestId
  queue: QueueId
  command: CommandId
  memory: MemoryId
  loop: LoopId
  workflow: WorkflowId
  goal: GoalId
}

function encodeTime(ms: number) {
  let value = ms
  let out = ""
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[value % 32] + out
    value = Math.floor(value / 32)
  }
  return out
}

/** 2020-01-01: no id this factory made is older. */
const EARLIEST_ID_TIME = 1_577_836_800_000

/**
 * The creation time in an id this factory made (`prefix_` then ten time characters), or undefined for an id of another
 * shape or a time no factory id can carry (before 2020, or more than a day ahead of `now`).
 */
export function decodeIdTime(id: string, now = Date.now()): number | undefined {
  const body = id.slice(id.indexOf("_") + 1)
  if (body.length < 10 + ID_RANDOM_CHARS) return undefined
  let value = 0
  for (let i = 0; i < 10; i++) {
    const digit = CROCKFORD.indexOf(body[i]!)
    if (digit < 0) return undefined
    value = value * 32 + digit
  }
  return value >= EARLIEST_ID_TIME && value <= now + 86_400_000 ? value : undefined
}

/**
 * Random characters after the 10 time characters. Ids are stored in many rows of every session, so new ids carry 30 random bits
 * (6 characters) instead of a full ULID's 80; one factory never repeats within a millisecond, and ids written with the older
 * 16-character tail keep validating and sorting by time.
 */
export const ID_RANDOM_CHARS = 6

function encodeRandom(bytes: Uint8Array) {
  let out = ""
  for (let i = 0; i < ID_RANDOM_CHARS; i++) out += CROCKFORD[(bytes[i] ?? 0) % 32]
  return out
}

/** The next value of the same width, or undefined when every character is already the last one. */
function incrementBase32(value: string): string | undefined {
  const chars = value.split("")
  for (let i = chars.length - 1; i >= 0; i--) {
    const index = CROCKFORD.indexOf(chars[i] ?? "0")
    if (index < 31) {
      chars[i] = CROCKFORD[index + 1] ?? "0"
      return chars.join("")
    }
    chars[i] = "0"
  }
  return undefined
}

/** Sortable, prefixed ULID. `now` and `random` are injectable so the kernel stays deterministic under simulation. */
export function createIdFactory(options: { now?: () => number; random?: (size: number) => Uint8Array } = {}) {
  const now = options.now ?? Date.now
  const random = options.random ?? ((size: number) => crypto.getRandomValues(new Uint8Array(size)))
  let lastTime = -1
  let lastRandom = ""
  return function nextId<K extends IdKind>(kind: K): IdOf[K] {
    let time = now()
    if (!Number.isSafeInteger(time) || time < 0) throw new RangeError(`[PROTOCOL]: invalid clock value ${time}`)
    let body = encodeRandom(random(ID_RANDOM_CHARS))
    // Within one millisecond ids keep rising; when the random part runs out, the id moves to the next millisecond (still
    // sorted, never thrown), and later calls in the real millisecond keep rising from there.
    if (time <= lastTime && lastTime - time < 1_000 && (time < lastTime || body <= lastRandom)) {
      const next = incrementBase32(lastRandom)
      if (next === undefined) [time, body] = [lastTime + 1, "0".repeat(ID_RANDOM_CHARS)]
      else [time, body] = [lastTime, next]
    }
    lastTime = time
    lastRandom = body
    return `${ID_PREFIXES[kind]}_${encodeTime(time)}${body}` as IdOf[K]
  }
}
