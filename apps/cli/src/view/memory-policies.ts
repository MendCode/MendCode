import type { MemoryCategoryInfo } from "@mendcode/protocol"
import type { ColorName, Line } from "../ui/theme"
import { clip, fit } from "./deck"
import { truncateEnd } from "./session-list"
import { wrap } from "./wrap"

/**
 * The Policies tab of /memory: per category, what becomes of a memory the agent, Dream or Evolution proposes
 * (`auto` saved, `review` kept as Pending, `never` dropped). Each change is one `memory.policy` command. Pure.
 */
export type MemoryPolicy = MemoryCategoryInfo["policy"]
export type PoliciesState = { row: number }
export type PoliciesAction = { type: "none" } | { type: "close" } | { type: "policy"; category: MemoryCategoryInfo["id"]; policy: MemoryPolicy }

export const POLICIES_HINTS = "↑↓ category · ←→ policy · a auto · r review · n never · d default · tab/1-7 tabs · esc back"

const POLICY_ORDER: readonly MemoryPolicy[] = ["auto", "review", "never"]
const POLICY_TONE: Record<MemoryPolicy, ColorName> = { auto: "warning", review: "text", never: "muted" }
const POLICY_MEANING: Record<MemoryPolicy, string> = { auto: "saved straight away", review: "waits in Pending", never: "dropped" }
const NONE: PoliciesAction = { type: "none" }
const UP = new Set(["\x1b[A", "\x1bOA", "k"])
const DOWN = new Set(["\x1b[B", "\x1bOB", "j"])
const LEFT = new Set(["\x1b[D", "\x1bOD", "h"])
const RIGHT = new Set(["\x1b[C", "\x1bOC", "l", " ", "\r", "\n"])
const DIRECT: Readonly<Record<string, MemoryPolicy>> = { a: "auto", r: "review", n: "never" }
const NAME_WIDTH = 14
const VALUE_WIDTH = 10
const NOTE_WIDTH = 18

export function createPoliciesState(): PoliciesState {
  return { row: 0 }
}

const clamp = (value: number, length: number) => Math.max(0, Math.min(value, length - 1))

export function policiesKey(state: PoliciesState, key: string, categories: readonly MemoryCategoryInfo[] | undefined): { state: PoliciesState; action: PoliciesAction } {
  if (key === "\x1b") return { state, action: { type: "close" } }
  const list = categories ?? []
  const row = clamp(state.row, list.length)
  const current = list[row]
  const move = (to: number) => {
    const next = clamp(to, list.length)
    return next === state.row ? { state, action: NONE } : { state: { row: next }, action: NONE }
  }
  if (UP.has(key)) return move(row - 1)
  if (DOWN.has(key)) return move(row + 1)
  if (!current) return { state, action: NONE }
  const set = (policy: MemoryPolicy): { state: PoliciesState; action: PoliciesAction } => (policy === current.policy ? { state, action: NONE } : { state, action: { type: "policy", category: current.id, policy } })
  const at = POLICY_ORDER.indexOf(current.policy)
  if (LEFT.has(key)) return set(POLICY_ORDER[(at + POLICY_ORDER.length - 1) % POLICY_ORDER.length]!)
  if (RIGHT.has(key)) return set(POLICY_ORDER[(at + 1) % POLICY_ORDER.length]!)
  if (key === "d") return set(current.defaultPolicy)
  const direct = DIRECT[key]
  return direct ? set(direct) : { state, action: NONE }
}

/** Renders at most `height` rows of exactly `width` cells. */
export function renderPoliciesTab(input: { categories: readonly MemoryCategoryInfo[] | undefined; state: PoliciesState; width: number; height: number }): Line[] {
  const { categories, state, width } = input
  const height = Math.max(0, input.height)
  const rows: Line[] = []
  for (const line of wrap("What becomes of a memory the agent, Dream or Evolution proposes in each category. What you save yourself is always saved; a proposal in which a secret was redacted always waits for review.", Math.max(1, width))) rows.push([{ text: line, fg: "muted" }])
  rows.push([])
  if (!categories) rows.push([{ text: "loading categories…", fg: "muted" }])
  else {
    const row = clamp(state.row, categories.length)
    const showDescription = width >= 80
    const descriptionRoom = width - 2 - NAME_WIDTH - VALUE_WIDTH - NOTE_WIDTH - 2
    rows.push(clip([{ text: "  " }, { text: "category".padEnd(NAME_WIDTH), fg: "muted" }, { text: "policy".padEnd(VALUE_WIDTH + 1), fg: "muted" }, ...(showDescription ? [{ text: "note".padEnd(NOTE_WIDTH), fg: "muted" as const }, { text: "what it is for", fg: "muted" as const }] : [])], width))
    categories.forEach((category, index) => {
      const chosen = index === row
      const custom = category.policy !== category.defaultPolicy
      const line: Line = [
        { text: chosen ? "❯ " : "  ", fg: "primary", bold: true },
        { text: category.label.padEnd(NAME_WIDTH), fg: chosen ? "primary" : "text", bold: chosen },
        { text: `‹ ${category.policy} ›`.padEnd(VALUE_WIDTH + 1), fg: POLICY_TONE[category.policy], bold: chosen },
        { text: (custom ? `default ${category.defaultPolicy}` : "").padEnd(NOTE_WIDTH), fg: "muted", dim: true },
        ...(showDescription && descriptionRoom > 8 ? [{ text: truncateEnd(category.description, descriptionRoom), fg: "muted" as const, dim: !chosen }] : []),
      ]
      rows.push(fit(line, width))
    })
    const active = categories[row]
    if (active) rows.push([], [{ text: `${active.label}: a proposal is ${POLICY_MEANING[active.policy]}`, fg: "body" }])
  }
  return rows.slice(0, height).map((line) => clip(line, width))
}
