import { z } from "zod"

/**
 * Declarative render specs (renderSpec@1): how a tool call's result is drawn, described as data. The
 * terminal client interprets them with its own primitives, so a spec (hand-written or AI-generated)
 * can shape the display but never run code. Bounded: depth ≤ RENDER_LIMITS.depth, ≤ RENDER_LIMITS.nodes.
 */

export const RENDER_TONES = ["text", "muted", "primary", "accent", "secondary", "info", "success", "warning", "error", "heading", "code"] as const
export const RenderTone = z.enum(RENDER_TONES)
export type RenderTone = z.infer<typeof RenderTone>

export const RENDER_LIMITS = { depth: 6, nodes: 200, text: 4_000, rows: 50, columns: 8, values: 120, graphEdges: 24, mapEntries: 50 } as const

const Text = z.string().max(RENDER_LIMITS.text)

type Opt<T> = T | undefined

export type RenderNode =
  | { type: "stack"; children: RenderNode[]; gap?: Opt<number> }
  | { type: "row"; children: RenderNode[]; weights?: Opt<number[]> }
  | { type: "box"; title?: Opt<string>; children: RenderNode[] }
  | { type: "text"; text: string; tone?: Opt<RenderTone>; bold?: Opt<boolean>; dim?: Opt<boolean> }
  | { type: "badge"; text: string; tone?: Opt<RenderTone> }
  | { type: "progress"; value: number; max?: Opt<number>; label?: Opt<string>; tone?: Opt<RenderTone> }
  | { type: "table"; columns: string[]; rows: string[][] }
  | { type: "kv"; items: Array<{ key: string; value: string; tone?: Opt<RenderTone> }> }
  | { type: "list"; items: string[]; ordered?: Opt<boolean> }
  | { type: "code"; text: string }
  | { type: "diff"; text: string }
  | { type: "sparkline"; values: number[]; tone?: Opt<RenderTone>; label?: Opt<string> }
  | { type: "graph"; root: string; edges: RenderGraphEdge[]; title?: Opt<string> }
  | { type: "codemap"; center: RenderMapEntry; left: RenderMapSide; right: RenderMapSide; title?: Opt<string>; saved?: Opt<number> }
  /** Rows the client draws only at a density: `preview` in the `full` view's capped card, `open` once the reader opens the card. Neither shows in `balanced`. */
  | { type: "detail"; at: "preview" | "open"; children: RenderNode[] }

/** One symbol of a `codemap`: its name, where it lives, how many call hops away from the centre it is (1 = direct) and, past the first hop, the label of the entry it was reached through (`via`). */
export type RenderMapEntry = { label: string; file?: Opt<string>; line?: Opt<number>; kind?: Opt<string>; depth?: Opt<number>; via?: Opt<string> }

/** One side of a `codemap` (callers on the left, callees or matches on the right). `more` counts entries the tool left out; `flow` is the arrow direction: `in` toward the centre, `out` away from it, `none` for plain matches. */
export type RenderMapSide = { title: string; entries: RenderMapEntry[]; more?: Opt<number>; flow?: Opt<"in" | "out" | "none"> }

/** One edge of a `graph` node: `from --relation--> to`; the client centres `root` and lays its neighbours around it. */
export type RenderGraphEdge = { from: string; to: string; relation?: Opt<string> }

const GraphLabel = z.string().min(1).max(120)

const MapEntry = z.strictObject({
  label: GraphLabel,
  file: z.string().max(240).optional(),
  line: z.number().int().min(0).max(10_000_000).optional(),
  kind: z.string().max(24).optional(),
  depth: z.number().int().min(1).max(1_000_000).optional(),
  via: GraphLabel.optional(),
})

const MapSide = z.strictObject({
  title: z.string().max(24),
  entries: z.array(MapEntry).max(RENDER_LIMITS.mapEntries),
  more: z.number().int().min(0).max(1_000_000).optional(),
  flow: z.enum(["in", "out", "none"]).optional(),
})

// z.lazy already defers the whole tree; a lazySchema stand-in would break the recursion's identity in JSON Schema output.
export const RenderNode: z.ZodType<RenderNode> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("stack"), children: z.array(RenderNode).max(40), gap: z.number().int().min(0).max(2).optional() }),
    z.strictObject({ type: z.literal("row"), children: z.array(RenderNode).min(1).max(4), weights: z.array(z.number().positive().max(10)).max(4).optional() }),
    z.strictObject({ type: z.literal("box"), title: Text.optional(), children: z.array(RenderNode).max(40) }),
    z.strictObject({ type: z.literal("text"), text: Text, tone: RenderTone.optional(), bold: z.boolean().optional(), dim: z.boolean().optional() }),
    z.strictObject({ type: z.literal("badge"), text: z.string().max(60), tone: RenderTone.optional() }),
    z.strictObject({ type: z.literal("progress"), value: z.number().finite(), max: z.number().finite().positive().optional(), label: z.string().max(80).optional(), tone: RenderTone.optional() }),
    z.strictObject({
      type: z.literal("table"),
      columns: z.array(z.string().max(80)).min(1).max(RENDER_LIMITS.columns),
      rows: z.array(z.array(z.string().max(200)).max(RENDER_LIMITS.columns)).max(RENDER_LIMITS.rows),
    }),
    z.strictObject({ type: z.literal("kv"), items: z.array(z.strictObject({ key: z.string().max(80), value: z.string().max(400), tone: RenderTone.optional() })).max(RENDER_LIMITS.rows) }),
    z.strictObject({ type: z.literal("list"), items: z.array(z.string().max(400)).max(RENDER_LIMITS.rows), ordered: z.boolean().optional() }),
    z.strictObject({ type: z.literal("code"), text: Text }),
    z.strictObject({ type: z.literal("diff"), text: Text }),
    z.strictObject({ type: z.literal("sparkline"), values: z.array(z.number().finite()).max(RENDER_LIMITS.values), tone: RenderTone.optional(), label: z.string().max(80).optional() }),
    z.strictObject({
      type: z.literal("graph"),
      root: GraphLabel,
      edges: z.array(z.strictObject({ from: GraphLabel, to: GraphLabel, relation: z.string().max(40).optional() })).max(RENDER_LIMITS.graphEdges),
      title: z.string().max(80).optional(),
    }),
    z.strictObject({ type: z.literal("codemap"), center: MapEntry, left: MapSide, right: MapSide, title: z.string().max(80).optional(), saved: z.number().int().min(0).max(1_000_000_000).optional() }),
    z.strictObject({ type: z.literal("detail"), at: z.enum(["preview", "open"]), children: z.array(RenderNode).max(40) }),
  ]),
)

/** Depth and node count of a spec (the schema bounds each node; this bounds the whole tree). */
export function renderShape(node: RenderNode, depth = 1): { depth: number; nodes: number } {
  const children = "children" in node ? node.children : []
  return children.reduce(
    (shape, child) => {
      const inner = renderShape(child, depth + 1)
      return { depth: Math.max(shape.depth, inner.depth), nodes: shape.nodes + inner.nodes }
    },
    { depth, nodes: 1 },
  )
}

const STRING_FIELDS = new Set(["text", "title", "label", "key", "value"])

/**
 * Coerces a bound template toward the schema before validation: numbers and booleans in text slots
 * become strings (table cells, list items, kv values, texts), numeric strings in number slots become
 * numbers, and missing arrays become empty. Tools return loose JSON; the spec stays strict.
 */
export function normalizeRenderSpec(value: unknown, depth = 0): unknown {
  if (depth > RENDER_LIMITS.depth * 3 || !value || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map((item) => normalizeRenderSpec(item, depth + 1))
  const node = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  const cell = (v: unknown) => (typeof v === "number" || typeof v === "boolean" ? String(v) : v === null || v === undefined ? "" : v)
  for (const [key, field] of Object.entries(node)) {
    if (STRING_FIELDS.has(key)) out[key] = cell(field)
    else if (key === "max" && typeof field === "string" && field.trim() !== "" && Number.isFinite(Number(field))) out[key] = Number(field)
    else if (key === "rows" && Array.isArray(field)) out[key] = field.map((row) => (Array.isArray(row) ? row.map(cell) : [cell(row)]))
    else if (key === "items" && Array.isArray(field)) out[key] = field.map((item) => (item && typeof item === "object" ? normalizeRenderSpec(item, depth + 1) : cell(item)))
    else if (key === "columns" && Array.isArray(field)) out[key] = field.map(cell)
    else if (key === "values" && Array.isArray(field)) out[key] = field.map(Number).filter(Number.isFinite)
    else if (key === "children") out[key] = Array.isArray(field) ? field.map((child) => normalizeRenderSpec(child, depth + 1)) : []
    else out[key] = field
  }
  // `value` is text in kv items but a number in progress bars.
  if (node.type === "progress" && typeof out.value === "string") out.value = Number(out.value)
  return out
}

/** A validated spec within RENDER_LIMITS, or why not. */
export function parseRenderSpec(value: unknown): { ok: true; spec: RenderNode } | { ok: false; error: string } {
  const parsed = RenderNode.safeParse(value)
  if (!parsed.success) return { ok: false, error: parsed.error.issues.slice(0, 3).map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`).join("; ") }
  const shape = renderShape(parsed.data)
  if (shape.depth > RENDER_LIMITS.depth) return { ok: false, error: `nested deeper than ${RENDER_LIMITS.depth}` }
  if (shape.nodes > RENDER_LIMITS.nodes) return { ok: false, error: `more than ${RENDER_LIMITS.nodes} nodes` }
  return { ok: true, spec: parsed.data }
}
