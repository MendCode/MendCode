import { afterEach, describe, expect, test } from "bun:test"
import type { SessionDraft, SessionId, SessionSummary } from "@mendcode/protocol"
import { appHarness, cleanTemps, NOW, tempDir } from "./session-ui-harness"
import { draftDaemon, PROJECT, type DraftDaemon } from "./session-draft-daemon"
import { paste } from "./inline-attachments-helpers"
import { DEFAULT_TUI_PROFILE, writeTuiProfile, type TuiProfile } from "../src/view/tui-profile"
import { SIDEBAR_WIDTH, renderSessionSidebar } from "../src/view/sidebar"
import { renderSessionList, createSessionListState } from "../src/view/session-list"
import { matchesQuery, parseSessionQuery, selectSessions } from "../src/view/session-query"
import { attachmentsLabel, draftSizeLabel, labelString, sessionActivityAt, sessionLabel, withPushedDraft } from "../src/view/session-label"
import { contentSize, draftSize, unsentNotice } from "../src/ui/drafts"
import { threadMentions } from "../src/view/mentions"
import { sessionRows } from "../src/automation"
import { sessionDisplayTitle } from "../src/ui/app/display-title"
import { glyphs } from "../src/ui/theme"

const daemons: DraftDaemon[] = []
afterEach(() => {
  for (const daemon of daemons.splice(0)) daemon.close()
  cleanTemps()
})

const SHOT = "/shots/one.png"
const PDF = "/docs/design-spec.pdf"

function boot() {
  const daemon = draftDaemon()
  daemons.push(daemon)
  return daemon
}

/** A terminal on the daemon, attached to `sessionId` (a new blank session by default). */
async function terminal(daemon: DraftDaemon, options: { sessionId?: SessionId; profile?: Partial<TuiProfile>; width?: number; height?: number } = {}) {
  const dataDir = tempDir()
  writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, ...options.profile })
  const sessionId = options.sessionId ?? daemon.createSession()
  const h = appHarness({ dataDir, directory: PROJECT, sessionId, reply: daemon.reply, width: options.width ?? 120, height: options.height ?? 30 })
  daemon.listen((event) => h.app.onGlobal(event))
  h.app.applySettings({ onboarded: true })
  await Bun.sleep(30)
  h.app.render()
  const screen = () => h.text().join("\n")
  const sidebar = () => h.text().map((row) => row.slice(0, SIDEBAR_WIDTH))
  /** Clicks the sidebar row that contains `text`. */
  const click = async (text: string) => {
    const row = sidebar().findIndex((line) => line.includes(text))
    if (row < 0) throw new Error(`no sidebar row with ${text}\n${sidebar().join("\n")}`)
    await h.type(`\x1b[<0;5;${row + 1}M`)
    await Bun.sleep(30)
    h.app.render()
  }
  return { h, sessionId, screen, sidebar, click, editor: h.app.editor, drafted: () => daemon.store.drafts.get(sessionId) }
}
type Terminal = Awaited<ReturnType<typeof terminal>>

const savedDrafts = (d: DraftDaemon) => d.store.listSessions({ directory: PROJECT }).flatMap((session) => (d.store.drafts.get(session.sessionId) ? [session.sessionId] : []))

describe("an empty prompt is no draft", () => {
  test("nothing typed saves nothing and says nothing, in this terminal and the next", async () => {
    const d = boot()
    const first = await terminal(d)
    await first.h.app.saveDrafts()
    expect(first.h.sentOf("draft.set")).toEqual([])
    expect(savedDrafts(d)).toEqual([])
    const second = await terminal(d)
    expect(second.screen()).not.toContain("Unsent draft")
  })

  test("spaces and line breaks alone save no draft, and a draft they replace is removed", async () => {
    const d = boot()
    const t = await terminal(d)
    await t.h.type("   ")
    await t.h.app.saveDrafts()
    expect(savedDrafts(d)).toEqual([])
    await t.h.type("real words")
    await t.h.app.saveDrafts()
    expect(t.drafted()?.text).toBe("   real words")
    t.editor.clear()
    await t.h.type(" \n ")
    await t.h.app.saveDrafts()
    expect(t.drafted()).toBeUndefined()
    expect(savedDrafts(d)).toEqual([])
    const next = await terminal(d)
    expect(next.screen()).not.toContain("Unsent draft")
  })

  test("typing and deleting it all clears the draft at once", async () => {
    const d = boot()
    const t = await terminal(d)
    await t.h.type("abc")
    await t.h.app.saveDrafts()
    expect(t.drafted()?.text).toBe("abc")
    await t.h.type("\x7f\x7f\x7f")
    await Bun.sleep(5)
    expect(t.h.sentOf("draft.set").at(-1)).toMatchObject({ text: "" })
    expect(t.drafted()).toBeUndefined()
  })

  test("a blank draft an earlier version left is removed when its session opens, with nothing restored", async () => {
    const d = boot()
    const id = d.createSession()
    const t = await terminal(d, {
      sessionId: id,
    })
    // The daemon answers an old blank row: the terminal clears it instead of restoring it.
    const blank = appHarness({ dataDir: tempDir(), directory: PROJECT, sessionId: id, reply: (command) => command.type === "draft.get" ? { ok: true, result: { draft: { text: "  \n", attachments: [], updatedAt: 1 } } } : d.reply(command), width: 120, height: 30 })
    blank.app.applySettings({ onboarded: true })
    await Bun.sleep(30)
    expect(blank.sentOf("draft.set")).toEqual([expect.objectContaining({ sessionId: id, text: "" })])
    expect(blank.app.editor.text).toBe("")
    expect(t.editor.text).toBe("")
  })
})

describe("the notice says what the draft holds", () => {
  test("an attachment-only draft is 1 image, not 0 chars, with the chips above the prompt and with tokens", async () => {
    for (const chips of ["above", "inline"] as const) {
      const d = boot()
      const first = await terminal(d, { profile: { attachmentChips: chips } })
      await first.h.type(paste(SHOT))
      await first.h.app.saveDrafts()
      expect(first.drafted()?.attachments).toHaveLength(1)
      const second = await terminal(d)
      expect(second.screen()).toContain("Unsent draft saved (1 image) · ctrl+r restore")
      expect(second.screen()).not.toContain("0 chars")
      expect(second.screen()).not.toContain("11 chars")
    }
  })

  test("text with an attachment counts what was typed and names the attachment; tokens are not characters", async () => {
    const d = boot()
    const first = await terminal(d)
    await first.h.type("look at ")
    await first.h.type(paste(SHOT))
    await first.h.type("now")
    await first.h.app.saveDrafts()
    expect(first.drafted()?.text).toBe("look at [Image #1] now")
    const second = await terminal(d)
    expect(second.screen()).toContain("Unsent draft saved (12 chars, 1 image) · ctrl+r restore")
  })

  test("an image and a PDF are 2 attachments", async () => {
    const d = boot()
    const first = await terminal(d)
    await first.h.type(paste(SHOT))
    await first.h.type(paste(PDF))
    await first.h.app.saveDrafts()
    const second = await terminal(d)
    expect(second.screen()).toContain("Unsent draft saved (2 attachments) · ctrl+r restore")
  })

  test("the sizes read the same everywhere, and an older daemon's draft (no image count) still reads", () => {
    expect(draftSizeLabel({ chars: 41, attachments: 0, images: 0 })).toBe("41 chars")
    expect(draftSizeLabel({ chars: 1200, attachments: 1, images: 1 })).toBe("1.2k chars, 1 image")
    expect(draftSizeLabel({ chars: 0, attachments: 3, images: 3 })).toBe("3 images")
    expect(draftSizeLabel({ chars: 0, attachments: 2, images: 1 })).toBe("2 attachments")
    expect(attachmentsLabel({ attachments: 1, images: 0 })).toBe("1 attachment")
    const old = { sessionId: "s" as SessionId, title: "", chars: 0, attachments: 2, preview: "", updatedAt: 1 }
    expect(draftSize(old)).toBe("2 attachments")
    expect(unsentNotice([old], "^R")).toBe("Unsent draft saved (2 attachments) · ^R restore")
    expect(contentSize({ text: "look [Image #1]", images: [{ sha256: "a".repeat(64), bytes: 1, mime: "image/png", label: "[Image #1]" }] })).toEqual({ chars: 5, attachments: 1, images: 1 })
    expect(contentSize({ text: "[Image #1] ", images: [{ sha256: "a".repeat(64), bytes: 1, mime: "image/png", label: "[Image #1]" }] })).toEqual({ chars: 0, attachments: 1, images: 1 })
  })

  test("the restore key in the notice is worded by the key-label system, from the binding in use", async () => {
    const d = boot()
    const first = await terminal(d)
    await first.h.type("a draft that is long enough")
    await first.h.app.saveDrafts()
    const dataDir = tempDir()
    writeTuiProfile(dataDir, DEFAULT_TUI_PROFILE)
    const mac = appHarness({ dataDir, directory: PROJECT, sessionId: d.createSession(), reply: d.reply, width: 120, height: 30, platform: "darwin" })
    mac.app.applySettings({ onboarded: true })
    await Bun.sleep(30)
    mac.app.render()
    expect(mac.text().join("\n")).toContain("Unsent draft saved (27 chars) · ctrl+r restore")
  })
})

describe("a session with only a draft is a draft in the left list", () => {
  test("it reads Draft · the first words, an attachment-only one Draft · 1 image, and a blank session is not listed", async () => {
    const d = boot()
    const typed = d.createSession()
    const shot = d.createSession()
    d.createSession()
    d.store.drafts.set(typed, "\n  fix the retry loop\nin the sync worker")
    d.store.drafts.set(shot, "[Image #1] ", [{ sha256: "1".repeat(64), bytes: 9, mime: "image/png", name: "one.png", label: "[Image #1]" }])
    const t = await terminal(d)
    const rows = t.sidebar().join("\n")
    expect(rows).toContain("Draft · fix the retry loop")
    expect(rows).toContain("Draft · 1 image")
    expect(rows).not.toContain("Untitled session")
    expect(rows).not.toContain("0 chars")
  })

  test("a titled session keeps its title, and one with neither title nor draft keeps the placeholder", () => {
    const base = { sessionId: "s" as SessionId, directory: PROJECT, createdAt: 1, updatedAt: 1, lastSeq: 0, state: "idle", queued: 0 } as const
    const draft: SessionDraft = { preview: "half a thought", chars: 14, attachments: 0, images: 0, updatedAt: 5 }
    expect(labelString(sessionLabel({ title: "Fix retries", draft }, { untitled: "Untitled session", marker: "Draft" }))).toBe("Fix retries")
    expect(labelString(sessionLabel({ title: "  ", draft }, { untitled: "Untitled session", marker: "Draft" }))).toBe("Draft · half a thought")
    expect(sessionLabel({ title: "" }, { untitled: "Untitled session", marker: "Draft" })).toEqual({ text: "Untitled session", placeholder: true })
    const rows = renderSessionSidebar({ sessions: [{ ...base, title: "", draft } as SessionSummary, { ...base, sessionId: "t" as SessionId, title: "" } as SessionSummary], current: "none", focused: false, height: 20, now: NOW })
    const text = rows.rows.map((row) => row.map((span) => span.text).join(""))
    expect(text.join("\n")).toContain("Draft · half a thought")
    expect(text.join("\n")).toContain("Untitled session")
  })

  test("the marker is muted, the words are the row's, and the words give way when the row is narrow", () => {
    const base = { sessionId: "s" as SessionId, directory: PROJECT, createdAt: 1, updatedAt: 1, lastSeq: 0, state: "idle", queued: 0 } as const
    const draft: SessionDraft = { preview: "a first line that is much too long for a thirty column sidebar", chars: 70, attachments: 0, images: 0, updatedAt: 5 }
    const out = renderSessionSidebar({ sessions: [{ ...base, title: "", draft } as SessionSummary], current: "s", focused: false, height: 12, now: NOW })
    const row = out.rows.find((line) => line.some((span) => span.text.startsWith("Draft")))!
    expect(row.find((span) => span.text === "Draft · ")?.fg).toBe("muted")
    const words = row.find((span) => span.text.startsWith("a first line"))!
    expect(words.fg).toBe("text")
    expect(words.text.endsWith("…")).toBe(true)
    expect(row.map((span) => span.text).join("").length).toBeLessThanOrEqual(SIDEBAR_WIDTH)
  })

  test("the time is that of the draft when it is newer than the session, and the list orders by it", () => {
    const base = { directory: PROJECT, createdAt: 1, lastSeq: 0, state: "idle", queued: 0, title: "" } as const
    const older = { ...base, sessionId: "a" as SessionId, updatedAt: NOW - 3_600_000 } as SessionSummary
    const typedLately = { ...base, sessionId: "b" as SessionId, updatedAt: NOW - 7_200_000, draft: { preview: "x", chars: 1, attachments: 0, images: 0, updatedAt: NOW - 60_000 } } as SessionSummary
    expect(sessionActivityAt(typedLately)).toBe(NOW - 60_000)
    expect(sessionActivityAt(older)).toBe(NOW - 3_600_000)
    const out = renderSessionSidebar({ sessions: [older, typedLately], current: "none", focused: false, height: 20, now: NOW })
    expect(out.rows.map((row) => row.map((span) => span.text).join("")).join("\n")).toContain("1m ago")
  })
})

describe("opening a session with a draft puts the draft in the prompt", () => {
  test("text with the cursor at its end, with no notice, and nothing is written back", async () => {
    const d = boot()
    const other = d.createSession()
    d.store.drafts.set(other, "fix the retry loop")
    const t = await terminal(d)
    await t.click("Draft · fix the retry loop")
    expect(t.h.app.sessionId).toBe(other)
    expect(t.editor.text).toBe("fix the retry loop")
    expect(t.editor.cursor).toEqual({ row: 0, col: "fix the retry loop".length })
    expect(t.screen()).toContain("fix the retry loop")
    expect(t.screen()).not.toMatch(/restor/i)
    expect(t.h.sentOf("draft.set").filter((command) => (command as { sessionId: string }).sessionId === other)).toEqual([])
  })

  test("attachment tokens come back with their attachments, and the message is sent with them in place", async () => {
    const d = boot()
    const other = d.createSession()
    d.store.drafts.set(other, "see [Image #1] please", [{ sha256: "1".repeat(64), bytes: 315187, mime: "image/png", name: "one.png", label: "[Image #1]", at: 14 }])
    const t = await terminal(d)
    await t.click("Draft · see please")
    expect(t.editor.text).toBe("see [Image #1] please")
    await t.h.type("\r")
    expect(t.h.sentOf("user.submit")[0]).toMatchObject({ text: "see [Image #1] please", attachments: [expect.objectContaining({ label: "[Image #1]" })] })
  })

  test("an attachment-only draft comes back as its token", async () => {
    const d = boot()
    const other = d.createSession()
    d.store.drafts.set(other, "[Image #1] ", [{ sha256: "1".repeat(64), bytes: 9, mime: "image/png", name: "one.png", label: "[Image #1]", at: 10 }])
    const t = await terminal(d)
    await t.click("Draft · 1 image")
    expect(t.editor.text).toBe("[Image #1] ")
    await t.h.type("\r")
    expect(t.h.sentOf("user.submit")[0]).toMatchObject({ attachments: [expect.objectContaining({ sha256: "1".repeat(64), label: "[Image #1]" })] })
  })

  test("what was typed in the session being left becomes that session's draft and is not carried over", async () => {
    const d = boot()
    const other = d.createSession()
    d.store.drafts.set(other, "the draft already there")
    const t = await terminal(d)
    await t.h.type("typed here first")
    await t.click("Draft · the draft already there")
    expect(t.editor.text).toBe("the draft already there")
    expect(d.store.drafts.get(t.sessionId)?.text).toBe("typed here first")
    expect(d.store.drafts.get(other)?.text).toBe("the draft already there")
    await t.h.app.saveDrafts()
    expect(d.store.drafts.get(other)?.text).toBe("the draft already there")
    expect(d.store.drafts.get(t.sessionId)?.text).toBe("typed here first")
    // And back: the first session's prompt is its own again.
    await t.click("Draft · typed here first")
    expect(t.editor.text).toBe("typed here first")
    expect(d.store.drafts.get(other)?.text).toBe("the draft already there")
  })

  test("a session without a draft opens with an empty prompt, not with the one just left", async () => {
    const d = boot()
    const titled = d.createSession("An earlier chat")
    const t = await terminal(d)
    await t.h.type("half typed")
    await t.click("An earlier chat")
    expect(t.h.app.sessionId).toBe(titled)
    expect(t.editor.text).toBe("")
    expect(d.store.drafts.get(t.sessionId)?.text).toBe("half typed")
  })

  test("a prompt that already has text is kept as it is, and the draft waits in the stash with a notice", async () => {
    const d = boot()
    const other = d.createSession()
    d.store.drafts.set(other, "the saved draft")
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => (release = resolve))
    const dataDir = tempDir()
    writeTuiProfile(dataDir, DEFAULT_TUI_PROFILE)
    const h = appHarness({ dataDir, directory: PROJECT, sessionId: other, reply: (command) => command.type === "draft.get" ? gate.then(() => d.reply(command)!) : d.reply(command), width: 120, height: 30 })
    h.app.applySettings({ onboarded: true })
    await Bun.sleep(10)
    // Typed while the draft was still on its way.
    await h.type("typed meanwhile")
    release()
    await Bun.sleep(30)
    h.app.render()
    expect(h.app.editor.text).toBe("typed meanwhile")
    expect(h.text().join("\n")).toContain("Unsent draft kept in the stash (15 chars) · ctrl+x o restore")
    await h.type("\x18o")
    expect(h.app.editor.text).toBe("the saved draft")
  })
})

describe("the label follows the draft", () => {
  test("typing in an untitled session makes it a draft in every terminal, deleting the text makes it go", async () => {
    const d = boot()
    const writer = await terminal(d)
    const watcher = await terminal(d)
    await writer.h.type("write the notes")
    await writer.h.app.saveDrafts()
    await Bun.sleep(10)
    writer.h.app.render()
    watcher.h.app.render()
    expect(writer.sidebar().join("\n")).toContain("Draft · write the notes")
    expect(watcher.sidebar().join("\n")).toContain("Draft · write the notes")
    writer.editor.clear()
    await writer.h.type("")
    await writer.h.app.saveDrafts()
    await Bun.sleep(10)
    watcher.h.app.render()
    expect(watcher.sidebar().join("\n")).not.toContain("write the notes")
    expect(watcher.sidebar().join("\n")).not.toContain("Draft ·")
  })

  test("sending the message clears the draft and the row becomes the title", async () => {
    const d = boot()
    const t = await terminal(d)
    await t.h.type("ship the release notes")
    await t.h.app.saveDrafts()
    await Bun.sleep(10)
    t.h.app.render()
    expect(t.sidebar().join("\n")).toContain("Draft · ship the release notes")
    await t.h.type("\r")
    await Bun.sleep(20)
    t.h.app.render()
    expect(d.store.drafts.get(t.sessionId)).toBeUndefined()
    const rows = t.sidebar().join("\n")
    expect(rows).toContain("ship the release notes")
    expect(rows).not.toContain("Draft ·")
  })

  test("a second client that starts later reads the same label from the list", async () => {
    const d = boot()
    const writer = await terminal(d)
    await writer.h.type("shared words")
    await writer.h.app.saveDrafts()
    const late = await terminal(d)
    expect(late.sidebar().join("\n")).toContain("Draft · shared words")
  })

  test("a push without a draft field leaves the label as it was (an older daemon, or an ordinary state change)", async () => {
    const d = boot()
    const other = d.createSession()
    d.store.drafts.set(other, "kept words")
    const t = await terminal(d)
    t.h.app.onGlobal({ type: "session.activity", gseq: 0, at: NOW, sessionId: other, directory: PROJECT, title: "", state: "generating", updatedAt: NOW } as never)
    t.h.app.render()
    expect(t.sidebar().join("\n")).toContain("Draft · kept words")
    const listed = withPushedDraft({ sessionId: other, title: "", directory: PROJECT, createdAt: 1, updatedAt: 1, lastSeq: 0, state: "idle", queued: 0, draft: { preview: "x", chars: 1, attachments: 0, images: 0, updatedAt: 1 } } as SessionSummary, null)
    expect("draft" in listed).toBe(false)
  })
})

describe("the other places a session is named", () => {
  test("/sessions leaves a draft-only session out (/drafts has it); the row and query helpers still read it as draft · words", async () => {
    const d = boot()
    const other = d.createSession()
    d.store.drafts.set(other, "port the importer")
    const t = await terminal(d)
    await t.h.type("/sessions")
    await t.h.type("\r")
    await Bun.sleep(20)
    t.h.app.render()
    expect(t.screen()).not.toContain("port the importer")
    expect(t.screen()).not.toContain("untitled")
    const listed = d.reply({ type: "session.list", directory: PROJECT } as never) as unknown as { result: { sessions: SessionSummary[] } }
    const session = listed.result.sessions.find((entry) => entry.sessionId === other)!
    expect(matchesQuery(session, parseSessionQuery("importer"))).toBe(true)
    expect(matchesQuery(session, parseSessionQuery("draft"))).toBe(true)
    expect(matchesQuery(session, parseSessionQuery("unrelated"))).toBe(false)
    expect(selectSessions([session], "", {})).toEqual([])
    expect(selectSessions([{ ...session, title: "Port the importer" }], "", {})).toHaveLength(1)
  })

  test("the top bar and the terminal title say Draft · words for the untitled session being typed in", async () => {
    const d = boot()
    const t = await terminal(d)
    await t.h.type("review the diff")
    await t.h.app.saveDrafts()
    await Bun.sleep(10)
    t.h.app.render()
    expect(t.h.titles.at(-1)).toBe("MendCode | Draft · review the diff")
  })

  test("the top bar's title is the session's own when it has one, else the draft, else nothing", () => {
    const summary = (title: string, draft?: SessionDraft) => ({ sessionId: "s", title, directory: PROJECT, createdAt: 1, updatedAt: 1, lastSeq: 0, state: "idle", queued: 0, ...(draft ? { draft } : {}) }) as SessionSummary
    const state = (...sessions: SessionSummary[]) => ({ sessionId: "s", sessions, paletteSessions: [] }) as never
    const draft: SessionDraft = { preview: "review the diff", chars: 15, attachments: 0, images: 0, updatedAt: 2 }
    expect(sessionDisplayTitle(state(summary("", draft)), "")).toBe("Draft · review the diff")
    expect(sessionDisplayTitle(state(summary("Named", draft)), "Named")).toBe("Named")
    expect(sessionDisplayTitle(state(summary("")), "")).toBe("")
    expect(sessionDisplayTitle(state(), "")).toBe("")
    expect(sessionDisplayTitle(state(summary("", { ...draft, preview: "", attachments: 2, images: 2 })), "")).toBe("Draft · 2 images")
  })

  test("the palette, @thread and the session list command name it the same way", () => {
    const row = { sessionId: "ses_abcdefgh12345678" as SessionId, title: "", directory: PROJECT, createdAt: 1, updatedAt: 1, lastSeq: 0, state: "idle", queued: 0, draft: { preview: "port the importer", chars: 17, attachments: 0, images: 0, updatedAt: 2 } } as SessionSummary
    expect(threadMentions([row], "thread:", undefined)[0]?.description).toBe("draft · port the importer")
    expect(sessionRows([row], NOW, false)).toContain("draft · port the importer")
    expect(sessionRows([{ ...row, draft: undefined } as SessionSummary], NOW, false)).toContain("untitled")
  })
})

describe("the budget", () => {
  test("1,000 sessions with drafts draw and sort as fast as 1,000 without", () => {
    const sessions = Array.from({ length: 1_000 }, (_, index): SessionSummary => ({ sessionId: `ses_${index}` as SessionId, title: index % 3 === 0 ? `Chat ${index}` : "", directory: PROJECT, createdAt: index, updatedAt: NOW - index * 1_000, lastSeq: 0, state: "idle", queued: 0, ...(index % 3 !== 0 ? { draft: { preview: `draft number ${index} with some words`, chars: 30, attachments: 0, images: 0, updatedAt: NOW - index * 500 } } : {}) }) as SessionSummary)
    const bare = sessions.map(({ draft: _draft, ...rest }) => rest as SessionSummary)
    const time = (list: SessionSummary[]) => {
      const start = performance.now()
      for (let round = 0; round < 5; round++) renderSessionList({ sessions: list, state: createSessionListState(), currentSessionId: "ses_5", width: 100, height: 40, now: NOW, glyphs: glyphs({}) })
      return performance.now() - start
    }
    time(sessions)
    time(bare)
    const withDrafts = Math.min(time(sessions), time(sessions))
    const without = Math.min(time(bare), time(bare))
    expect(withDrafts).toBeLessThan(without * 2 + 25)
  })
})
