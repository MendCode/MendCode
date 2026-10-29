/**
 * Fills a render template (renderSpec@1 with bindings) from a tool call: `{{args.path}}` and
 * `{{result.path}}` inside strings are replaced; a string that is exactly one binding takes the bound
 * value as is (an array of rows, a number…). An array element `{ "$each": "{{result.items}}", "map": … }`
 * expands to one mapped element per item, with `{{item.…}}` bound to it (at most MAX_EACH).
 * Pure JSON in, JSON out; the engine validates the result before it reaches a client.
 */

/** renderSpec@1 node types and their fields (mirrors @mendcode/protocol's RenderNode; bindings may stand in for any value). */
const RENDER_FIELDS: Readonly<Record<string, readonly string[]>> = {
  stack: ["children", "gap"],
  row: ["children", "weights"],
  box: ["title", "children"],
  text: ["text", "tone", "bold", "dim"],
  badge: ["text", "tone"],
  progress: ["value", "max", "label", "tone"],
  table: ["columns", "rows"],
  kv: ["items"],
  list: ["items", "ordered"],
  code: ["text"],
  diff: ["text"],
  sparkline: ["values", "tone", "label"],
}

/**
 * Structural problems of a render template before any data is bound: unknown node types, unknown
 * fields, children that are not nodes. Values are not checked (they may be bindings); the engine
 * validates the bound result on every call.
 */
export function renderTemplateProblems(template: unknown, path = "render", depth = 0): string[] {
  if (depth > 8) return [`${path}: nested too deep`]
  if (!template || typeof template !== "object" || Array.isArray(template)) return [`${path}: must be a node object`]
  const node = template as Record<string, unknown>
  const fields = typeof node.type === "string" ? RENDER_FIELDS[node.type] : undefined
  if (!fields) return [`${path}.type: must be one of ${Object.keys(RENDER_FIELDS).join(", ")}`]
  const problems = Object.keys(node)
    .filter((key) => key !== "type" && !fields.includes(key))
    .map((key) => `${path}.${key}: not a field of ${node.type}`)
  if ("children" in node) {
    if (!Array.isArray(node.children)) problems.push(`${path}.children: must be an array`)
    else
      node.children.forEach((child, index) => {
        if (child && typeof child === "object" && "$each" in (child as object)) return
        problems.push(...renderTemplateProblems(child, `${path}.children[${index}]`, depth + 1))
      })
  }
  return problems
}

const MAX_EACH = 50
const ONE_BINDING = /^\{\{\s*([\w.[\]-]+)\s*\}\}$/
const BINDING = /\{\{\s*([\w.[\]-]+)\s*\}\}/g

type Scope = Record<string, unknown>

function lookup(scope: Scope, path: string): unknown {
  let value: unknown = scope
  for (const key of path.replace(/\[(\d+)\]/g, ".$1").split(".")) {
    if (value === null || value === undefined) return undefined
    value = (value as Record<string, unknown>)[key]
  }
  return value
}

function show(value: unknown): string {
  if (value === undefined || value === null) return ""
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return JSON.stringify(value)
}

export function bindRenderTemplate(template: unknown, scope: Scope, depth = 0): unknown {
  if (depth > 12) return undefined
  if (typeof template === "string") {
    const whole = ONE_BINDING.exec(template)
    if (whole) return lookup(scope, whole[1]!)
    return template.replace(BINDING, (_, path: string) => show(lookup(scope, path)))
  }
  if (Array.isArray(template)) {
    const out: unknown[] = []
    for (const element of template) {
      if (element && typeof element === "object" && !Array.isArray(element) && "$each" in element) {
        const source = bindRenderTemplate((element as { $each: unknown }).$each, scope, depth + 1)
        const map = (element as { map?: unknown }).map
        if (Array.isArray(source)) for (const item of source.slice(0, MAX_EACH)) out.push(bindRenderTemplate(map, { ...scope, item }, depth + 1))
        continue
      }
      out.push(bindRenderTemplate(element, scope, depth + 1))
    }
    return out
  }
  if (template && typeof template === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(template)) out[key] = bindRenderTemplate(value, scope, depth + 1)
    return out
  }
  return template
}
