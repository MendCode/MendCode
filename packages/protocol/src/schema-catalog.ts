/**
 * The protocol's JSON Schema as a catalog of independently fetchable pieces, so the schema reply never has to fit
 * one frame (MAX_FRAME_BYTES) however many commands exist. Pure JSON, no zod: the daemon builds it from
 * `z.toJSONSchema(Frame)`, thin clients assemble or read it through "@mendcode/protocol/wire".
 *
 *   index  - the entry list (name, bytes, page) in byte-bounded index pages, with totals on each
 *   entry  - one frame kind or one command/event/global body, self-contained (its `$defs` closure attached)
 *   page   - a byte-bounded slice of the whole document: entries first, then shared definitions
 *
 * Every reply is bounded by SCHEMA_PAGE_BYTES whatever the protocol's size. `assembleSchema` joins the index pages and
 * every page back into the exact schema the catalog was built from.
 */
type Schema = Record<string, unknown>

/** Bytes of schema one page carries. Half a frame leaves room for JSON escaping and the report envelope. */
export const SCHEMA_PAGE_BYTES = 128 * 1024
/** Pages (and index pages) one schema may span; a bound for clients that loop until done. */
export const SCHEMA_MAX_PAGES = 1000

export type SchemaIndexEntry = { name: string; bytes: number; page: number; of?: string }
/** One page of the entry list; `entries` is the slice, the other fields describe the whole schema. */
export type SchemaIndex = { $schema?: string; entries: SchemaIndexEntry[]; indexPage: number; indexPages: number; total: number; defs: number; pages: number; bytes: number }
export type SchemaPage = { page: number; pages: number; entries: Record<string, Schema>; defs: Record<string, Schema> }

export type SchemaCatalog = {
  index(indexPage?: number): SchemaIndex | undefined
  page(page: number): SchemaPage | undefined
  /** One entry with the definitions it references, directly usable as a JSON Schema. */
  entry(name: string): Schema | undefined
}

const object = (value: unknown): value is Schema => !!value && typeof value === "object" && !Array.isArray(value)
const size = (value: unknown) => JSON.stringify(value).length
const REF = /^#\/\$defs\/([^/]+)/

function references(node: unknown, found: Set<string>) {
  if (Array.isArray(node)) return node.forEach((child) => references(child, found))
  if (!object(node)) return
  const match = typeof node.$ref === "string" ? REF.exec(node.$ref) : null
  if (match) found.add(match[1]!)
  for (const child of Object.values(node)) references(child, found)
}

const constant = (node: unknown, key: string): string | undefined => {
  const value = object(node) && object(node.properties) && object(node.properties[key]) ? node.properties[key].const : undefined
  return typeof value === "string" ? value : undefined
}

export function createSchemaCatalog(schema: Schema): SchemaCatalog {
  const definitions = object(schema.$defs) ? schema.$defs as Record<string, Schema> : {}
  const variants = Array.isArray(schema.oneOf) ? schema.oneOf : []
  const nodes = new Map<string, Schema>()
  const parents = new Map<string, string>()
  const taken = (base: string) => {
    let name = base
    for (let n = 2; nodes.has(name); n++) name = `${base}#${n}`
    return name
  }
  variants.forEach((variant, position) => {
    if (!object(variant)) return
    const kind = constant(variant, "kind") ?? `#${position}`
    const body = object(variant.properties) && object(variant.properties.body) ? variant.properties.body : undefined
    const members = body && Array.isArray(body.oneOf) ? body.oneOf : undefined
    const frame = taken(`frame:${kind}`)
    if (!members) return void nodes.set(frame, variant)
    nodes.set(frame, { ...variant, properties: { ...variant.properties as Schema, body: { ...body, oneOf: [] } } })
    members.forEach((member, index) => {
      const name = taken(`${kind}:${constant(member, "type") ?? `#${index}`}`)
      nodes.set(name, member as Schema)
      parents.set(name, frame)
    })
  })

  type Item = { kind: "entry" | "def"; name: string; value: Schema; bytes: number }
  const items: Item[] = [
    ...[...nodes].map(([name, value]) => ({ kind: "entry" as const, name, value, bytes: size(value) + name.length + 4 })),
    ...Object.entries(definitions).map(([name, value]) => ({ kind: "def" as const, name, value, bytes: size(value) + name.length + 4 })),
  ]
  const slices: Item[][] = [[]]
  let used = 0
  for (const item of items) {
    if (used > 0 && used + item.bytes > SCHEMA_PAGE_BYTES) { slices.push([]); used = 0 }
    slices[slices.length - 1]!.push(item)
    used += item.bytes
  }
  const pageOf = new Map(slices.flatMap((slice, page) => slice.filter((item) => item.kind === "entry").map((item) => [item.name, page] as const)))
  const listed: SchemaIndexEntry[] = [...nodes].map(([name, value]) => ({ name, bytes: size(value), page: pageOf.get(name)!, ...(parents.has(name) ? { of: parents.get(name)! } : {}) }))
  const lists: SchemaIndexEntry[][] = [[]]
  used = 0
  for (const entry of listed) {
    const bytes = size(entry) + 1
    if (used > 0 && used + bytes > SCHEMA_PAGE_BYTES) { lists.push([]); used = 0 }
    lists[lists.length - 1]!.push(entry)
    used += bytes
  }
  const totals = { ...(typeof schema.$schema === "string" ? { $schema: schema.$schema } : {}), indexPages: lists.length, total: listed.length, defs: Object.keys(definitions).length, pages: slices.length, bytes: size(schema) }

  return {
    index(indexPage = 0) {
      const entries = lists[indexPage]
      return entries ? { ...totals, indexPage, entries } : undefined
    },
    page(page) {
      const slice = slices[page]
      if (!slice) return undefined
      const pick = (kind: Item["kind"]) => Object.fromEntries(slice.filter((item) => item.kind === kind).map((item) => [item.name, item.value]))
      return { page, pages: slices.length, entries: pick("entry"), defs: pick("def") }
    },
    entry(name) {
      const node = nodes.get(name)
      if (!node) return undefined
      const found = new Set<string>()
      references(node, found)
      const closure: Record<string, Schema> = {}
      for (const pending = [...found]; pending.length;) {
        const next = pending.pop()!
        if (next in closure || !(next in definitions)) continue
        closure[next] = definitions[next]!
        const inner = new Set<string>()
        references(definitions[next], inner)
        pending.push(...inner)
      }
      return { ...(totals.$schema ? { $schema: totals.$schema } : {}), ...node, ...(Object.keys(closure).length ? { $defs: closure } : {}) }
    },
  }
}

/** Join every index page and every page back into the full schema; throws when a page or entry is missing. */
export function assembleSchema({ indexes, pages }: { indexes: readonly SchemaIndex[]; pages: readonly SchemaPage[] }): Schema {
  const index = indexes[0]
  if (!index) throw new RangeError("[PROTOCOL]: schema index missing")
  if (index.indexPages > SCHEMA_MAX_PAGES || new Set(indexes.map((entry) => entry.indexPage)).size !== index.indexPages) throw new RangeError(`[PROTOCOL]: schema index incomplete (${indexes.length}/${index.indexPages})`)
  const listed = [...indexes].sort((a, b) => a.indexPage - b.indexPage).flatMap((entry) => entry.entries)
  const entries = new Map<string, Schema>()
  const defs: Record<string, Schema> = {}
  const seen = new Set<number>()
  for (const page of pages) {
    seen.add(page.page)
    for (const [name, value] of Object.entries(page.entries)) entries.set(name, value)
    Object.assign(defs, page.defs)
  }
  if (index.pages > SCHEMA_MAX_PAGES || seen.size !== index.pages) throw new RangeError(`[PROTOCOL]: schema pages incomplete (${seen.size}/${index.pages})`)
  const copies = new Map<string, Schema>()
  for (const { name } of listed) {
    const node = entries.get(name)
    if (!node) throw new RangeError(`[PROTOCOL]: schema entry ${name} missing`)
    copies.set(name, structuredClone(node))
  }
  for (const { name, of } of listed) {
    if (!of) continue
    const body = (copies.get(of)!.properties as Schema).body as { oneOf: Schema[] }
    body.oneOf.push(copies.get(name)!)
  }
  return {
    ...(index.$schema ? { $schema: index.$schema } : {}),
    oneOf: listed.filter((entry) => !entry.of).map((entry) => copies.get(entry.name)!),
    ...(Object.keys(defs).length ? { $defs: defs } : {}),
  }
}
