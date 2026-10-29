import type { SessionExportResult, SessionId, SessionSummary } from "@mendcode/protocol"
import type { CommandInput } from "@mendcode/client"
import type { AutomationDeps, Common } from "./automation"
import type { TransferExport, TransferImport } from "./session-transfer-args"

type Reply = { ok: true; result: Record<string, unknown> } | { ok: false; message: string; code: string }
type Context = AutomationDeps & { directory: string; request(command: CommandInput): Promise<Reply>; result(data: Record<string, unknown>, human: string): number; fail(message: string, exit?: number, code?: string): number }
export function exportSessionPrompt(sessions: SessionSummary[]) {
  return { title: "Export session", label: "Sessions", options: [...sessions].sort((a, b) => b.updatedAt - a.updatedAt).map((session) => ({ value: session.sessionId, label: session.title || session.sessionId, hint: `${new Date(session.updatedAt).toISOString()} · ${session.sessionId}` })) }
}
/** A small CLI factory; files and network stay in the daemon, terminal prompts remain injectable. */
export function createSessionTransferAutomation(ctx: Context) {
  return async (command: (TransferExport | TransferImport) & Common): Promise<number> => {
    if (command.kind === "session.import") {
      if (ctx.allowFiles === false) return ctx.fail("Session import is local-only; remote clients cannot read daemon files or URLs", 64)
      const reply = await ctx.request({ type: "session.import", directory: ctx.directory, ...(command.source ? { source: command.source } : {}), ...(command.from ? { from: command.from } : {}), ...(command.latest ? { latest: true } : {}) })
      if (!reply.ok) return ctx.fail(reply.message)
      const note = reply.result.attachmentFilesOmitted ? ` · ${reply.result.attachmentFilesOmitted} attachment files omitted` : ""
      const origin = typeof reply.result.from === "string" && reply.result.from !== "mendcode" ? ` · from ${reply.result.from}` : ""
      return ctx.result(reply.result, `Imported session: ${reply.result.sessionId}${origin}${reply.result.truncated ? " · truncated transcript" : ""}${note}\n`)
    }
    let id = command.id
    if (!id) {
      const listed = await ctx.request({ type: "session.list", roots: false, limit: 500 })
      if (!listed.ok) return ctx.fail(listed.message)
      const sessions = listed.result.sessions as SessionSummary[]
      if (!sessions.length) return ctx.fail("No sessions found")
      if (!ctx.prompt) return ctx.fail("Export needs a session ID when no interactive terminal is available", 64)
      id = await ctx.prompt(exportSessionPrompt(sessions))
      if (id === undefined) return 2
      if (!sessions.some((session) => session.sessionId === id)) return ctx.fail("Selected session is unavailable")
    }
    const reply = await ctx.request({ type: "session.export", sessionId: id as SessionId, format: command.outputFormat ?? "json",
      ...((command.outputFormat ?? "json") === "json" ? { reasoning: true, toolDetails: true, assistantMetadata: true, timestamps: true } : {}),
      ...Object.fromEntries(["reasoning", "toolDetails", "assistantMetadata", "timestamps", "sanitize"].filter((key) => command[key as keyof TransferExport] !== undefined).map((key) => [key, command[key as keyof TransferExport]])),
    })
    if (!reply.ok) return ctx.fail(reply.message)
    const exported = reply.result as SessionExportResult
    if (command.raw) {
      ctx.out.write(`${exported.text.trimEnd()}\n`)
      if (exported.truncated) ctx.err.write("Export truncated to transcript/frame limits\n")
      return 0
    }
    return ctx.result(reply.result, `${exported.text.trimEnd()}\n`)
  }
}
