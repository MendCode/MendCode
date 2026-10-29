import { z } from "zod"
import { Command, parseCommand } from "./commands"
import { ErrorPayload, GlobalEvent, SessionEvent } from "./events"
import { CommandId } from "./ids"
import { MAX_FRAME_BYTES, PROTOCOL_VERSION } from "./constants"
import { lazySchema } from "./lazy"

/** One JSON object per line over a unix socket or TCP stream. */
export const Frame = lazySchema(() => z.discriminatedUnion("kind", [
  z.strictObject({ v: z.literal(PROTOCOL_VERSION), kind: z.literal("auth"), id: CommandId, token: z.string().min(1).max(4096) }),
  z.strictObject({ v: z.literal(PROTOCOL_VERSION), kind: z.literal("command"), body: Command }),
  z.strictObject({ v: z.literal(PROTOCOL_VERSION), kind: z.literal("event"), body: SessionEvent }),
  z.strictObject({ v: z.literal(PROTOCOL_VERSION), kind: z.literal("global"), body: GlobalEvent }),
  z.strictObject({
    v: z.literal(PROTOCOL_VERSION),
    kind: z.literal("ack"),
    id: CommandId,
    result: z.record(z.string(), z.unknown()).optional(),
  }),
  z.strictObject({ v: z.literal(PROTOCOL_VERSION), kind: z.literal("error"), id: CommandId.optional(), error: ErrorPayload }),
]))
export type Frame = z.infer<typeof Frame>

export { MAX_FRAME_BYTES } from "./constants"

export type DecodeResult = { ok: true; frame: Frame } | { ok: false; error: string }

/**
 * A well-formed command frame, validated with the schema of its own command only. Anything else (another frame kind,
 * an unknown field, a body that fails) returns undefined and takes the full `Frame` path, which builds every schema
 * but reports exactly the issues it always did.
 */
function decodeCommandFrame(json: unknown): Extract<Frame, { kind: "command" }> | undefined {
  if (typeof json !== "object" || json === null || Array.isArray(json)) return undefined
  const { v, kind, body, ...rest } = json as Record<string, unknown>
  if (v !== PROTOCOL_VERSION || kind !== "command" || Object.keys(rest).length > 0) return undefined
  const parsed = parseCommand(body)
  return parsed.success ? { v: PROTOCOL_VERSION, kind: "command", body: parsed.data } : undefined
}

export function decodeFrame(line: string): DecodeResult {
  if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) return { ok: false, error: "[PROTOCOL]: frame exceeds MAX_FRAME_BYTES" }
  let json: unknown
  try {
    json = JSON.parse(line)
  } catch {
    return { ok: false, error: "[PROTOCOL]: frame is not valid JSON" }
  }
  const command = decodeCommandFrame(json)
  if (command) return { ok: true, frame: command }
  const parsed = Frame.safeParse(json)
  if (!parsed.success) return { ok: false, error: `[PROTOCOL]: ${z.prettifyError(parsed.error)}` }
  return { ok: true, frame: parsed.data }
}

export function encodeFrame(frame: Frame) {
  return `${JSON.stringify(frame)}\n`
}
