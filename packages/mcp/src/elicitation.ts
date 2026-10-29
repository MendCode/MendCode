import type { QuestionPrompt, ToolContext } from "@mendcode/tools"

type Json = Record<string, unknown>

/** Most fields a form may have: the question batch of the terminal takes at most 32 questions. */
export const MAX_ELICITATION_FIELDS = 32
const MAX_MESSAGE_CHARS = 2_000
const MAX_CHOICES = 9
/** A form that asks for one of these is refused unseen: the MCP specification says servers must not request credentials this way. */
const SENSITIVE = /pass(word|phrase|code)?\b|secret|token|api[-_ ]?key|credential|private[-_ ]?key|\bpin\b|\bssn\b|card[-_ ]?number|\bcvv\b/i

export type ElicitField = {
  key: string
  title: string
  description?: string
  type: "string" | "number" | "integer" | "boolean" | "choice" | "multi"
  choices?: Array<{ value: string; title: string }>
  required: boolean
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  minItems?: number
  maxItems?: number
}

/** What a server asked for, already reduced to a flat form the user can answer field by field. */
export type ElicitRequest = { server: string; message: string; fields: ElicitField[] }

/** The user's side: raw text answers per field key (a list, for a multi-select), or a refusal. */
export type ElicitAnswer = { action: "accept"; answers: Record<string, string[]> } | { action: "decline" | "cancel" }
export type ElicitHandler = (request: ElicitRequest) => Promise<ElicitAnswer>

export type ElicitParse = { ok: true; message: string; fields: ElicitField[] } | { ok: false; reason: "unsupported" | "invalid" | "sensitive"; message: string }

const record = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value)
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
const finite = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined)

/** The allowed values of a string enum: `enum` (with the legacy `enumNames`) or `oneOf`/`anyOf` of `{ const, title }`. */
function choicesOf(schema: Json): Array<{ value: string; title: string }> | undefined {
  if (Array.isArray(schema.enum) && schema.enum.every((value) => typeof value === "string")) {
    const names = Array.isArray(schema.enumNames) ? schema.enumNames : []
    return (schema.enum as string[]).map((value, index) => ({ value, title: typeof names[index] === "string" ? (names[index] as string) : value }))
  }
  const options = Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(schema.anyOf) ? schema.anyOf : undefined
  if (options && options.length && options.every((option) => record(option) && typeof option.const === "string")) {
    return options.map((option) => ({ value: (option as Json).const as string, title: typeof (option as Json).title === "string" ? ((option as Json).title as string) : ((option as Json).const as string) }))
  }
  return undefined
}

function parseField({ key, schema, required }: { key: string; schema: unknown; required: boolean }): ElicitField | undefined {
  if (!record(schema)) return undefined
  const base = { key, title: typeof schema.title === "string" && schema.title.trim() ? schema.title.trim() : key, ...(typeof schema.description === "string" && schema.description.trim() ? { description: schema.description.trim() } : {}), required }
  if (schema.type === "boolean") return { ...base, type: "boolean" }
  if (schema.type === "number" || schema.type === "integer") {
    const minimum = finite(schema.minimum), maximum = finite(schema.maximum)
    return { ...base, type: schema.type, ...(minimum !== undefined ? { minimum } : {}), ...(maximum !== undefined ? { maximum } : {}) }
  }
  if (schema.type === "array") {
    const choices = record(schema.items) ? choicesOf(schema.items) : undefined
    if (!choices) return undefined
    const minItems = finite(schema.minItems), maxItems = finite(schema.maxItems)
    return { ...base, type: "multi", choices, ...(minItems !== undefined ? { minItems } : {}), ...(maxItems !== undefined ? { maxItems } : {}) }
  }
  if (schema.type === "string") {
    const choices = choicesOf(schema)
    if (choices) return { ...base, type: "choice", choices }
    const minLength = finite(schema.minLength), maxLength = finite(schema.maxLength)
    return { ...base, type: "string", ...(minLength !== undefined ? { minLength } : {}), ...(maxLength !== undefined ? { maxLength } : {}) }
  }
  return undefined
}

/** Reads the params of `elicitation/create` (form mode only). Never throws. */
export function parseElicitation(params: unknown): ElicitParse {
  if (!record(params)) return { ok: false, reason: "invalid", message: "elicitation params must be an object" }
  if (params.mode !== undefined && params.mode !== "form") return { ok: false, reason: "unsupported", message: `elicitation mode ${String(params.mode)} is not supported` }
  if (typeof params.message !== "string" || !params.message.trim()) return { ok: false, reason: "invalid", message: "elicitation needs a message" }
  const message = clip(params.message.trim(), MAX_MESSAGE_CHARS)
  const requested = params.requestedSchema
  if (requested === undefined) return { ok: true, message, fields: [] }
  if (!record(requested) || (requested.properties !== undefined && !record(requested.properties))) return { ok: false, reason: "invalid", message: "requestedSchema must be an object schema" }
  const properties = Object.entries((requested.properties ?? {}) as Json)
  if (properties.length > MAX_ELICITATION_FIELDS) return { ok: false, reason: "unsupported", message: `elicitation has more than ${MAX_ELICITATION_FIELDS} fields` }
  const required = new Set(Array.isArray(requested.required) ? requested.required.filter((name): name is string => typeof name === "string") : [])
  const fields: ElicitField[] = []
  for (const [key, schema] of properties) {
    const field = parseField({ key, schema, required: required.has(key) })
    if (!field) return { ok: false, reason: "unsupported", message: `field ${clip(key, 60)} has a type this client cannot ask for` }
    if (SENSITIVE.test(key) || SENSITIVE.test(field.title)) return { ok: false, reason: "sensitive", message: `field ${clip(key, 60)} asks for a credential` }
    fields.push(field)
  }
  return { ok: true, message, fields }
}

const TRUE = new Set(["yes", "y", "true", "1", "on"])
const FALSE = new Set(["no", "n", "false", "0", "off"])

function matchChoice(field: ElicitField, text: string): string | undefined {
  const wanted = text.trim().toLowerCase()
  return field.choices?.find((choice) => choice.value.toLowerCase() === wanted)?.value ?? field.choices?.find((choice) => choice.title.toLowerCase() === wanted)?.value
}

/** Turns the user's text answers into the typed `content` of the reply, or says what is wrong. Optional empty fields are left out. */
export function elicitationContent({ fields, answers }: { fields: readonly ElicitField[]; answers: Record<string, string[]> }): { ok: true; content: Json } | { ok: false; message: string } {
  const content: Json = {}
  for (const field of fields) {
    const raw = (answers[field.key] ?? []).map((entry) => entry.trim()).filter(Boolean)
    if (!raw.length) {
      if (field.required) return { ok: false, message: `${field.title} is required` }
      continue
    }
    const first = raw[0]!
    if (field.type === "string") {
      if (field.minLength !== undefined && first.length < field.minLength) return { ok: false, message: `${field.title} is shorter than ${field.minLength}` }
      if (field.maxLength !== undefined && first.length > field.maxLength) return { ok: false, message: `${field.title} is longer than ${field.maxLength}` }
      content[field.key] = first
    } else if (field.type === "number" || field.type === "integer") {
      const value = Number(first)
      if (!Number.isFinite(value) || (field.type === "integer" && !Number.isInteger(value))) return { ok: false, message: `${field.title} must be ${field.type === "integer" ? "a whole number" : "a number"}` }
      if (field.minimum !== undefined && value < field.minimum) return { ok: false, message: `${field.title} is below ${field.minimum}` }
      if (field.maximum !== undefined && value > field.maximum) return { ok: false, message: `${field.title} is above ${field.maximum}` }
      content[field.key] = value
    } else if (field.type === "boolean") {
      const lowered = first.toLowerCase()
      if (TRUE.has(lowered)) content[field.key] = true
      else if (FALSE.has(lowered)) content[field.key] = false
      else return { ok: false, message: `${field.title} must be yes or no` }
    } else if (field.type === "choice") {
      const value = matchChoice(field, first)
      if (value === undefined) return { ok: false, message: `${field.title} is not one of the offered values` }
      content[field.key] = value
    } else {
      const values: string[] = []
      for (const entry of raw) {
        const value = matchChoice(field, entry)
        if (value === undefined) return { ok: false, message: `${field.title} has a value that is not offered` }
        if (!values.includes(value)) values.push(value)
      }
      if (field.minItems !== undefined && values.length < field.minItems) return { ok: false, message: `${field.title} needs at least ${field.minItems}` }
      if (field.maxItems !== undefined && values.length > field.maxItems) return { ok: false, message: `${field.title} allows at most ${field.maxItems}` }
      content[field.key] = values
    }
  }
  return { ok: true, content }
}

type Questions = NonNullable<QuestionPrompt["questions"]>

/** The terminal question batch for a form: one question per field, choices as options, free text where there are none. */
export function elicitationQuestions(fields: readonly ElicitField[]): Questions {
  return fields.map((field): Questions[number] => {
    const question = clip(field.description ? `${field.title}: ${field.description}` : field.title, 500)
    const header = clip(field.title, 30) || "Value"
    const hints: string[] = []
    if (!field.required) hints.push("optional, leave empty to skip")
    if (field.type === "number" || field.type === "integer") hints.push(field.type === "integer" ? "whole number" : "number", ...(field.minimum !== undefined ? [`min ${field.minimum}`] : []), ...(field.maximum !== undefined ? [`max ${field.maximum}`] : []))
    if (field.type === "string" && (field.minLength !== undefined || field.maxLength !== undefined)) hints.push(`length ${field.minLength ?? 0} to ${field.maxLength ?? "any"}`)
    if (field.type === "boolean") return { question, header, options: [{ label: "Yes" }, { label: "No" }], custom: false, ...(hints.length ? { context: hints.join(", ") } : {}) }
    if (field.type === "choice" || field.type === "multi") {
      const choices = field.choices ?? []
      if (choices.length <= MAX_CHOICES) return { question, header, options: choices.map((choice) => ({ label: clip(choice.title, 120), ...(choice.title !== choice.value ? { description: clip(choice.value, 300) } : {}) })), custom: false, ...(field.type === "multi" ? { multiple: true } : {}), ...(hints.length ? { context: hints.join(", ") } : {}) }
      return { question, header, options: [], custom: true, context: clip(`Type ${field.type === "multi" ? "values separated by commas" : "one value"} from: ${choices.map((choice) => choice.value).join(", ")}`, 4_000) }
    }
    return { question, header, options: [], custom: true, ...(hints.length ? { context: hints.join(", ") } : {}) }
  })
}

/**
 * The handler that asks the person through the tool's `ask`: the server's message is the prompt, the fields are the
 * questions. A form without fields is a plain confirmation. The reply is never shown to the model, only to the server.
 */
export function userElicitation({ ask }: { ask: NonNullable<ToolContext["ask"]> }): ElicitHandler {
  return async ({ server, message, fields }) => {
    const title = clip(`${server} asks for input`, 120)
    const questions: Questions = fields.length ? elicitationQuestions(fields) : [{ question: clip(message, 500), header: "Confirm", options: [{ label: "Accept" }, { label: "Decline" }], custom: false }]
    const reply = await ask({ title, detail: message, questions })
    if (!reply.answered) return { action: /abandon/i.test(reply.reason) ? "cancel" : "decline" }
    if (!reply.answers || reply.answers.length !== questions.length) return { action: "cancel" }
    if (!fields.length) return reply.answers[0]?.[0] === "Accept" ? { action: "accept", answers: {} } : { action: "decline" }
    // A long multi-select has no options to tick: its values are typed, separated by commas.
    const typedList = (field: ElicitField) => field.type === "multi" && (field.choices?.length ?? 0) > MAX_CHOICES
    return { action: "accept", answers: Object.fromEntries(fields.map((field, index) => [field.key, typedList(field) ? reply.answers![index]!.flatMap((entry) => entry.split(",")) : reply.answers![index]!])) }
  }
}

export type ElicitationReply = { result: Json } | { error: { code: number; message: string } }

/**
 * The JSON-RPC reply to a server's `elicitation/create`: declined when there is nobody to ask, unsupported or sensitive,
 * cancelled when the answer does not fit the schema or asking fails. `waiting` lets the caller stop its own timeouts
 * while the person types.
 */
export async function respondToElicitation({ server, params, handler, waiting }: { server: string; params: unknown; handler: ElicitHandler | undefined; waiting?: { start(): void; end(): void } | undefined }): Promise<ElicitationReply> {
  const parsed = parseElicitation(params)
  if (!parsed.ok) return parsed.reason === "invalid" ? { error: { code: -32602, message: parsed.message } } : { result: { action: "decline" } }
  if (!handler) return { result: { action: "decline" } }
  waiting?.start()
  try {
    const answer = await handler({ server, message: parsed.message, fields: parsed.fields })
    if (answer.action !== "accept") return { result: { action: answer.action } }
    const content = elicitationContent({ fields: parsed.fields, answers: answer.answers })
    return content.ok ? { result: { action: "accept", content: content.content } } : { result: { action: "cancel" } }
  } catch {
    return { result: { action: "cancel" } }
  } finally {
    waiting?.end()
  }
}
