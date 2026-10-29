/**
 * A small JSON Schema validator for `run --output-schema`, written here so the startup graph gains no dependency.
 * Supported: `type` (one name or a list of string, number, integer, boolean, null, object, array), `required`,
 * `properties`, `additionalProperties` (boolean), `items` (one schema), `enum` and `const`; boolean schemas;
 * annotations (`$schema`, `$id`, `title`, `description`, `default`, `examples`, `$comment`) are ignored.
 * Any other keyword is rejected up front by `unsupportedKeywords`, so a constraint is never silently skipped.
 */
const TYPES = new Set(["string", "number", "integer", "boolean", "null", "object", "array"])
const KEYWORDS = new Set(["type", "required", "properties", "additionalProperties", "items", "enum", "const"])
const ANNOTATIONS = new Set(["$schema", "$id", "title", "description", "default", "examples", "$comment"])
const MAX_PROBLEMS = 20

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

/** Problems that make a schema unusable here (unknown keywords, malformed supported ones); empty when it is fine. */
export function unsupportedKeywords(schema: unknown, at = "$"): string[] {
  if (typeof schema === "boolean") return []
  if (!isRecord(schema)) return [`${at}: a schema must be an object or a boolean`]
  const problems: string[] = []
  for (const [key, value] of Object.entries(schema)) {
    if (ANNOTATIONS.has(key)) continue
    if (!KEYWORDS.has(key)) { problems.push(`${at}: unsupported keyword "${key}" (supported: ${[...KEYWORDS].join(", ")})`); continue }
    if (key === "type" && !(typeof value === "string" && TYPES.has(value) || Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string" && TYPES.has(entry)))) problems.push(`${at}: type must be ${[...TYPES].join(", ")} or a list of them`)
    else if (key === "required" && !(Array.isArray(value) && value.every((entry) => typeof entry === "string"))) problems.push(`${at}: required must be a list of property names`)
    else if (key === "enum" && !Array.isArray(value)) problems.push(`${at}: enum must be a list`)
    else if (key === "additionalProperties" && typeof value !== "boolean") problems.push(`${at}: additionalProperties must be true or false`)
    else if (key === "properties") {
      if (!isRecord(value)) problems.push(`${at}: properties must be an object`)
      else for (const [name, child] of Object.entries(value)) problems.push(...unsupportedKeywords(child, `${at}.${name}`))
    } else if (key === "items") problems.push(...(Array.isArray(value) ? [`${at}: items must be one schema, not a list`] : unsupportedKeywords(value, `${at}[]`)))
  }
  return problems.slice(0, MAX_PROBLEMS)
}

function matches(type: string, value: unknown) {
  if (type === "null") return value === null
  if (type === "array") return Array.isArray(value)
  if (type === "object") return isRecord(value)
  if (type === "integer") return typeof value === "number" && Number.isInteger(value)
  if (type === "number") return typeof value === "number" && Number.isFinite(value)
  return typeof value === type
}

function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((entry, index) => equal(entry, b[index]))
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a)
    return keys.length === Object.keys(b).length && keys.every((key) => key in b && equal(a[key], b[key]))
  }
  return false
}

/** What is wrong with `value` against `schema`, one line per problem (at most 20); empty when it conforms. */
export function validateJson(schema: unknown, value: unknown, at = "$"): string[] {
  if (schema === true) return []
  if (schema === false) return [`${at}: no value is allowed here`]
  if (!isRecord(schema)) return []
  const problems: string[] = []
  const types = schema.type === undefined ? undefined : Array.isArray(schema.type) ? schema.type as string[] : [schema.type as string]
  if (types && !types.some((type) => matches(type, value))) problems.push(`${at}: expected ${types.join(" or ")}, got ${value === null ? "null" : Array.isArray(value) ? "array" : typeof value}`)
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => equal(entry, value))) problems.push(`${at}: must be one of ${JSON.stringify(schema.enum)}`)
  if ("const" in schema && !equal(schema.const, value)) problems.push(`${at}: must equal ${JSON.stringify(schema.const)}`)
  if (isRecord(value)) {
    for (const name of Array.isArray(schema.required) ? schema.required as string[] : []) if (!(name in value)) problems.push(`${at}.${name}: required property is missing`)
    const properties = isRecord(schema.properties) ? schema.properties : {}
    for (const [name, child] of Object.entries(properties)) if (name in value) problems.push(...validateJson(child, value[name], `${at}.${name}`))
    if (schema.additionalProperties === false) for (const name of Object.keys(value)) if (!(name in properties)) problems.push(`${at}.${name}: property is not allowed`)
  }
  if (Array.isArray(value) && schema.items !== undefined) value.forEach((entry, index) => problems.push(...validateJson(schema.items, entry, `${at}[${index}]`)))
  return problems.slice(0, MAX_PROBLEMS)
}

/** The JSON document in a final answer: the whole text, or the one fenced block that makes it up. */
export function parseAnswerJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = text.trim()
  if (!trimmed) return { ok: false, error: "the run produced no final answer" }
  const fenced = /^```(?:json)?[ \t]*\n([\s\S]*?)\n?```$/i.exec(trimmed)
  try { return { ok: true, value: JSON.parse(fenced ? fenced[1]! : trimmed) } } catch (error) {
    return { ok: false, error: `the final answer is not valid JSON (${error instanceof Error ? error.message : "parse error"})` }
  }
}
