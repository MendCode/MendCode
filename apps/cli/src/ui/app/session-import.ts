import type { SessionId, SessionImportResult, SetupImportReport, StaticShare } from "@mendcode/protocol"
import { createTextPageState, preload } from "../lazy-pages"
import type { AppContext } from "./context"

const FROM: Readonly<Record<string, "claude-code" | "codex">> = { "claude-code": "claude-code", claude: "claude-code", codex: "codex" }
const LABEL: Readonly<Record<string, string>> = { "claude-code": "Claude Code", codex: "Codex", mendcode: "file" }
export const IMPORT_USAGE = "usage: /import [claude-code|codex] [file]  (no file: the newest session of this project) · /import setup [claude-code|codex] [apply]"
const KIND_LABEL = { mcp: "MCP server", command: "command", instructions: "instructions" } as const
const STATUS_LABEL = { new: "would add", imported: "added", exists: "kept yours", skipped: "skipped", failed: "failed" } as const

/** The setup report as text-page sections: what was found, what each item does, what is read in place, and what is never taken. */
export function setupImportSections(report: SetupImportReport) {
  const sections: Array<{ heading?: string; note?: string; lines: string[] }> = []
  if (!report.found.length && !report.inPlace.length) return [{ lines: ["No Claude Code or Codex setup found for this project and user."] }]
  if (report.found.length) sections.push({ heading: "Found", lines: report.found.map((entry) => `- ${entry.tool === "codex" ? "Codex" : "Claude Code"}: ${entry.file}`) })
  const count = report.items.filter((item) => item.status === (report.applied ? "imported" : "new")).length
  sections.push({
    heading: report.applied ? "Imported" : "Preview",
    note: report.items.length ? `${count} ${report.applied ? "written" : "to add"}` : "nothing to take over",
    lines: report.items.length ? report.items.map((item) => `- ${STATUS_LABEL[item.status]} · ${KIND_LABEL[item.kind]} ${item.name} (${item.tool === "codex" ? "Codex" : "Claude Code"}, ${item.scope})${item.enabled === false && item.kind === "mcp" ? " · disabled" : ""}${item.needs?.length ? ` · set ${item.needs.map((name) => `$${name}`).join(", ")} for the daemon` : ""}${item.note ? ` · ${item.note}` : ""}`) : ["Everything in these setups is already read in place or already here."],
  })
  if (report.inPlace.length) sections.push({ heading: "Read where it is", lines: report.inPlace.map((line) => `- ${line}`) })
  if (report.notImported.length) sections.push({ heading: "Never imported", lines: report.notImported.map((line) => `- ${line}`) })
  return sections
}
export const SHARE_STATIC_USAGE = "usage: /share local [remove] | /share gist --yes | /share gist remove"

/**
 * `/import` brings a Claude Code or Codex transcript (or a native session JSON) in as a new session and opens it. The
 * daemon reads the files, so this is local-only. `/share local|gist` are the Console-free links: a local HTML page, or a
 * secret gist that is only created after `--yes` because it leaves the machine.
 */
export function createSessionImport(ctx: AppContext, actions: { switchSession(sessionId: SessionId): Promise<unknown> }) {
  const { state, input, requestFrame, say, fail } = ctx
  /** `/import setup [tool] [apply]`: a preview of what Claude Code and Codex hold that MendCode can take over; `apply` writes it (never over yours, never a secret). */
  async function setupCommand(words: string[]): Promise<boolean> {
    const apply = words.some((word) => word.toLowerCase() === "apply" || word === "--apply")
    const rest = words.filter((word) => word.toLowerCase() !== "apply" && word !== "--apply")
    const from = rest[0] ? FROM[rest[0].toLowerCase()] : undefined
    if (rest.length > 1 || rest[0] && !from) { say(IMPORT_USAGE, "warning"); return true }
    await preload("recap")
    const reply = await input.send({ type: "setup.import", directory: input.directory ?? process.cwd(), ...(from ? { from } : {}), ...(apply ? { apply: true } : {}) })
    if (!reply.ok) { fail(reply.error.message); return true }
    const report = reply.result as SetupImportReport
    const fresh = report.items.filter((item) => item.status === "new").length
    const next = !apply && fresh ? `nothing added yet · /import setup apply adds all ${fresh} · /setup picks which` : "/import setup to look again"
    state.textPage = createTextPageState({ title: "Import setup", summary: next, sections: setupImportSections(report) })
    state.textReturn = state.page === "text" ? state.textReturn : state.page
    state.page = "text"
    requestFrame()
    return true
  }

  async function importCommand(text: string): Promise<boolean> {
    const match = /^\/import(?:\s+(.*))?$/s.exec(text.trim())
    if (!match) return false
    if (input.remote) { fail("Import reads local files and is local only"); return true }
    const words = (match[1] ?? "").trim().split(/\s+/).filter(Boolean)
    if (words[0]?.toLowerCase() === "setup") return setupCommand(words.slice(1))
    const from = words[0] ? FROM[words[0].toLowerCase()] : undefined
    if (from) words.shift()
    const source = words.join(" ")
    const reply = await input.send({ type: "session.import", directory: input.directory ?? process.cwd(), ...(source ? { source } : { latest: true }), ...(from ? { from } : {}) })
    if (!reply.ok) { fail(reply.error.message); return true }
    const result = reply.result as SessionImportResult
    await actions.switchSession(result.sessionId)
    say(`imported ${result.turns} turn${result.turns === 1 ? "" : "s"} from ${LABEL[result.from ?? "mendcode"]}${result.truncated ? " (trimmed to fit)" : ""}`, "success")
    requestFrame()
    return true
  }

  async function shareStaticCommand(text: string): Promise<boolean> {
    const match = /^\/share\s+(local|gist)(?:\s+(.*))?$/s.exec(text.trim())
    if (!match) return false
    const target = match[1] as "local" | "gist"
    if (input.remote) { fail("Sharing control is local only"); return true }
    const words = (match[2] ?? "").trim().split(/\s+/).filter(Boolean)
    const remove = words.includes("remove")
    const confirm = words.includes("--yes")
    if (words.some((word) => word !== "remove" && word !== "--yes")) { say(SHARE_STATIC_USAGE, "warning"); return true }
    if (target === "gist" && !remove && !confirm) { say("A gist uploads the chat to GitHub (secret link) · /share gist --yes", "warning"); return true }
    const reply = await input.send({ type: "session.share.static", sessionId: state.sessionId, target, action: remove ? "remove" : "create", ...(confirm ? { confirm: true } : {}) })
    if (!reply.ok) { fail(reply.error.message); return true }
    const share = reply.result as StaticShare
    if (!share.shared || !share.url) say(`removed the ${target} share`, "success")
    else { ctx.copyText(share.url, "share link"); say(`shared ${target}: ${share.url}${share.truncated ? " (trimmed)" : ""}`, "success") }
    return true
  }

  return { importCommand, shareStaticCommand }
}
