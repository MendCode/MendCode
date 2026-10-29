import type { DatabaseReport, DebugReport } from "@mendcode/protocol"
import type { DebugAutomation } from "./debug-args"
import type { AutomationDeps, Common } from "./automation"
import type { CommandInput } from "@mendcode/client"

export function databaseText(report: DatabaseReport, format: "json" | "tsv") {
  if (format === "json") return JSON.stringify(report.rows ?? [], null, 2) + "\n"
  const columns = report.columns ?? Object.keys(report.rows?.[0] ?? {})
  const cell = (value: unknown) => value === null || value === undefined ? "" : (typeof value === "object" ? JSON.stringify(value) : String(value)).replace(/[\t\r\n]/g, " ")
  const rows = report.rows ?? []
  return rows.length ? [columns.join("\t"), ...rows.map((row) => columns.map((column) => cell(row[column])).join("\t"))].join("\n") + "\n" : ""
}

export function debugText(report: DebugReport) {
  const data = report.data as Record<string, unknown>
  if (report.operation === "startup") return `${data.elapsedMs}\n`
  if (report.operation === "snapshot.track") return `${data.hash}\n`
  if (report.operation === "snapshot.diff") return `${data.diff}\n`
  if (report.operation === "file.search") return (report.data as string[]).join("\n") + "\n"
  if (report.operation === "file.tree") return JSON.stringify((data.lines as string[]).join("\n"), null, 2) + "\n"
  if (report.operation === "paths") return Object.entries(data).map(([key, value]) => `${key.padEnd(12)} ${value}`).join("\n") + "\n"
  return JSON.stringify(report.operation === "file.list" ? data.nodes : report.operation === "projects" ? data.projects : report.operation === "lsp.diagnostics" ? data.diagnostics : report.data, null, 2) + "\n"
}

export function createDebugAutomation(ctx: AutomationDeps & { directory: string; result(data: Record<string, unknown>, human: string): number; fail(message: string, code?: number, errorCode?: string): number }) {
  const database = async (sql: string, format: "json" | "tsv") => {
    const reply = await ctx.client.send({ type: "db.query", operation: "query", sql })
    if (!reply.ok) return ctx.fail(reply.error.message, 1, reply.error.code)
    const report = reply.result as DatabaseReport
    ctx.out.write(databaseText(report, format))
    if (report.truncated) ctx.err.write("[results truncated: 1000 rows / 100 KB]\n")
    return 0
  }
  return async (command: DebugAutomation & Common): Promise<number> => {
    if (command.kind === "debug.wait") return new Promise((resolve) => {
      let timer: { cancel(): void } | undefined
      const done = () => { timer?.cancel(); resolve(0) }
      ctx.onInterrupt(done)
      if (command.timeoutMs) timer = (ctx.setTimer ?? ((ms, callback) => { const handle = setTimeout(callback, ms); return { cancel: () => clearTimeout(handle) } }))(command.timeoutMs, done)
    })
    if (command.kind === "debug") {
      if (command.input.operation === "agent" && ctx.allowFiles === false) return ctx.fail("Agent debug is local only", 64, "usage")
      const request: CommandInput = { type: "debug.query", directory: ctx.directory, input: command.input }
      const reply = await ctx.client.send(request)
      if (!reply.ok) return ctx.fail(reply.error.message, 1, reply.error.code)
      const report = reply.result as unknown as DebugReport
      if (command.input.operation === "startup") report.data = { daemonElapsedMs: (report.data as { elapsedMs: number }).elapsedMs, elapsedMs: performance.now() }
      ctx.result(reply.result ?? {}, debugText(report))
      return (report.data as { result?: { isError?: boolean } } | null)?.result?.isError ? 1 : 0
    }
    if (command.operation === "path") {
      const reply = await ctx.client.send({ type: "db.query", operation: "path" })
      if (!reply.ok) return ctx.fail(reply.error.message, 1, reply.error.code)
      ctx.out.write(`${reply.result?.path}\n`)
      return 0
    }
    if (command.operation === "query") return database(command.sql!, command.format)
    const lines = ctx.sqlLines ? ctx.sqlLines() : (await import("./debug-shell")).terminalSqlLines(ctx.out)
    let pending = "", exit = 0
    for await (const line of lines) {
      const text = line.trim()
      if (!pending && [".quit", ".exit"].includes(text)) break
      if (!pending && text.startsWith(".")) {
        if (text === ".tables") exit = Math.max(exit, await database("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name", command.format))
        else if (/^\.schema(?:\s+[^\s]+)?$/.test(text)) {
          const table = text.split(/\s+/)[1]
          exit = Math.max(exit, await database(`SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL${table ? ` AND name='${table.replaceAll("'", "''")}'` : ""} ORDER BY name`, command.format))
        } else exit = Math.max(exit, ctx.fail("Unknown SQL shell command; .tables · .schema [TABLE] · .quit"))
        continue
      }
      pending += `${line}\n`
      if (pending.length > 65536) { exit = Math.max(exit, ctx.fail("SQL must be at most 65536 characters")); pending = "" }
      else if (/;\s*$/.test(text)) { exit = Math.max(exit, await database(pending.trim(), command.format)); pending = "" }
    }
    if (pending.trim()) exit = Math.max(exit, await database(pending.trim(), command.format))
    return exit
  }
}
