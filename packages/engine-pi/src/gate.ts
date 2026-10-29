import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** Prefix of the dialog title the approval bridge sends; what follows is a JSON payload. */
export const GATE_MARK = "mendcode:tool-approval:"
/** The `setStatus` key and text the bridge announces itself with once pi loaded it. */
export const GATE_STATUS_KEY = "mendcode-gate"
export const GATE_READY = "ready"
/** Per-process challenge: stale or unrelated status messages are not a bridge handshake. */
export const GATE_TOKEN_ENV = "MENDCODE_PI_GATE_TOKEN"
const MAX_STRING = 6_000

/**
 * The bridge extension pi loads with `-e`. pi has no permission popups of its own, so every tool call goes through
 * the `tool_call` hook, which asks the client with a `select` dialog (pi's extension UI sub-protocol) and blocks the
 * call unless the answer is `allow`. It never edits pi's files or settings; it lives in a temporary directory.
 */
export const GATE_SOURCE = `const MARK = ${JSON.stringify(GATE_MARK)}
const LIMIT = ${MAX_STRING}
export default function (pi) {
  pi.on("tool_call", async (event, ctx) => {
    let choice
    try {
      const payload = JSON.stringify({ id: event.toolCallId, tool: event.toolName, input: event.input })
      if (payload.length > LIMIT) return { block: true, reason: "Tool arguments too large for approval; split the operation" }
      choice = await ctx.ui.select(MARK + payload, ["allow", "deny"])
    } catch {
      choice = undefined
    }
    if (choice === "allow") return undefined
    return { block: true, reason: "Not approved in MendCode" }
  })
  pi.on("session_start", (_event, ctx) => {
    try { ctx.ui.setStatus(${JSON.stringify(GATE_STATUS_KEY)}, ${JSON.stringify(GATE_READY)} + ":" + process.env.${GATE_TOKEN_ENV}) } catch {}
  })
}
`

export type PiToolPermission = "read" | "write" | "execute"

/** What a pi tool may do, in MendCode's permission classes. Unknown tools (from extensions) count as execute. */
export function piToolPermission(tool: string): PiToolPermission {
  switch (tool) {
    case "read":
    case "grep":
    case "find":
    case "ls":
      return "read"
    case "write":
    case "edit":
      return "write"
    default:
      return "execute"
  }
}

export type GateRequest = { id: string; tool: string; input: Record<string, unknown> }

/** The tool call behind an approval dialog of the bridge, or undefined when the title is anything else. */
export function parseGateRequest(title: unknown): GateRequest | undefined {
  if (typeof title !== "string" || !title.startsWith(GATE_MARK)) return undefined
  try {
    const body = JSON.parse(title.slice(GATE_MARK.length)) as Record<string, unknown>
    if (typeof body.tool !== "string" || title.length > GATE_MARK.length + MAX_STRING) return undefined
    const input = typeof body.input === "object" && body.input !== null && !Array.isArray(body.input) ? (body.input as Record<string, unknown>) : {}
    return { id: typeof body.id === "string" ? body.id : "", tool: body.tool, input }
  } catch {
    return undefined
  }
}

const text = (value: unknown) => (typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value, null, 2))

/** What the approval shows: the command, or the path with the content, or the arguments. */
export function gateDetail(request: GateRequest): string {
  const { tool, input } = request
  if (tool === "bash") return text(input.command)
  if (tool === "write") return `${text(input.path)}\n\n${text(input.content)}`
  if (tool === "edit") return `${text(input.path)}\n\n${text(input.edits ?? input)}`
  return JSON.stringify(input, null, 2)
}

/** Writes the bridge to a private temporary directory; `remove` deletes it. */
export function writeGateExtension(): { path: string; remove(): void } {
  const dir = mkdtempSync(join(tmpdir(), "mendcode-pi-"))
  const path = join(dir, "mendcode-gate.ts")
  writeFileSync(path, GATE_SOURCE, { mode: 0o600 })
  return { path, remove: () => rmSync(dir, { recursive: true, force: true }) }
}
