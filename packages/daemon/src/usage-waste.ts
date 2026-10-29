import { FEATURES, type Settings, type UsageWasteReport, type WasteChange, type WasteFinding, type WasteWindow } from "@mendcode/protocol"
import type { UsageCallRow, UsageCompactionRow } from "@mendcode/store"

/**
 * The waste report (docs/usage.md, "Waste"). Everything is measured from what the providers reported for MendCode's own calls,
 * in each session's order: a cold return is a call after a pause whose cache read collapsed, not a guess from the clock; a break is
 * the same collapse with the cache still warm. Nothing here reads another program's logs.
 */

/** USD per million tokens, as models.dev and the budget tariffs write them. */
export type WastePrice = { input: number; output: number; cacheRead?: number | undefined; cacheWrite?: number | undefined }

export type WasteInput = {
  from: string
  to: string
  scope: UsageWasteReport["scope"]
  now: number
  calls: readonly UsageCallRow[]
  compactions: readonly UsageCompactionRow[]
  /** Calls and compactions of the last CHANGE_DAYS plus a window, for the comparison around recent changes. */
  recentCalls: readonly UsageCallRow[]
  recentCompactions: readonly UsageCompactionRow[]
  history: ReadonlyArray<{ at: number; settings: Record<string, unknown> }>
  settings: Settings
  titles(ids: readonly string[]): ReadonlyMap<string, string>
  price(provider: string, model: string): WastePrice | undefined
  /** The wire format of a configured provider (`anthropic`, `openai`...). */
  providerType(id: string): string | undefined
  feature(id: "idle_compact" | "wait_cache"): boolean
}

/** A context smaller than this is cheap to send again: no call after it counts as waste. */
export const WASTE_MIN_CONTEXT = 20_000
/** The shortest documented cache lifetime: a miss after a shorter pause is a break, after a longer one an expiry. */
const SHORT_LIFETIME_MS = 5 * 60_000
const LONG_LIFETIME_MS = 60 * 60_000
/** A read under half of what the call could have read is a miss. */
const MISS_SHARE = 0.5
/** A prompt this much smaller than the one before was compacted or cleared: its misses are expected. */
const SHRUNK_SHARE = 0.6
const BANDS = [0, 50_000, 100_000, 200_000] as const
const OVER = 200_000
export const CHANGE_DAYS = 90
const WINDOW_MS = 14 * 86_400_000
const DAY_MS = 86_400_000
const EARLY_TURNS = 10
/** The settings that decide what a request carries or how often the history is packed. The model is not one: its own tab compares models. */
const WATCHED = ["compactAtTokens", "idleCompactAtTokens", "promptCache", "promptCacheTtl", "claudeCacheTtl", "cacheLifetimeMinutes", "compaction", "modelContext", "tier", "handoffTokenCap"] as const
/** Changes of one setting this close together are one decision (a toggle tried and set back, a value typed twice). */
const SETTLE_MS = 10 * 60_000

/** What the call's prompt held: the engine's own count for an external engine (sums of a turn), else the three input counts. */
const promptOf = (call: UsageCallRow) => call.context ?? call.input + call.cacheRead + call.cacheWrite
const uncachedOf = (call: UsageCallRow) => call.input + call.cacheWrite

type Cost = { input: number; output: number; read: number; write: number }
function rates(price: WastePrice, call: Pick<UsageCallRow, "ttl">): Cost {
  // An hour's write costs twice the input (Anthropic); models.dev's cache_write is the 5-minute one.
  return { input: price.input, output: price.output, read: price.cacheRead ?? price.input, write: call.ttl === "1h" ? price.input * 2 : price.cacheWrite ?? price.input }
}

type Miss = { kind: "cold" | "break" | "switch"; call: UsageCallRow; before: UsageCallRow; resent: number }
/** The resent tokens at the price they were sent at: written to the cache where the call wrote, else plain input. */
function resentMicros(miss: Miss, rate: Cost) {
  const written = Math.min(miss.resent, miss.call.cacheWrite)
  return written * rate.write + (miss.resent - written) * rate.input
}
const extraMicros = (miss: Miss, rate: Cost) => resentMicros(miss, rate) - miss.resent * rate.read

/** Each session's misses, from the call before each call. */
function misses(calls: readonly UsageCallRow[], compactions: readonly UsageCompactionRow[]): Miss[] {
  const packed = new Map<string, number[]>()
  for (const row of compactions) if (row.state === "packed") packed.set(row.sessionId, [...(packed.get(row.sessionId) ?? []), row.at])
  const found: Miss[] = []
  let before: UsageCallRow | undefined
  for (const call of calls) {
    const previous = before?.sessionId === call.sessionId ? before : undefined
    before = call
    if (!previous) continue
    const held = promptOf(previous)
    if (held < WASTE_MIN_CONTEXT) continue
    if (promptOf(call) < held * SHRUNK_SHARE) continue
    if (packed.get(call.sessionId)?.some((at) => at > previous.at && at <= call.at)) continue
    const resent = Math.min(held, uncachedOf(call))
    // An external engine reports a turn's sums: its reads are not one call's, so only a large write after a pause says the cache was gone.
    const external = call.context !== null
    const missed = external ? resent >= held * MISS_SHARE : call.cacheRead < Math.min(held, promptOf(call)) * MISS_SHARE
    if (!missed) continue
    const gap = call.at - (call.durationMs ?? 0) - previous.at
    if (previous.provider !== call.provider || previous.model !== call.model) found.push({ kind: "switch", call, before: previous, resent })
    else if (gap >= (previous.ttl === "1h" ? LONG_LIFETIME_MS : SHORT_LIFETIME_MS)) found.push({ kind: "cold", call, before: previous, resent })
    else if (!external && call.compactAt !== null) found.push({ kind: "break", call, before: previous, resent })
  }
  return found
}

const compactTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${Math.round(n / 1_000)}K` : String(n))
function shown(value: unknown): string {
  if (value === undefined || value === null) return "default"
  if (typeof value === "boolean") return value ? "on" : "off"
  if (typeof value === "number") return Number.isInteger(value) && value >= 1_000 ? compactTokens(value) : String(value)
  if (typeof value === "string") return value
  return "edited"
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

function window(input: { calls: readonly UsageCallRow[]; compactions: readonly UsageCompactionRow[]; from: number; to: number; price: WasteInput["price"] }): WasteWindow {
  const calls = input.calls.filter((call) => call.at >= input.from && call.at < input.to)
  const compactions = input.compactions.filter((row) => row.state === "packed" && row.at >= input.from && row.at < input.to)
  const turns = new Set(calls.map((call) => call.turnId)).size
  const days = Math.max(0, (input.to - input.from) / DAY_MS)
  const prompt = calls.reduce((sum, call) => sum + promptOf(call), 0)
  const uncached = calls.reduce((sum, call) => sum + uncachedOf(call), 0)
  const costs = calls.map((call) => callCost(call, input.price))
  const known = costs.every((cost) => cost !== undefined) && calls.length > 0
  return {
    from: input.from, to: input.to, days: Math.round(days * 10) / 10, turns, calls: calls.length,
    promptPerTurn: turns ? Math.round(prompt / turns) : 0,
    uncachedPerTurn: turns ? Math.round(uncached / turns) : 0,
    over200k: calls.length ? Math.round((calls.filter((call) => promptOf(call) >= OVER).length / calls.length) * 1000) / 1000 : 0,
    compactionsPerDay: days ? Math.round((compactions.length / days) * 10) / 10 : 0,
    waitMsPerDay: days ? Math.round(compactions.reduce((sum, row) => sum + (row.waitMs ?? 0), 0) / days) : 0,
    ...(known && turns ? { costPerTurnMicros: Math.round(costs.reduce((sum, cost) => sum + cost!.total, 0) / turns) } : {}),
  }
}

/** A call's cost in micro-USD: what the provider billed, else its list price; with the split when a price is known. */
function callCost(call: UsageCallRow, price: WasteInput["price"]): { total: number; billed: boolean; split?: Cost } | undefined {
  const tariff = price(call.provider, call.model)
  const split = tariff ? (() => {
    const rate = rates(tariff, call)
    return { input: call.input * rate.input, output: (call.output + call.reasoning) * rate.output, read: call.cacheRead * rate.read, write: call.cacheWrite * rate.write }
  })() : undefined
  if (call.costMicros !== null) return { total: call.costMicros, billed: true, ...(split ? { split } : {}) }
  if (!split) return undefined
  return { total: Math.round(split.input + split.output + split.read + split.write), billed: false, split }
}

/** A setting's value at each point it changed, after folding a quick back-and-forth into what it settled on. */
type Transition = { at: number; key: string; from: unknown; to: unknown }

/** Features that change what a request carries or what MendCode spends calls on; a chrome-only feature costs no tokens. */
const COSTLY_FEATURES = new Set<string>(Object.entries(FEATURES).filter(([id, spec]) => spec.cost.some((cost) => cost !== "chrome") || id === "idle_compact" || id === "wait_cache" || id === "output_filters").map(([id]) => id))

function valueAt(settings: Record<string, unknown>, key: string) {
  if (!key.startsWith("features.")) return settings[key]
  return ((settings.features ?? {}) as Record<string, unknown>)[key.slice("features.".length)]
}

/** Each watched key's changes, oldest first: changes of one key within SETTLE_MS fold into one, and a fold that ends where it began is none. */
function transitions(history: WasteInput["history"]): Transition[] {
  const keys = new Set<string>(WATCHED)
  for (const entry of history) for (const id of Object.keys((entry.settings.features ?? {}) as object)) if (COSTLY_FEATURES.has(id)) keys.add(`features.${id}`)
  const out: Transition[] = []
  for (const key of keys) {
    let open: Transition | undefined
    for (let index = 1; index < history.length; index++) {
      const from = valueAt(history[index - 1]!.settings, key)
      const to = valueAt(history[index]!.settings, key)
      if (same(from, to)) continue
      const at = history[index]!.at
      if (open && at - open.at <= SETTLE_MS) { open.to = to; continue }
      if (open && !same(open.from, open.to)) out.push(open)
      open = { at, key, from, to }
    }
    if (open && !same(open.from, open.to)) out.push(open)
  }
  return out.sort((a, b) => a.at - b.at)
}

/** Recent changes of the settings that decide what a request costs, newest first: each one against the days before it. */
function changes(input: WasteInput): WasteChange[] {
  const since = input.now - CHANGE_DAYS * DAY_MS
  const current = input.settings as Record<string, unknown>
  const all = transitions(input.history)
  // Settings saved together are one decision: one comparison, one revert.
  const moments = [...new Set(all.map((change) => change.at))].sort((a, b) => a - b)
  const out: WasteChange[] = []
  moments.forEach((at, index) => {
    if (at < since) return
    const together = all.filter((change) => change.at === at)
    // Each side ends at the watched change next to it, so it measures one configuration.
    const previous = moments[index - 1] ?? 0
    const next = moments[index + 1] ?? input.now
    const before = window({ calls: input.recentCalls, compactions: input.recentCompactions, from: Math.max(previous, at - WINDOW_MS), to: at, price: input.price })
    const after = window({ calls: input.recentCalls, compactions: input.recentCompactions, from: at, to: Math.min(next, input.now, at + WINDOW_MS), price: input.price })
    if (before.calls === 0 && after.calls === 0) return
    const early = before.turns < EARLY_TURNS || after.turns < EARLY_TURNS || before.days < 1 || after.days < 1
    const reverts = together.map((change) => revertOf(change, current).revert)
    const revert = reverts.every(Boolean) ? mergeReverts(reverts as Array<Record<string, unknown>>, (current.features ?? {}) as Record<string, unknown>) : undefined
    out.push({
      at, keys: together.map((change) => change.key).slice(0, 12), label: together.map((change) => `${change.key} ${shown(change.from)} → ${shown(change.to)}`).join(" · ").slice(0, 600),
      before, after, ...(early ? { early: true as const } : {}), ...(revert ? { revert } : {}),
    })
  })
  return out.sort((a, b) => b.at - a.at).slice(0, 12)
}

/** One patch for changes made together. Each feature revert is the live features with its own feature put back, so only those differences are combined. */
function mergeReverts(reverts: Array<Record<string, unknown>>, live: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = {}
  let features: Record<string, unknown> | undefined
  for (const revert of reverts) {
    for (const [key, value] of Object.entries(revert)) {
      if (key !== "features") { merged[key] = value; continue }
      const next = value as Record<string, unknown>
      features ??= { ...live }
      for (const id of new Set([...Object.keys(live), ...Object.keys(next)])) {
        if (same(next[id], live[id])) continue
        if (next[id] === undefined) delete features[id]
        else features[id] = next[id]
      }
    }
  }
  return features ? { ...merged, features } : merged
}

/** The patch that puts a change back, while what it set is still in force. */
function revertOf(change: Transition, current: Record<string, unknown>): { revert?: Record<string, unknown> } {
  if (!same(valueAt(current, change.key), change.to)) return {}
  if (!change.key.startsWith("features.")) return { revert: { [change.key]: change.from ?? null } }
  const features = { ...((current.features ?? {}) as Record<string, unknown>) }
  const id = change.key.slice("features.".length)
  if (change.from === undefined) delete features[id]
  else features[id] = change.from
  return { revert: { features } }
}

export function analyzeWaste(input: WasteInput): UsageWasteReport {
  const { calls } = input
  const found = misses(calls, input.compactions)
  const split = { reread: 0, written: 0, fresh: 0, output: 0 }
  const splitMicros = { reread: 0, written: 0, fresh: 0, output: 0 }
  let splitKnown = 0
  const priced = { billed: 0, list: 0 }
  const bands = BANDS.map((min, index) => ({ min, ...(BANDS[index + 1] !== undefined ? { max: BANDS[index + 1]! } : {}), calls: 0, prompt: 0 }))
  type Top = { calls: number; turns: Set<string>; prompt: number; cost?: number; cold: number; peak: number; lastAt: number }
  const sessions = new Map<string, Top>()
  for (const call of calls) {
    split.reread += call.cacheRead
    split.written += call.cacheWrite
    split.fresh += call.input
    split.output += call.output + call.reasoning
    const cost = callCost(call, input.price)
    if (cost?.billed) priced.billed++
    else if (cost) priced.list++
    if (cost?.split) {
      splitKnown++
      splitMicros.reread += cost.split.read
      splitMicros.written += cost.split.write
      splitMicros.fresh += cost.split.input
      splitMicros.output += cost.split.output
    }
    const prompt = promptOf(call)
    const band = bands.findLast((entry) => prompt >= entry.min)!
    band.calls++
    band.prompt += prompt
    const top = sessions.get(call.sessionId) ?? { calls: 0, turns: new Set<string>(), prompt: 0, cold: 0, peak: 0, lastAt: 0 }
    top.calls++
    top.turns.add(call.turnId)
    top.prompt += prompt
    if (cost) top.cost = (top.cost ?? 0) + cost.total
    top.peak = Math.max(top.peak, prompt)
    top.lastAt = Math.max(top.lastAt, call.at)
    sessions.set(call.sessionId, top)
  }

  const cold = found.filter((miss) => miss.kind === "cold")
  const breaks = found.filter((miss) => miss.kind === "break")
  const switches = found.filter((miss) => miss.kind === "switch")
  for (const miss of cold) sessions.get(miss.call.sessionId)!.cold++
  let coldMicros = 0
  let warmMicros = 0
  let coldPriced = 0
  for (const miss of cold) {
    const tariff = input.price(miss.call.provider, miss.call.model)
    if (!tariff) continue
    const rate = rates(tariff, miss.call)
    coldMicros += resentMicros(miss, rate)
    warmMicros += miss.resent * rate.read
    coldPriced++
  }
  const topBy = calls.length > 0 && priced.billed + priced.list === calls.length ? "cost" : "prompt"
  const ranked = [...sessions.entries()].sort((a, b) => (topBy === "cost" ? (b[1].cost ?? 0) - (a[1].cost ?? 0) : 0) || b[1].prompt - a[1].prompt).slice(0, 8)
  const worst = [...cold].sort((a, b) => b.resent - a.resent).slice(0, 5)
  const titles = input.titles([...new Set([...ranked.map(([id]) => id), ...worst.map((miss) => miss.call.sessionId)])])
  const title = (id: string) => (titles.get(id) ?? "").slice(0, 200)
  const turns = new Set(calls.map((call) => call.turnId)).size
  const sum = (list: readonly Miss[]) => list.reduce((total, miss) => total + miss.resent, 0)
  const sessionsOf = (list: readonly Miss[]) => new Set(list.map((miss) => miss.call.sessionId)).size
  const compactions = { auto: 0, manual: 0, idle: 0, failed: 0, waitMs: 0 }
  for (const row of input.compactions) {
    if (row.state === "failed") { compactions.failed++; continue }
    compactions[row.reason]++
    compactions.waitMs += row.waitMs ?? 0
  }

  return {
    from: input.from, to: input.to, scope: input.scope,
    calls: calls.length, turns, sessions: sessions.size, priced, split,
    ...(splitKnown ? { splitMicros: { reread: Math.round(splitMicros.reread), written: Math.round(splitMicros.written), fresh: Math.round(splitMicros.fresh), output: Math.round(splitMicros.output) } } : {}),
    bands,
    cold: {
      count: cold.length, sessions: sessionsOf(cold), resent: sum(cold),
      ...(coldPriced ? { micros: Math.round(coldMicros), warmMicros: Math.round(warmMicros), priced: coldPriced } : {}),
      worst: worst.map((miss) => ({ sessionId: miss.call.sessionId, title: title(miss.call.sessionId), at: miss.call.at, gapMs: Math.max(0, miss.call.at - (miss.call.durationMs ?? 0) - miss.before.at), tokens: miss.resent })),
    },
    breaks: { count: breaks.length, sessions: sessionsOf(breaks), resent: sum(breaks) },
    switches: { count: switches.length, resent: sum(switches) },
    compactions,
    topBy,
    top: ranked.map(([sessionId, top]) => ({ sessionId, title: title(sessionId), calls: top.calls, turns: top.turns.size, prompt: top.prompt, ...(top.cost !== undefined ? { costMicros: Math.round(top.cost) } : {}), cold: top.cold, peak: top.peak, lastAt: top.lastAt })),
    findings: findings(input, { cold, breaks, switches }),
    changes: changes(input),
  }
}

/** What to change, from the misses and the sizes of this range. Each finding stands alone: their savings overlap and are never added. */
function findings(input: WasteInput, found: { cold: Miss[]; breaks: Miss[]; switches: Miss[] }): WasteFinding[] {
  const out: WasteFinding[] = []
  const settings = input.settings
  const features = (settings.features ?? {}) as Record<string, boolean>
  /** What the misses cost above reading the same tokens from a warm cache. */
  const micros = (list: readonly Miss[]) => {
    let total = 0
    let known = false
    for (const miss of list) {
      const tariff = input.price(miss.call.provider, miss.call.model)
      if (!tariff) continue
      known = true
      total += extraMicros(miss, rates(tariff, miss.call))
    }
    return known ? { costMicros: Math.max(0, Math.round(total)) } : {}
  }
  const tokens = (list: readonly Miss[]) => list.reduce((sum, miss) => sum + miss.resent, 0)

  // Native sessions MendCode packs, large enough for the idle compaction: it reads them at the cached price before the expiry.
  const idleAt = settings.idleCompactAtTokens ?? 100_000
  const idle = found.cold.filter((miss) => miss.before.compactAt !== null && promptOf(miss.before) >= idleAt)
  if (idle.length >= 2 && !input.feature("idle_compact")) {
    out.push({
      id: "idle_compact", certainty: "likely",
      title: "Compact while idle, before the cache expires",
      detail: `${idle.length} times a session of ${compactTokens(idleAt)}+ came back after its cache expired and sent ${compactTokens(tokens(idle))} again. One compaction just before the expiry reads it at the cached price and leaves a small context; it costs one summary call per pause.`,
      tokens: tokens(idle), ...micros(idle),
      fix: { label: "turn on idle_compact", patch: { features: { ...features, idle_compact: true } } },
    })
  }

  // Anthropic sessions whose pauses outlast 5 minutes but not an hour: a 1-hour write keeps them.
  const anthropic = (provider: string) => ["anthropic", "google-vertex-anthropic"].includes(input.providerType(provider) ?? "")
  const waits = found.cold.filter((miss) => anthropic(miss.call.provider) && miss.before.ttl === null && miss.call.at - miss.before.at <= LONG_LIFETIME_MS)
  if (waits.length >= 2 && !input.feature("wait_cache") && settings.promptCacheTtl !== "1h") {
    out.push({
      id: "wait_cache", certainty: "likely",
      title: "Keep the cache an hour after long waits",
      detail: `${waits.length} Anthropic calls came back between 5 minutes and an hour later and wrote ${compactTokens(tokens(waits))} again. After two such pauses the session writes at the 1-hour lifetime (twice the input price per write, read at the cached price).`,
      tokens: tokens(waits), ...micros(waits),
      fix: { label: "turn on wait_cache", patch: { features: { ...features, wait_cache: true } } },
    })
  }

  // Native calls past 200K: every one re-reads all of it. Compacting there trades a summary for a smaller prompt on every call after it.
  const native = input.calls.filter((call) => call.compactAt !== null)
  const over = native.filter((call) => promptOf(call) >= OVER)
  const compactAt = Math.max(0, ...native.map((call) => call.compactAt ?? 0))
  if (native.length >= 20 && over.length / native.length >= 0.2 && compactAt > OVER && (settings.compactAtTokens === undefined || settings.compactAtTokens > OVER)) {
    const excess = over.reduce((sum, call) => sum + promptOf(call) - OVER, 0)
    let excessMicros = 0
    let priced = false
    for (const call of over) {
      const tariff = input.price(call.provider, call.model)
      if (!tariff) continue
      priced = true
      excessMicros += (promptOf(call) - OVER) * rates(tariff, call).read
    }
    out.push({
      id: "compact_earlier", certainty: "test",
      title: "Compact at 200K",
      detail: `${Math.round((over.length / native.length) * 100)}% of calls carried over 200K tokens, ${compactTokens(excess)} above it in all, re-read on every call. Compacting at 200K is an upper bound on what it saves: it adds compactions and their waits, which the Changes section measures after you apply it.`,
      tokens: excess, ...(priced ? { costMicros: Math.round(excessMicros) } : {}),
      fix: { label: "compactAtTokens 200K", patch: { compactAtTokens: OVER } },
    })
  }

  // The cache was warm and the call still missed it: something in front of the conversation changed. Lineage keys keep routing stable.
  if (found.breaks.length >= 5 && tokens(found.breaks) >= 100_000 && (settings.promptCache ?? "legacy") !== "smart") {
    out.push({
      id: "prompt_cache", certainty: "likely",
      title: "Smart prompt-cache keys",
      detail: `${found.breaks.length} calls missed a cache that was still warm and sent ${compactTokens(tokens(found.breaks))} again. Smart keys follow each compaction's lineage and add breakpoints where the last request put them.`,
      tokens: tokens(found.breaks), ...micros(found.breaks),
      fix: { label: "promptCache smart", patch: { promptCache: "smart" } },
    })
  }

  if (found.switches.length >= 3 && tokens(found.switches) >= 100_000) {
    out.push({
      id: "model_switch", certainty: "clear",
      title: "Switch models at the start, not mid-session",
      detail: `${found.switches.length} model switches in long sessions sent ${compactTokens(tokens(found.switches))} to a model that had none of it cached. Switch in a new or forked session (/fork), or after a compaction.`,
      tokens: tokens(found.switches), ...micros(found.switches),
    })
  }
  return out
}
