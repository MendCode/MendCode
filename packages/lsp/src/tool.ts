import { z } from "zod"
import { defineTool, type Tool } from "@mendcode/tools"
import { formatDiagnosticLines, capLines, formatDiagnosticsResult } from "./format"
import { DEFAULT_TIMEOUT_MS, type LspManager } from "./manager"
import { LspInput } from "../../protocol/src/lsp"
import type { FormatterManager } from "./formatter"
import type { LspDiagnostic } from "./client"
import { relative } from "node:path"

const MAX_AFTER_WRITE_FILES = 5
const MAX_AFTER_WRITE_LINES = 20
const MAX_LATE_SESSIONS = 64
const MAX_LATE_FILES = 32
/** How long a write waits for a language server that is already running. */
export const DEFAULT_WRITE_WAIT_MS = 300

export function createLspTool(manager: LspManager): Tool {
  return defineTool({
    name: "lsp",
    description: "Semantic code navigation: goToDefinition, findReferences, hover, documentSymbol, workspaceSymbol, goToImplementation, prepareCallHierarchy, incomingCalls, outgoingCalls. filePath and editor line/character (1-based) are required; query filters workspace symbols.",
    permission: "read",
    args: LspInput,
    async execute(input, context) {
      const detail = input.operation === "workspaceSymbol" ? "" : input.operation === "documentSymbol" ? input.filePath : `${input.filePath}:${input.line}:${input.character}`
      const title = `${input.operation}${detail ? ` ${detail}` : ""}`
      const report = await manager.query({ ...input, cwd: context.cwd, signal: context.signal })
      const output = report.unavailable ? `LSP unavailable: ${report.unavailable}` : report.result.length ? JSON.stringify(report.result, null, 2) : `No results found for ${input.operation}`
      const warnings = !report.unavailable && report.issues?.length ? `\n${report.issues.map((issue) => `${issue.server}: ${issue.message}`).join("\n")}` : ""
      const text = output + warnings
      return { output: text.slice(0, 50_000), truncated: text.length > 50_000, title, isError: !!report.unavailable, meta: { results: report.result.length, available: !report.unavailable, ...(report.issues ? { issues: report.issues.length } : {}) } }
    },
  })
}

/** The `diagnostics` tool: language-server problems (errors, warnings) of one file. */
export function createDiagnosticsTool(manager: LspManager): Tool {
  return defineTool({
    name: "diagnostics",
    description: "Report compiler/type-checker problems for a file from its language server (TypeScript, Python, Go, Rust). Returns 'no problems' when clean.",
    permission: "read",
    args: z.object({ path: z.string().describe("File path, absolute or relative to the project root") }),
    async execute({ path }, context) {
      const title = `Diagnostics ${path}`
      if (context.signal.aborted) return { output: "cancelled", truncated: false, title, isError: true }
      const result = await manager.diagnostics({ path, cwd: context.cwd, signal: context.signal })
      const meta = "unavailable" in result ? { available: false } : { available: true, problems: result.diagnostics.length }
      return { output: formatDiagnosticsResult({ result, cwd: context.cwd }), truncated: false, title, isError: false, meta }
    },
  })
}

/**
 * Formats every written destination, then reports LSP errors of at most 5 files in 20 lines. Clean writes add nothing.
 * A configured formatter finishes (or is killed at `budgetMs`) before the hook returns, because it changes the file.
 * Diagnostics come only from servers already running: none running means no wait and no process. A running server is
 * given `diagnosticsWaitMs`; what it reports later (up to `budgetMs`) is kept per session and returned once, by
 * `late(sessionId)` or by that session's next write, whichever comes first.
 * With `warmUp`, a written file no running server covers has its locally installed servers started in the background,
 * after the hook returned and only if `warmUp()` then says yes; the write neither waits for that nor hears of its failure.
 */
export function createAfterWrite({ manager, formatter, budgetMs = DEFAULT_TIMEOUT_MS, diagnosticsWaitMs = DEFAULT_WRITE_WAIT_MS, warmUp }: { manager: LspManager; formatter?: FormatterManager; budgetMs?: number; diagnosticsWaitMs?: number; warmUp?: () => boolean }) {
  /** Per session and file: the newest write's wait (`lines` unset) or what it found after the hook returned. */
  const sessions = new Map<string, Map<string, { sequence: number; lines?: string[] }>>()
  let sequence = 0
  const section = (lines: string[]) => (lines.length ? `\n\nDiagnostics:\n${capLines(lines, MAX_AFTER_WRITE_LINES)}` : "")
  const take = (sessionId: string): string[] => {
    const files = sessions.get(sessionId)
    if (!files) return []
    const lines: string[] = []
    for (const [file, entry] of files) {
      if (!entry.lines) continue
      lines.push(...entry.lines)
      files.delete(file)
    }
    if (!files.size) sessions.delete(sessionId)
    return lines
  }
  const hook = async ({ cwd, paths, signal, sessionId = "" }: { cwd: string; paths: string[]; signal?: AbortSignal; sessionId?: string }): Promise<string | undefined> => {
    const warnings: string[] = []
    const unique = [...new Set(paths)]
    if (formatter) {
      for (const path of unique) {
        if (signal?.aborted) break
        try {
          const report = await formatter.file({ cwd, path, timeoutMs: budgetMs, ...(signal ? { signal } : {}) })
          for (const result of report.results) if (!result.ok) warnings.push(`${relative(cwd, report.file)}: ${result.name}: ${result.message}`)
          for (const issue of report.issues) warnings.push(`${issue.formatter ? `${issue.formatter}: ` : ""}${issue.message}`)
          if (report.unavailable && report.unavailable !== "cancelled") warnings.push(`${relative(cwd, report.file)}: ${report.unavailable}`)
        } catch { warnings.push(`${path}: formatter failed`) }
      }
    }
    if (signal?.aborted) return undefined
    const checked = unique.slice(0, MAX_AFTER_WRITE_FILES)
    const results = await Promise.all(checked.map((path) => manager.live({ path, cwd, boundMs: diagnosticsWaitMs, timeoutMs: budgetMs, ...(signal ? { signal } : {}) }).catch(() => undefined)))
    if (warmUp) {
      const cold = checked.filter((_, index) => !results[index])
      try { manager.warm({ paths: cold, cwd, enabled: warmUp }) } catch { /* a warm-up never fails a write */ }
    }
    const lines: string[] = []
    for (const result of results) {
      if (!result) continue
      const errors = (diagnostics: LspDiagnostic[]) => formatDiagnosticLines({ file: result.file, cwd, diagnostics, minSeverity: "error" })
      const shown = result.diagnostics ? errors(result.diagnostics) : []
      // This write replaces whatever an earlier write of the same file was still waiting for or had found.
      const files = sessions.get(sessionId)
      files?.delete(result.file)
      if (result.late) {
        const mine = ++sequence
        const waiting = files ?? new Map<string, { sequence: number; lines?: string[] }>()
        if (!files) {
          if (sessions.size >= MAX_LATE_SESSIONS) sessions.delete(sessions.keys().next().value!)
          sessions.set(sessionId, waiting)
        }
        if (waiting.size >= MAX_LATE_FILES) waiting.delete(waiting.keys().next().value!)
        waiting.set(result.file, { sequence: mine })
        void result.late.catch(() => undefined).then((diagnostics) => {
          const entry = waiting.get(result.file)
          if (entry?.sequence !== mine) return
          const final = diagnostics && !signal?.aborted ? errors(diagnostics) : shown
          // Only what the model has not been told yet is kept: the same errors again would be noise.
          if (final.join("\n") === shown.join("\n")) {
            waiting.delete(result.file)
            if (!waiting.size && sessions.get(sessionId) === waiting) sessions.delete(sessionId)
          } else entry.lines = final.length ? final : [`${relative(cwd, result.file)}: no errors (the language server finished after the earlier report)`]
        })
      }
      lines.push(...shown)
    }
    // Errors that arrived after an earlier write's result join this one, under the same heading.
    const output = [warnings.length ? `\n\nFormatting:\n${capLines([...new Set(warnings)], MAX_AFTER_WRITE_LINES)}` : "", section([...take(sessionId), ...lines])].join("")
    return output || undefined
  }
  /** Errors a language server reported after the hook returned; each is handed out once. */
  const late = (sessionId = ""): string | undefined => section(take(sessionId)) || undefined
  return Object.assign(hook, { late })
}
