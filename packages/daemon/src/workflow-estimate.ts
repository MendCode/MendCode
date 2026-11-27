import { DEFAULT_WORKFLOW_SIZE, WORKFLOW_SIZE_GUIDE, type WorkflowSize } from "@mendcode/protocol"

/**
 * What a workflow is expected to use, shown before it starts (preview, the model's start result, `/<name>`): agents, tokens, cost
 * and time. It informs and never blocks: a run inside the user's permission starts at once, and only a cap the run reaches pauses it.
 *
 * The agent count comes from what the plan declares (a static plan's tasks, a script's `meta.budget.agents`, else the agent calls the
 * source makes, ten when it loops); tokens, cost and time per agent come from this machine's finished runs, with plain defaults
 * (clearly marked) when there are none. Pure: the daemon passes the history in.
 */
export type EstimateHistory = Array<{ kind: string; state: string; usage?: { input: number; output: number; costMicros?: number | undefined } | undefined; startedAt?: number | undefined; endedAt?: number | undefined }>

export type RunEstimate = {
  /** Agents the run is expected to start (`atMost`: only the cap is known, the script decides at run time). */
  agents: number
  atMost: boolean
  tokens: number
  /** Dollars; undefined while no finished agent had a price. */
  usd?: number
  minutes: number
  /** Per-agent numbers came from finished runs here, or from defaults. */
  basis: "history" | "default"
  /** The size guideline this run is measured against. */
  size: WorkflowSize
  /** More agents than the guideline names, or a run big enough to be worth a notice. */
  large: boolean
  overGuide: boolean
  /** The caps that will pause it, as the plan declares them. */
  caps: string[]
}

const DEFAULT_TOKENS = 45_000
const DEFAULT_AGENT_MINUTES = 2
/** A run this size or bigger gets the notice, whatever the guideline. */
export const LARGE_AGENTS = 20
const LARGE_TOKENS = 2_000_000
const LARGE_USD = 5
const DEFAULT_CALLS = 10

const median = (values: number[]) => {
  if (!values.length) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]!
}

/** Agent call sites in a script's source, and whether it fans out (a loop, a map, `parallel` or `pipeline`). */
export function scriptShape(source: string): { sites: number; dynamic: boolean } {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1")
  return { sites: (code.match(/\bagent\s*\(/g) ?? []).length, dynamic: /\b(?:for|while)\s*\(|\.(?:map|flatMap|forEach)\s*\(|\b(?:parallel|pipeline)\s*\(/.test(code) }
}

export function estimateRun(input: {
  /** Agents a static plan has (a map counts its `maxItems`), or undefined for a script. */
  planAgents?: number | undefined
  script?: { source: string; budget?: { agents?: number | undefined; tokens?: number | undefined; usd?: number | undefined; minutes?: number | undefined } | undefined } | undefined
  maxConcurrent?: number | undefined
  history: EstimateHistory
  size?: WorkflowSize | undefined
}): RunEstimate {
  const size = input.size ?? DEFAULT_WORKFLOW_SIZE
  const budget = input.script?.budget
  const shape = input.script ? scriptShape(input.script.source) : undefined
  const guess = shape ? (shape.dynamic ? DEFAULT_CALLS : Math.max(1, shape.sites)) : Math.max(1, input.planAgents ?? 1)
  const declared = budget?.agents
  const atMost = shape !== undefined && (shape.dynamic || declared !== undefined && declared > guess)
  // A script that fans out is planned to its declared cap: that is the most it may start, and the number to be ready for.
  const agents = shape ? (declared ?? guess) : guess
  const done = input.history.filter((task) => task.kind === "agent" && task.state === "done")
  const tokens = median(done.flatMap((task) => (task.usage ? [task.usage.input + task.usage.output] : [])).filter((value) => value > 0))
  const prices = median(done.flatMap((task) => (task.usage?.costMicros ? [task.usage.costMicros] : [])))
  const seconds = median(done.flatMap((task) => (task.startedAt !== undefined && task.endedAt !== undefined && task.endedAt > task.startedAt ? [(task.endedAt - task.startedAt) / 1000] : [])))
  const perTokens = tokens ?? DEFAULT_TOKENS
  const waves = Math.ceil(agents / Math.max(1, Math.min(16, input.maxConcurrent ?? 16)))
  const caps = budget ? Object.entries(budget).flatMap(([key, value]) => (value === undefined ? [] : [`${key} ${value}`])) : []
  const guide = WORKFLOW_SIZE_GUIDE[size].agents
  const rawTokens = agents * perTokens
  const usd = prices !== undefined ? (agents * prices) / 1_000_000 : undefined
  const minutes = Math.max(1, Math.round(waves * (seconds !== undefined ? seconds / 60 : DEFAULT_AGENT_MINUTES)))
  const estimate: RunEstimate = {
    agents,
    atMost,
    tokens: budget?.tokens !== undefined ? Math.min(rawTokens, budget.tokens) : rawTokens,
    ...(usd !== undefined ? { usd: budget?.usd !== undefined ? Math.min(usd, budget.usd) : usd } : {}),
    minutes: budget?.minutes !== undefined ? Math.min(minutes, budget.minutes) : minutes,
    basis: tokens !== undefined ? "history" : "default",
    size,
    large: agents >= LARGE_AGENTS || rawTokens >= LARGE_TOKENS || (usd ?? 0) >= LARGE_USD,
    overGuide: guide !== undefined && agents > guide,
    caps,
  }
  return estimate
}

const compact = (value: number) => (value >= 1_000_000 ? `${+(value / 1_000_000).toFixed(1)}M` : value >= 1_000 ? `${Math.round(value / 1_000)}k` : String(value))

/** One line: `up to 24 agents · ~1.1M tokens · ~$4.80 · ~8 min`. */
export function estimateLine(estimate: RunEstimate): string {
  return [
    `${estimate.atMost ? "up to " : ""}${estimate.agents} agent${estimate.agents === 1 ? "" : "s"}`,
    `~${compact(estimate.tokens)} tokens`,
    estimate.usd !== undefined ? `~$${estimate.usd < 10 ? estimate.usd.toFixed(2) : Math.round(estimate.usd)}` : "cost unknown",
    `~${estimate.minutes} min`,
  ].join(" · ")
}

/** The notice for a large run: informative, with how to bound it. Empty when the run is not large. */
export function largeRunNotice(estimate: RunEstimate): string {
  if (!estimate.large && !estimate.overGuide) return ""
  const guide = WORKFLOW_SIZE_GUIDE[estimate.size].agents
  const over = estimate.overGuide ? ` It is above the ${estimate.size} guideline (${guide} agents).` : ""
  const caps = estimate.caps.length ? `Caps that pause it: ${estimate.caps.join(", ")}.` : "No caps declared: it pauses at 10 agent calls."
  return `Large run.${over} ${caps} It starts now; /workflows budget raises or sets a cap.`
}
