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

function encodeRandom(bytes: Uint8Array) {
  let out = ""
  for (let i = 0; i < 16; i++) out += CROCKFORD[(bytes[i] ?? 0) % 32]
  return out
}

function incrementBase32(value: string) {
  const chars = value.split("")
  for (let i = chars.length - 1; i >= 0; i--) {
    const index = CROCKFORD.indexOf(chars[i] ?? "0")
    if (index < 31) {
      chars[i] = CROCKFORD[index + 1] ?? "0"
      return chars.join("")
    }
    chars[i] = "0"
  }
  throw new RangeError("[PROTOCOL]: ULID random component overflow")
}

/** Sortable, prefixed ULID. `now` and `random` are injectable so the kernel stays deterministic under simulation. */
export function createIdFactory(options: { now?: () => number; random?: (size: number) => Uint8Array } = {}) {
  const now = options.now ?? Date.now
  const random = options.random ?? ((size: number) => crypto.getRandomValues(new Uint8Array(size)))
  let lastTime = -1
  let lastRandom = ""
  return function nextId<K extends IdKind>(kind: K): IdOf[K] {
    const time = now()
    if (!Number.isSafeInteger(time) || time < 0) throw new RangeError(`[PROTOCOL]: invalid clock value ${time}`)
    let body = encodeRandom(random(16))
    if (time === lastTime && body <= lastRandom) body = incrementBase32(lastRandom)
    lastTime = time
    lastRandom = body
    return `${ID_PREFIXES[kind]}_${encodeTime(time)}${body}` as IdOf[K]
  }
}
