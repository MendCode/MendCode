import { lastMarkedBlock } from "@mendcode/loops"
import type { WorkflowAgentTaskSpec, WorkflowPlan, WorkflowTask } from "@mendcode/protocol"
import { agentSpecs } from "./composition"

type Schema = Record<string, unknown>
const keywords = new Set(["type", "properties", "required", "additionalProperties", "items", "enum", "const", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems", "allOf", "anyOf", "oneOf", "title", "description", "$schema", "$id"])
const types = new Set(["object", "array", "string", "number", "integer", "boolean", "null"])
const object = (value: unknown): value is Schema => typeof value === "object" && value !== null && !Array.isArray(value)

export function schemaProblems(schema: unknown, depth = 0): string[] {
  if (typeof schema === "boolean") return []
  if (!object(schema) || depth > 12) return ["schema must be an object or boolean, at most 12 levels deep"]
  const problems = Object.keys(schema).filter((key) => !keywords.has(key)).map((key) => `unsupported schema keyword ${key}`)
  if (schema.type !== undefined && !(typeof schema.type === "string" ? types.has(schema.type) : Array.isArray(schema.type) && schema.type.length && schema.type.every((type) => typeof type === "string" && types.has(type)))) problems.push("invalid schema type")
  if (schema.required !== undefined && (!Array.isArray(schema.required) || !schema.required.every((key) => typeof key === "string"))) problems.push("schema required must be a string array")
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length)) problems.push("schema enum must be nonempty")
  for (const key of ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"]) if (schema[key] !== undefined && (typeof schema[key] !== "number" || !Number.isFinite(schema[key]) || key.startsWith("min") && key !== "minimum" && (schema[key] as number) < 0)) problems.push(`invalid schema ${key}`)
  if (schema.properties !== undefined) {
    if (!object(schema.properties)) problems.push("schema properties must be an object")
    else for (const value of Object.values(schema.properties)) problems.push(...schemaProblems(value, depth + 1))
  }
  for (const key of ["items", "additionalProperties"]) if (schema[key] !== undefined) problems.push(...schemaProblems(schema[key], depth + 1))
  for (const key of ["allOf", "anyOf", "oneOf"]) if (schema[key] !== undefined) {
    if (!Array.isArray(schema[key]) || !schema[key].length) problems.push(`schema ${key} must be nonempty`)
    else for (const entry of schema[key]) problems.push(...schemaProblems(entry, depth + 1))
  }
  return problems
}

export function outputSchemaProblems(plan: WorkflowPlan): string[] {
  return agentSpecs(plan).flatMap((task) => {
    const output = task.output
    return output && (output.kind === "json" || output.kind === "artifact") && output.schema ? schemaProblems(output.schema).map((problem) => `task "${task.id}": ${problem}`) : []
  })
}

export function matches(value: unknown, schema: unknown): boolean {
  if (typeof schema === "boolean") return schema
  if (!object(schema)) return false
  const typed = (type: unknown) => type === "null" ? value === null : type === "array" ? Array.isArray(value) : type === "object" ? object(value) : type === "integer" ? Number.isInteger(value) : typeof value === type
  if (schema.type !== undefined && !(Array.isArray(schema.type) ? schema.type.some(typed) : typed(schema.type))) return false
  if (schema.enum && !(schema.enum as unknown[]).some((entry) => JSON.stringify(entry) === JSON.stringify(value))) return false
  if ("const" in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) return false
  if (typeof value === "number" && (typeof schema.minimum === "number" && value < schema.minimum || typeof schema.maximum === "number" && value > schema.maximum)) return false
  if (typeof value === "string" && (typeof schema.minLength === "number" && value.length < schema.minLength || typeof schema.maxLength === "number" && value.length > schema.maxLength)) return false
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems || typeof schema.maxItems === "number" && value.length > schema.maxItems) return false
    if (schema.items !== undefined && !value.every((entry) => matches(entry, schema.items))) return false
  }
  if (object(value)) {
    if (Array.isArray(schema.required) && !schema.required.every((key) => typeof key === "string" && Object.hasOwn(value, key))) return false
    const properties = object(schema.properties) ? schema.properties : {}
    for (const [key, entry] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) {
        if (!matches(entry, properties[key])) return false
      } else if (schema.additionalProperties !== undefined && !matches(entry, schema.additionalProperties)) return false
    }
  }
  for (const key of ["allOf", "anyOf", "oneOf"]) if (Array.isArray(schema[key])) {
    const count = schema[key].filter((entry) => matches(value, entry)).length
    if (key === "allOf" && count !== schema[key].length || key === "anyOf" && !count || key === "oneOf" && count !== 1) return false
  }
  return true
}

/** `limit` is the longest structured output kept: a static plan's rows are small (8000), a script's journal holds more. */
export function captureOutput(spec: WorkflowAgentTaskSpec, answer: string, limit = 8_000): WorkflowTask["output"] {
  const contract = spec.output
  if (!contract || contract.kind === "none") return undefined
  const marked = lastMarkedBlock(answer, "WORKFLOW_OUTPUT")
  const body = marked ?? (contract.kind === "text" ? answer.trim() : lastMarkedBlock(answer, "json") ?? answer.trim())
  if (contract.kind === "text") return { kind: "text", value: body.slice(0, contract.maxChars ?? limit) }
  if (body.length > limit) throw new RangeError(`workflow output exceeds ${limit} characters`)
  let value: unknown
  try { value = JSON.parse(body) } catch {
    if (contract.kind === "artifact" && !contract.schema) return { kind: "artifact", value: body, artifactKind: contract.artifactKind }
    throw new RangeError("workflow output is not valid JSON")
  }
  if (contract.schema && !matches(value, contract.schema)) throw new RangeError("workflow output does not match its schema")
  return { kind: contract.kind, value: JSON.stringify(value), ...(contract.kind === "artifact" ? { artifactKind: contract.artifactKind } : {}) }
}
