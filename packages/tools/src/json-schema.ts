import { z } from "zod"

/** The JSON Schema subset custom tools may declare: typed properties, enums, bounds, arrays and nested objects. */
const MAX_DEPTH = 5
const MAX_PROPERTIES = 50
const COMMON = ["type", "description", "enum"]
const KEYWORDS: Record<string, string[]> = {
  string: [...COMMON, "minLength", "maxLength"],
  number: [...COMMON, "minimum", "maximum"],
  integer: [...COMMON, "minimum", "maximum"],
  boolean: COMMON,
  array: [...COMMON, "items", "minItems", "maxItems"],
  object: [...COMMON, "properties", "required", "additionalProperties"],
}

export type CompiledSchema = { zod: z.ZodType; json: Record<string, unknown> }
type Node = { zod: z.ZodType; json: Record<string, unknown> }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)

function bound(value: unknown, path: string, keyword: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "number" || !Number.isFinite(value)) throw new SchemaError(`${path}: ${keyword} must be a number`)
  return value
}

export class SchemaError extends Error {}

function compileNode(raw: unknown, path: string, depth: number): Node {
  if (!isRecord(raw)) throw new SchemaError(`${path}: expected a schema object`)
  if (depth > MAX_DEPTH) throw new SchemaError(`${path}: nested deeper than ${MAX_DEPTH} levels`)
  const type = raw.type
  if (typeof type !== "string" || !(type in KEYWORDS)) throw new SchemaError(`${path}: type must be one of ${Object.keys(KEYWORDS).join(", ")}`)
  for (const key of Object.keys(raw)) if (!KEYWORDS[type]!.includes(key)) throw new SchemaError(`${path}: unsupported keyword "${key}" for type ${type}`)
  const json: Record<string, unknown> = { type }
  if (typeof raw.description === "string") json.description = raw.description.slice(0, 500)
  let zod: z.ZodType

  if (raw.enum !== undefined) {
    if (!Array.isArray(raw.enum) || raw.enum.length === 0 || raw.enum.length > 100 || !raw.enum.every((v) => typeof v === "string" || typeof v === "number")) {
      throw new SchemaError(`${path}: enum must list 1-100 strings or numbers`)
    }
    const values = raw.enum as Array<string | number>
    json.enum = values
    zod = z.custom<string | number>((value) => values.includes(value as never), { message: `must be one of ${values.join(", ")}` })
    return { zod, json }
  }

  switch (type) {
    case "string": {
      let schema = z.string()
      const min = bound(raw.minLength, path, "minLength")
      const max = bound(raw.maxLength, path, "maxLength")
      if (min !== undefined) (schema = schema.min(min), (json.minLength = min))
      if (max !== undefined) (schema = schema.max(max), (json.maxLength = max))
      zod = schema
      break
    }
    case "number":
    case "integer": {
      let schema = type === "integer" ? z.number().int() : z.number()
      const min = bound(raw.minimum, path, "minimum")
      const max = bound(raw.maximum, path, "maximum")
      if (min !== undefined) (schema = schema.min(min), (json.minimum = min))
      if (max !== undefined) (schema = schema.max(max), (json.maximum = max))
      zod = schema
      break
    }
    case "boolean":
      zod = z.boolean()
      break
    case "array": {
      const items = compileNode(raw.items, `${path}.items`, depth + 1)
      let schema = z.array(items.zod)
      const min = bound(raw.minItems, path, "minItems")
      const max = bound(raw.maxItems, path, "maxItems")
      if (min !== undefined) (schema = schema.min(min), (json.minItems = min))
      if (max !== undefined) (schema = schema.max(max), (json.maxItems = max))
      json.items = items.json
      zod = schema
      break
    }
    default: {
      const properties = raw.properties === undefined ? {} : raw.properties
      if (!isRecord(properties)) throw new SchemaError(`${path}: properties must be an object`)
      const names = Object.keys(properties)
      if (names.length > MAX_PROPERTIES) throw new SchemaError(`${path}: more than ${MAX_PROPERTIES} properties`)
      const required = raw.required === undefined ? [] : raw.required
      if (!Array.isArray(required) || !required.every((name) => typeof name === "string" && names.includes(name))) throw new SchemaError(`${path}: required must list declared properties`)
      const shape: Record<string, z.ZodType> = {}
      const jsonProperties: Record<string, unknown> = {}
      for (const name of names) {
        const child = compileNode(properties[name], `${path}.${name}`, depth + 1)
        shape[name] = required.includes(name) ? child.zod : child.zod.optional()
        jsonProperties[name] = child.json
      }
      const open = raw.additionalProperties === true
      if (raw.additionalProperties !== undefined && typeof raw.additionalProperties !== "boolean") throw new SchemaError(`${path}: additionalProperties must be a boolean`)
      json.properties = jsonProperties
      json.required = required
      json.additionalProperties = open
      zod = open ? z.looseObject(shape) : z.strictObject(shape)
    }
  }
  return { zod, json }
}

/** Compiles a manifest's `args` (an object schema) into a validator plus the cleaned JSON Schema sent to the model. */
export function compileArgsSchema(raw: unknown): CompiledSchema {
  const schema = raw === undefined ? { type: "object", properties: {} } : raw
  if (!isRecord(schema) || schema.type !== "object") throw new SchemaError("args: the top-level schema must have type object")
  return compileNode(schema, "args", 0)
}
