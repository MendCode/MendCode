import { z } from "zod"
import type { Tool } from "@mendcode/tools"

/** The tool a turn with a required answer `format` finishes through; its arguments are the structured answer. */
export const STRUCTURED_TOOL = "StructuredOutput"
/** Retries after an invalid or missing structured answer when the prompt does not say. */
export const DEFAULT_STRUCTURED_RETRIES = 2

/** The validator of an object JSON Schema, or the reason it cannot be used. Remote `$ref`s are never fetched. */
export function structuredValidator(schema: Record<string, unknown>): { ok: true; validator: z.ZodType } | { ok: false; message: string } {
  try {
    return { ok: true, validator: z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]) }
  } catch (error) {
    return { ok: false, message: `unsupported JSON Schema: ${error instanceof Error ? error.message.slice(0, 200) : "invalid"}` }
  }
}

/** The finishing tool for one turn: valid arguments are the answer, and the result carries them back for the transcript. */
export function structuredTool(schema: Record<string, unknown>): (Tool & { jsonSchema: Record<string, unknown> }) | undefined {
  const compiled = structuredValidator(schema)
  if (!compiled.ok) return undefined
  return {
    name: STRUCTURED_TOOL,
    description: "Give your final answer. Call this tool exactly once, with arguments that match the required schema; it ends the turn.",
    permission: "read",
    args: compiled.validator,
    jsonSchema: schema,
    async execute(args) {
      return { output: JSON.stringify(args) ?? "null", truncated: false, title: STRUCTURED_TOOL, isError: false, meta: { structured: true } }
    },
  }
}

export const STRUCTURED_NOTE = `This request needs a structured answer. Finish by calling the ${STRUCTURED_TOOL} tool with arguments that match its schema; do not answer in plain text.`
export const STRUCTURED_NUDGE = `Respond by calling the ${STRUCTURED_TOOL} tool with a valid object that matches its schema.`
