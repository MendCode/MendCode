import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { CommandInput, CommandReply } from "@mendcode/client"
import type { GlobalEvent, SessionId, SessionSummary } from "@mendcode/protocol"
import { openStore } from "@mendcode/store"
import { cleanTemps, appHarness, ids, plain, tempDir } from "../apps/cli/test/session-ui-harness"
import { FILES, paste } from "../apps/cli/test/inline-attachments-helpers"
import { DEFAULT_TUI_PROFILE, writeTuiProfile, type TuiProfile } from "../apps/cli/src/view/tui-profile"
import { projectSessions } from "../apps/cli/src/view/sidebar"
import { sliceSpans } from "../apps/cli/src/view/file-viewer"
import { activeTheme, sgr, type Line, type Span } from "../apps/cli/src/ui/theme"

/**
 * The frames of the draft work: every one is a screen of the real wired app on a daemon whose store is the real one of the tree this
 * runs in, so the same script draws the code before the change and after it. Usage:
 * `bun scripts/render-drafts-frames.ts <directory> <before|after>`. Writes `<label>-<scene>.txt` and `.ansi` (the dark theme `mend`) and
 * `.roles.txt`: every span tagged by its theme role, the dark theme and then the light one (`paper`), with the roles' colors.
 * The daemon below pushes `session.activity` with the draft head and lists it in `session.list` only when the store can say it
 * (`drafts.heads`), as the daemon of that version does; the older store keeps whatever it is given, as it did.
 */
const target = process.argv[2] ?? path.join(import.meta.dir, "../.agents/runs/frames/drafts")
const label = process.argv[3] ?? "after"
mkdirSync(target, { recursive: true })

const PROJECT = "/repo"
const SHOT = "/shots/one.png"
const THEMES = [{ label: "dark", name: "mend" }, { label: "light", name: "paper" }] as const

function daemon() {
  const dir = mkdtempSync(path.join(tmpdir(), "mendcode-draft-frames-"))
  const store = openStore({ dir })
  const listeners = new Set<(event: GlobalEvent) => void>()
  const heads = (store.drafts as unknown as { heads?: (sessionIds: SessionId[]) => Map<SessionId, unknown> }).heads?.bind(store.drafts)
  const push = (sessionId: SessionId, draft: unknown) => {
    const info = store.sessionInfo(sessionId)
    if (!info) return
    for (const listener of listeners) listener({ type: "session.activity", gseq: 0, at: 1, sessionId, directory: info.directory, title: info.title, state: "idle", updatedAt: info.updatedAt, ...(draft !== undefined ? { draft } : {}) } as GlobalEvent)
  }
  const session = (title = "") => {
    const id = ids("session")
    store.createSession({ id, directory: PROJECT, title })
    return id
  }
  const reply = (command: CommandInput): CommandReply | undefined => {
    const c = command as CommandInput & Record<string, any>
    if (command.type === "draft.set") {
      const before = heads?.([c.sessionId]).get(c.sessionId) as { preview?: string; attachments?: number } | undefined
      if (!store.drafts.set(c.sessionId, c.text, c.attachments ?? [])) return { ok: false, error: { code: "unknown_session", message: "unknown session" } } as CommandReply
      const after = heads?.([c.sessionId]).get(c.sessionId) as { preview?: string; attachments?: number } | undefined
      if (heads && (before?.preview !== after?.preview || before?.attachments !== after?.attachments || (before === undefined) !== (after === undefined))) push(c.sessionId, after ?? null)
      return { ok: true }
    }
    if (command.type === "draft.get") {
      const draft = store.drafts.get(c.sessionId)
      return { ok: true, result: draft ? { draft } : {} } as CommandReply
    }
    if (command.type === "draft.list") return { ok: true, result: { drafts: store.drafts.list({ directory: c.directory, excludeSessionId: c.excludeSessionId, limit: c.limit }) } } as CommandReply
    if (command.type === "session.list") {
      const sessions = store.listSessions({ directory: c.directory, limit: c.limit ?? 50, archived: c.archived, hideEmpty: c.hideEmpty })
      const found = heads?.(sessions.map((entry) => entry.sessionId))
      return { ok: true, result: { sessions: sessions.map((entry) => ({ ...entry, state: "idle", ...(found?.has(entry.sessionId) ? { draft: found.get(entry.sessionId) } : {}) })) } } as CommandReply
    }
    if (command.type === "attachment.paste") {
      const found = FILES[String(c.path)]
      return found ? { ok: true, result: found } as CommandReply : undefined
    }
    return undefined
  }
  return { store, reply, session, listen: (listener: (event: GlobalEvent) => void) => void listeners.add(listener), close: () => { store.close(); rmSync(dir, { recursive: true, force: true }) } }
}
type Daemon = ReturnType<typeof daemon>

async function terminal(d: Daemon, theme: string, options: { sessionId?: SessionId; profile?: Partial<TuiProfile>; width?: number; height?: number } = {}) {
  const dataDir = tempDir()
  writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, theme, ...options.profile })
  const sessionId = options.sessionId ?? d.session()
  const h = appHarness({ dataDir, directory: PROJECT, sessionId, reply: d.reply, width: options.width ?? 120, height: options.height ?? 30 })
  d.listen((event) => h.app.onGlobal(event))
  h.app.applySettings({ onboarded: true })
  await Bun.sleep(40)
  h.app.render()
  /** Clicks a session's title row in the left list: the list is ordered the way the sidebar orders it, three rows a session under its heading. */
  const click = async (target: SessionId) => {
    const listed = (d.reply({ type: "session.list", directory: PROJECT, hideEmpty: true } as CommandInput) as unknown as { result: { sessions: SessionSummary[] } }).result.sessions
    const index = projectSessions(listed, PROJECT).findIndex((entry) => entry.sessionId === target)
    if (index < 0) throw new Error("the session is not in the list")
    await h.type(`\x1b[<0;5;${3 + 3 * index + 1}M`)
    await Bun.sleep(40)
    h.app.render()
  }
  return { h, sessionId, click }
}
type Terminal = Awaited<ReturnType<typeof terminal>>

function tag(span: Span): string {
  const parts = [`fg=${span.fg ?? span.fgHex ?? "(terminal)"}`]
  if (span.bg || span.bgHex) parts.push(`bg=${span.bg ?? span.bgHex}`)
  for (const attribute of ["bold", "dim", "italic", "underline", "strike"] as const) if (span[attribute]) parts.push(attribute)
  if (span.link) parts.push("link")
  return parts.join(" ")
}

function rolesOf(lines: Line[], width: number): string[] {
  return lines.map((line, row) => {
    const merged: Span[] = []
    for (const span of sliceSpans(line, 0, width)) {
      const last = merged.at(-1)
      if (last && tag(last) === tag(span)) last.text += span.text
      else merged.push({ ...span })
    }
    const shown = (text: string) => JSON.stringify(text.replace(/ {4,}/g, (run) => `<${run.length} spaces>`))
    return `${String(row).padStart(2)}| ${merged.filter((span) => span.text !== "").map((span) => `[${tag(span)}] ${shown(span.text)}`).join(" ")}`
  })
}

const roleTable = () => Object.entries(activeTheme().colors as Record<string, string>).map(([role, hex]) => `  ${role.padEnd(12)} ${hex}`)

/** One scene, drawn in the dark theme (text, ansi) and in both for the role tags. `crop` keeps the first columns only (the sidebar). */
async function scene(name: string, act: (theme: string, d: Daemon) => Promise<Terminal>, crop = 120) {
  const sections: string[] = []
  for (const theme of THEMES) {
    const d = daemon()
    const t = await act(theme.name, d)
    t.h.app.render()
    const lines = (t.h.frames.at(-1) ?? []).map((line) => sliceSpans(line, 0, crop))
    sections.push(`== ${theme.label} (${theme.name}) ==`, ...rolesOf(lines, crop), "", `roles in ${theme.name}:`, ...roleTable(), "")
    if (theme.label === "dark") {
      writeFileSync(path.join(target, `${label}-${name}.txt`), lines.map((line) => plain(line).trimEnd()).join("\n") + "\n")
      writeFileSync(path.join(target, `${label}-${name}.ansi`), lines.map((line) => line.map((span) => sgr(span, "truecolor") + span.text + "\x1b[0m").join("")).join("\n") + "\n")
      console.log(`${label}-${name}: ${lines.length} rows`)
    }
    d.close()
    cleanTemps()
  }
  writeFileSync(path.join(target, `${label}-${name}.roles.txt`), sections.join("\n"))
}

const pastedShot = async (t: Terminal) => { await t.h.type(paste(SHOT)); await t.h.app.saveDrafts() }

/** Project with: a titled chat, a draft of words, a draft of attachments only, and this terminal's own blank session. */
function seeded(d: Daemon) {
  d.session("Fix retry loop in the sync worker")
  const words = d.session()
  d.store.drafts.set(words, "\n  fix the retry loop in the sync worker so a timeout backs off\nand keeps the queue")
  const shot = d.session()
  d.store.drafts.set(shot, "[Image #1] ", [{ sha256: "1".repeat(64), bytes: 315187, mime: "image/png", name: "one.png", label: "[Image #1]", at: 10 }])
  return { words, shot }
}

// Issue 1: the notice under the prompt.
await scene("notice-image-only-chips-above", async (theme, d) => {
  const first = await terminal(d, theme, { profile: { attachmentChips: "above" } })
  await pastedShot(first)
  return terminal(d, theme)
})
await scene("notice-image-only-tokens", async (theme, d) => {
  const first = await terminal(d, theme)
  await pastedShot(first)
  return terminal(d, theme)
})
await scene("notice-text-and-image", async (theme, d) => {
  const first = await terminal(d, theme)
  await first.h.type("look at ")
  await first.h.type(paste(SHOT))
  await first.h.type("now")
  await first.h.app.saveDrafts()
  return terminal(d, theme)
})

// Issue 2: the left list, /sessions, and the prompt on opening.
await scene("sidebar-draft-rows", async (theme, d) => {
  seeded(d)
  return terminal(d, theme)
})
await scene("sidebar-30-columns", async (theme, d) => {
  seeded(d)
  return terminal(d, theme)
}, 30)
await scene("sessions-page", async (theme, d) => {
  seeded(d)
  const t = await terminal(d, theme, { width: 130, height: 34 })
  await t.h.type("/sessions")
  await t.h.type("\r")
  await Bun.sleep(40)
  return t
})
await scene("open-draft-empty-prompt", async (theme, d) => {
  const { words } = seeded(d)
  const t = await terminal(d, theme)
  await t.click(words)
  return t
})
await scene("open-draft-after-typing", async (theme, d) => {
  const { words } = seeded(d)
  const t = await terminal(d, theme)
  await t.h.type("something I was typing here")
  await t.click(words)
  return t
})
await scene("open-attachment-draft", async (theme, d) => {
  const { shot } = seeded(d)
  const t = await terminal(d, theme)
  await t.click(shot)
  return t
})
