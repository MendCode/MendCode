/**
 * The JSON Schema a model is shown for a built-in tool, without the keywords that only validate.
 *
 * Every tool call is parsed by the tool's own zod schema before it runs, so bounds, patterns and `additionalProperties:
 * false` are enforced there and a violation comes back to the model as an error. Sent on every request they were measured
 * at about a quarter of the tool list (workflow_start alone carries 6 KB of them) and tell the model nothing it can act on.
 * Types, enums, `required`, `default`, `description` and the structure itself are kept.
 */
const VALIDATION_ONLY = new Set(["$schema", "minLength", "maxLength", "minItems", "maxItems", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "pattern", "propertyNames", "uniqueItems", "minProperties", "maxProperties"])
/** Keywords whose value is a map of name → schema: the names are data, never keywords to drop. */
const SCHEMA_MAPS = new Set(["properties", "$defs", "definitions", "patternProperties", "dependentSchemas"])

export function compactToolSchema<T>(schema: T): T {
  return compact(schema) as T
}

function compact(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(compact)
  if (!node || typeof node !== "object") return node
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) {
    if (VALIDATION_ONLY.has(key)) continue
    if (key === "additionalProperties" && value === false) continue
    if (SCHEMA_MAPS.has(key) && value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = Object.fromEntries(Object.entries(value).map(([name, child]) => [name, compact(child)]))
      continue
    }
    out[key] = compact(value)
  }
  return out
}
