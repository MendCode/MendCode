import type { SessionId } from "@mendcode/protocol"
import type { ToolResult } from "@mendcode/tools"
import { z } from "zod"

/** One secret the user pasted into a session, as the agent may know it: the marker, what it is and its last characters. Never the value. */
export type SecretSummary = { n: number; marker: string; kind: string; tail: string }

/** Masks a stream of tool output whose chunks may cut a secret in two; `flush` returns what was held back. */
export type SecretStream = { push(chunk: string): string; flush(): string }

/**
 * What the engine needs to keep a pasted secret away from the model: the model only ever sees `‹secret:N›` markers.
 * `resolve` turns markers into values and is used once, right before a tool runs; `mask` turns values back into
 * markers and is applied to everything a tool returns. The daemon backs it with the store; `undefined` disables it.
 */
export interface SecretsPort {
  environment?(sessionId: SessionId): Record<string, string>
  list(sessionId: SessionId): SecretSummary[]
  resolve(sessionId: SessionId, text: string): string
  mask(sessionId: SessionId, text: string): string
  /** A masking stream for live output; `undefined` when the session has no secrets. */
  stream(sessionId: SessionId): SecretStream | undefined
}

/** Read-only: which markers the session has. Handled by the engine itself because it needs the session. */
export const SECRETS_TOOL = {
  name: "secrets",
  description:
    "List pasted secrets and configured environment credentials available in this session: identifiers and metadata, never values. Environment credentials are already injected into built-in shell processes; access them by variable name without printing or requesting their values. " +
    "You cannot read a secret. To use one, write its marker (for example ‹secret:1›) in a shell command or in the content of write, edit or apply_patch; MendCode puts the real value in locally just before the tool runs, after the user approves, and hides it again in the output.",
  args: z.object({}),
}

/** The tool arguments in which a marker becomes its value, by tool name. Nothing else ever receives a value. */
export const SECRET_ARGUMENTS: Readonly<Record<string, readonly string[]>> = {
  shell: ["command"],
  write: ["content"],
  edit: ["oldString", "newString"],
  apply_patch: ["patch"],
}

/** Appended to the system prompt of a session that has secrets, so the model knows how to use a marker. */
export function secretsNote(secrets: readonly SecretSummary[]) {
  return [
    "The user pasted secrets or configured environment credentials for this session. You see only identifiers, never the values:",
    ...secrets.map((secret) => `- ${secret.marker} ${secret.kind} …${secret.tail}`),
    "Entries labeled env are already authorized by the user and injected automatically into built-in shell and shell_session processes. Use os.environ[NAME] in Python or process.env.NAME in Node; do not print, read, reconstruct, or request their values. An env marker is an output mask, not a value to paste into a command.",
    "Never ask the user to repeat a configured secret and never try to read or reconstruct one. For pasted (non-env) secrets, put the marker in a shell command or in write/edit/apply_patch content; MendCode substitutes the value locally just before the tool runs and masks it in the output.",
  ].join("\n")
}

/** `args` of a built-in tool with the markers of its secret-bearing fields resolved; other arguments are untouched. */
export function resolveToolArgs({ tool, args, resolve }: { tool: string; args: unknown; resolve(text: string): string }): unknown {
  const fields = SECRET_ARGUMENTS[tool]
  if (!fields || typeof args !== "object" || args === null) return args
  const next: Record<string, unknown> = { ...(args as Record<string, unknown>) }
  for (const field of fields) if (typeof next[field] === "string") next[field] = resolve(next[field])
  return next
}

function maskDeep(value: unknown, mask: (text: string) => string): unknown {
  if (typeof value === "string") return mask(value)
  if (Array.isArray(value)) return value.map((entry) => maskDeep(entry, mask))
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, maskDeep(entry, mask)]))
  return value
}

/** A tool result with every text the model or the event log could see masked: output, title, meta and the render tree. Images cannot be masked. */
export function maskResult(result: ToolResult, mask: (text: string) => string): ToolResult {
  return {
    ...result,
    output: mask(result.output),
    title: mask(result.title),
    ...(result.meta ? { meta: maskDeep(result.meta, mask) as NonNullable<ToolResult["meta"]> } : {}),
    ...(result.render !== undefined ? { render: maskDeep(result.render, mask) } : {}),
  }
}

/** The answer of the `secrets` tool. */
export function secretsResult(secrets: readonly SecretSummary[]): ToolResult {
  const output = secrets.length ? secrets.map((secret) => `${secret.marker} ${secret.kind}${secret.tail ? ` …${secret.tail}` : ""}`).join("\n") : "no secrets in this session"
  return { output, truncated: false, title: "secrets", isError: false, meta: { count: secrets.length } }
}
