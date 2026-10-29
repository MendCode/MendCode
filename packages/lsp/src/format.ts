import { relative, isAbsolute } from "node:path"
import type { DiagnosticSeverity, LspDiagnostic } from "./client"
import type { DiagnosticsResult } from "./manager"

export const MAX_LISTED = 50
const MAX_MESSAGE_CHARS = 240
const RANK: Record<DiagnosticSeverity, number> = { error: 0, warning: 1, info: 2, hint: 3 }

function shown({ file, cwd }: { file: string; cwd: string }): string {
  const rel = relative(cwd, file)
  return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? file : rel
}

/** `src/a.ts:12:5 error TS2322 Type 'x'…`, errors first, then by position. */
export function formatDiagnosticLines({ file, cwd, diagnostics, minSeverity = "hint" }: { file: string; cwd: string; diagnostics: LspDiagnostic[]; minSeverity?: DiagnosticSeverity }): string[] {
  const name = shown({ file, cwd })
  return diagnostics
    .filter((d) => RANK[d.severity] <= RANK[minSeverity])
    .sort((a, b) => RANK[a.severity] - RANK[b.severity] || a.line - b.line || a.col - b.col)
    .map((d) => {
      const message = d.message.replace(/\s+/g, " ").trim()
      const clipped = message.length > MAX_MESSAGE_CHARS ? `${message.slice(0, MAX_MESSAGE_CHARS - 1)}…` : message
      return `${name}:${d.line}:${d.col} ${d.severity}${d.code ? ` ${d.code}` : ""} ${clipped}`
    })
}

export function capLines(lines: string[], max = MAX_LISTED): string {
  return lines.length <= max ? lines.join("\n") : `${lines.slice(0, max).join("\n")}\n… ${lines.length - max} more`
}

/** Text for the `diagnostics` tool. */
export function formatDiagnosticsResult({ result, cwd }: { result: DiagnosticsResult; cwd: string }): string {
  if ("unavailable" in result) return `diagnostics unavailable: ${result.unavailable}`
  const lines = formatDiagnosticLines({ file: result.file, cwd, diagnostics: result.diagnostics })
  const note = result.settled ? "" : "\n(the language server was still working when the wait ended; results may be incomplete)"
  const issues = result.issues?.map((issue) => `\n${issue.server}: diagnostics unavailable: ${issue.message}`).join("") ?? ""
  return `${lines.length === 0 ? result.issues?.length ? "no problems reported by available servers" : "no problems" : capLines(lines)}${note}${issues}`
}
