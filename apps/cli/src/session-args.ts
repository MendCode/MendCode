import type { ReasoningEffort } from "@mendcode/protocol"
import { REASONING_EFFORTS } from "@mendcode/protocol/wire"
import { parseTransferExport, type TransferExport } from "./session-transfer-args"
export type SessionSelection = { agent?: string; model?: string; variant?: string; effort?: ReasoningEffort }
export type SessionAutomation =
  | { kind: "session.list"; all: boolean; allProjects?: boolean; limit: number; project?: string; state?: string; active?: boolean; since?: number; search?: string; agent?: string; model?: string; archived?: boolean }
  | ({ kind: "session.create"; title: string; parent?: string } & SessionSelection)
  | { kind: "session.get" | "session.status" | "session.delete"; id: string }
  | { kind: "session.inspect"; id: string; limit: number }
  | { kind: "session.stats"; id: string }
  | { kind: "session.rename"; id: string; title: string }
  | { kind: "session.fork"; id: string; messageId?: string }
  | TransferExport
  | ({ kind: "session.send"; id: string; text: string; wait: boolean; approve: boolean; skipPermissions?: boolean; timeoutMs?: number; intervalMs?: number; files?: string[]; command?: string; mode?: "auto" | "queue" | "steer" | "restart"; requestId?: string } & SessionSelection)
  | { kind: "session.wait"; id: string; timeoutMs?: number; intervalMs?: number; idle?: boolean }
  | { kind: "session.events"; id: string; after: number; follow: boolean; keepOpen?: boolean; limit?: number }
  | { kind: "session.cancel"; id: string }
  | { kind: "session.pause" | "session.resume" | "session.stop"; id: string }
  | { kind: "session.archive"; id: string; restore: boolean }

/** The prefix --dir keeps v2's data-directory contract; session --dir targets a project. */
export function sessionDirectories(argv: string[]) {
  let dataDir: string | undefined
  let projectDir: string | undefined
  let session = false
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!
    if (token === "--") break
    if (token === "session") session = true
    const match = /^--(data-dir|dir)(?:=(.*))?$/.exec(token)
    if (!match) continue
    const value = match[2] ?? argv[++i]
    if (value === undefined) continue
    if (match[1] === "data-dir" || !session) dataDir = value
    else projectDir = value
  }
  return { ...(dataDir ? { dir: dataDir } : {}), ...(projectDir ? { projectDir } : {}) }
}

export function parseSession(sub: string | undefined, rest: string[], flags: Map<string, string | true>, repeated: Map<string, string[]>) : { command: SessionAutomation } | { error: string } {
  const str = (name: string) => typeof flags.get(name) === "string" ? String(flags.get(name)) : undefined
  const number = (name: string, min: number, max = Number.MAX_SAFE_INTEGER) => {
    const text = str(name)
    if (text === undefined) return undefined
    const value = Number(text)
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`--${name} needs a whole number from ${min} to ${max}`)
    return value
  }
  const id = rest[0]
  const ok = (command: SessionAutomation) => ({ command })
  try {
    if (!sub) throw new Error("session needs a command")
    if (flags.has("archived") && sub !== "list") throw new Error("--archived is only valid for session list")
    if (flags.has("restore") && sub !== "archive") throw new Error("--restore is only valid for session archive")
    const selection: SessionSelection = { ...(str("agent") ? { agent: str("agent")! } : {}), ...(str("model") ? { model: str("model")! } : {}), ...(str("variant") ? { variant: str("variant")! } : {}), ...(str("effort") ? { effort: str("effort") as ReasoningEffort } : {}) }
    if (selection.effort && !(REASONING_EFFORTS as readonly string[]).includes(selection.effort)) throw new Error(`--effort must be one of ${REASONING_EFFORTS.join(", ")}`)
    if (selection.effort && sub !== "create" && sub !== "send") throw new Error("--effort is only valid for session create and session send")
    if (selection.model && (!selection.model.trim() || selection.model.endsWith("/"))) throw new Error("--model needs provider/model or a MendCode catalog id")
    const timeout = () => {
      if (flags.has("timeout") && flags.has("timeout-ms")) throw new Error("use --timeout or --timeout-ms")
      if (flags.has("timeout-ms")) return number("timeout-ms", 1, 2_147_483_647)
      if (!flags.has("timeout")) return undefined
      const seconds = Number(str("timeout"))
      if (!Number.isFinite(seconds) || seconds <= 0 || seconds * 1000 > 2_147_483_647) throw new Error("--timeout needs a positive number up to 2147483 seconds")
      return Math.ceil(seconds * 1000)
    }
    switch (sub) {
      case "list": {
        if (rest.length) throw new Error("session list takes no arguments")
        if (flags.has("max-count") && flags.has("limit")) throw new Error("use --max-count or --limit")
        const limit = number(flags.has("max-count") ? "max-count" : "limit", 1, 500) ?? 50
        return ok({ kind: "session.list", all: flags.has("all"), limit, ...selection, ...(flags.has("all-projects") ? { allProjects: true } : {}), ...(str("project") ? { project: str("project")! } : {}), ...(str("state") ? { state: str("state")! } : {}), ...(flags.has("active") ? { active: true } : {}), ...(str("since") !== undefined ? { since: number("since", 0)! } : {}), ...(str("search") !== undefined ? { search: str("search")! } : {}), ...(flags.has("archived") ? { archived: true } : {}) })
      }
      case "create":
        if (rest.length) throw new Error("session create takes no arguments")
        return ok({ kind: "session.create", title: str("title") ?? "", ...selection, ...(str("parent") ? { parent: str("parent")! } : {}) })
      case "send": {
        const text = rest.slice(1).join(" ").trim()
        if (!id || (!text && !str("command") && !repeated.get("file")?.length)) throw new Error('session send needs <id> and "text", --file or --command')
        const timeoutMs = timeout()
        const intervalMs = number("interval-ms", 1, 2_147_483_647)
        if ((repeated.get("file")?.length ?? 0) > 32) throw new Error("--file accepts at most 32 attachments")
        const mode = str("mode")
        if (mode !== undefined && mode !== "auto" && mode !== "queue" && mode !== "steer" && mode !== "restart") throw new Error("--mode needs auto, queue, steer or restart")
        if (mode && str("command")) throw new Error("--mode does not apply to --command")
        // A steered message joins the running turn: no turn of its own starts, so there is nothing to wait for.
        const joins = mode === "auto" || mode === "steer"
        if (joins && flags.has("wait")) throw new Error(`--mode ${mode} joins the running turn and cannot wait for a turn of its own; use --async`)
        const requestId = str("request-id")
        if (requestId !== undefined && (!requestId.trim() || requestId.length > 128)) throw new Error("--request-id needs 1–128 characters")
        return ok({ kind: "session.send", id, text, wait: flags.has("wait") || !flags.has("async") && !joins, approve: flags.has("approve") || flags.has("dangerously-skip-permissions"), ...(flags.has("dangerously-skip-permissions") ? { skipPermissions: true } : {}), ...(mode ? { mode } : {}), ...(requestId ? { requestId } : {}), ...selection, ...(timeoutMs ? { timeoutMs } : {}), ...(intervalMs ? { intervalMs } : {}), ...(repeated.get("file")?.length ? { files: repeated.get("file")! } : {}), ...(str("command") ? { command: str("command")! } : {}) })
      }
      case "wait": {
        if (!id || rest.length !== 1) throw new Error("session wait needs <id>")
        const timeoutMs = timeout()
        const intervalMs = number("interval-ms", 1, 2_147_483_647)
        return ok({ kind: "session.wait", id, ...(timeoutMs ? { timeoutMs } : {}), ...(intervalMs ? { intervalMs } : {}), ...(flags.has("idle") ? { idle: true } : {}) })
      }
      case "events": {
        if (!id || rest.length !== 1) throw new Error("session events needs <id>")
        const limit = number("limit", 1)
        return ok({ kind: "session.events", id, after: number("after", 0) ?? 0, follow: flags.has("follow"), ...(flags.has("keep-open") ? { keepOpen: true } : {}), ...(limit ? { limit } : {}) })
      }
      case "rename": {
        const title = rest.slice(1).join(" ").trim()
        if (!id || !title || title.length > 200) throw new Error("session rename needs <id> and a title (1–200 characters)")
        return ok({ kind: "session.rename", id, title })
      }
      case "fork":
        if (!id || rest.length !== 1) throw new Error("session fork needs <id>")
        return ok({ kind: "session.fork", id, ...(str("message-id") ? { messageId: str("message-id")! } : {}) })
      case "archive":
        if (!id || rest.length !== 1) throw new Error("session archive needs <id>")
        return ok({ kind: "session.archive", id, restore: flags.has("restore") })
      case "inspect":
        if (!id || rest.length !== 1) throw new Error("session inspect needs <id>")
        return ok({ kind: "session.inspect", id, limit: number("limit", 0, 50) ?? 50 })
      case "stats":
        if (!id || rest.length !== 1) throw new Error("session stats needs <id>")
        return ok({ kind: "session.stats", id })
      case "export": {
        const parsed = parseTransferExport(rest, flags)
        return "error" in parsed ? parsed : ok(parsed)
      }
      case "get": case "status": case "delete": case "cancel": case "pause": case "resume": case "stop":
        if (!id || rest.length !== 1) throw new Error(`session ${sub} needs <id>`)
        return ok({ kind: `session.${sub}`, id })
      default: throw new Error(`unknown session command "${sub}"`)
    }
  } catch (error) { return { error: (error as Error).message } }
}
