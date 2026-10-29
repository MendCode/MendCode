import { afterEach, describe, expect, test } from "bun:test"
import type { CommandInput, CommandReply } from "@mendcode/client"
import { appHarness, cleanTemps, tempDir } from "./session-ui-harness"
import { DEFAULT_TUI_PROFILE, writeTuiProfile } from "../src/view/tui-profile"
import { unsentNotice, charsLabel } from "../src/ui/drafts"
import { CUSTOMIZE_ROWS, customizePageKey } from "../src/view/customize-page"

afterEach(cleanTemps)

const DIRECTORY = "/repo"

/** A daemon that outlives the terminals: drafts and prompt history are kept here while harnesses come and go. */
function daemon() {
  const drafts = new Map<string, { text: string; at: number }>()
  const history: string[] = []
  let at = 1_000
  const reply = (command: CommandInput): CommandReply | undefined => {
    if (command.type === "draft.set") {
      if (command.text) drafts.set(command.sessionId, { text: command.text, at: at++ })
      else drafts.delete(command.sessionId)
      return { ok: true }
    }
    if (command.type === "draft.get") {
      const draft = drafts.get(command.sessionId)
      return { ok: true, result: draft ? { draft: { text: draft.text, attachments: [], updatedAt: draft.at } } : {} }
    }
    if (command.type === "draft.list") {
      const listed = [...drafts].filter(([id]) => id !== command.excludeSessionId).map(([sessionId, draft]) => ({ sessionId, title: "", chars: draft.text.length, attachments: 0, preview: draft.text.replace(/\s+/g, " ").slice(0, 160), updatedAt: draft.at }))
      return { ok: true, result: { drafts: listed.sort((a, b) => b.updatedAt - a.updatedAt) } }
    }
    if (command.type === "user.submit") history.unshift(command.text)
    if (command.type === "prompt.history") return { ok: true, result: { prompts: [...new Set(history)] } }
    return undefined
  }
  return { drafts, history, reply }
}

/** A terminal on the shared daemon: the same data dir and project, a new session each time. */
async function terminal(shared: ReturnType<typeof daemon>, dataDir: string, profile: Partial<typeof DEFAULT_TUI_PROFILE> = {}) {
  writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, ...profile })
  const h = appHarness({ dataDir, directory: DIRECTORY, reply: shared.reply, width: 110, height: 30 })
  h.app.applySettings({ onboarded: true })
  await Bun.sleep(15)
  h.app.render()
  return h
}

const screen = (h: Awaited<ReturnType<typeof terminal>>) => h.text().join("\n")

describe("unsent drafts across terminals", () => {
  test("text typed before the terminal closed is offered on the next start and ctrl+r restores it", async () => {
    const shared = daemon()
    const dataDir = tempDir()
    const first = await terminal(shared, dataDir)
    await first.type("remember to rotate the keys before friday")
    // Closed mid-typing: the debounce has not fired; what the terminal does on SIGHUP is wait for the save.
    expect(shared.drafts.size).toBe(0)
    await first.app.saveDrafts()
    expect(shared.drafts.get(first.sessionId)?.text).toBe("remember to rotate the keys before friday")

    const second = await terminal(shared, dataDir)
    expect(screen(second)).toContain("Unsent draft saved (41 chars) · ctrl+r restore")
    expect(second.text().join("\n")).not.toContain("remember to rotate")
    await second.type("\x12")
    expect(screen(second)).toContain("remember to rotate the keys before friday")
    // The draft moved: the new session holds it, the old one is clear, and there is nothing left to restore.
    expect(shared.drafts.has(first.sessionId)).toBe(false)
    await second.app.saveDrafts()
    expect(shared.drafts.get(second.sessionId)?.text).toBe("remember to rotate the keys before friday")
    await second.type("\x12")
    expect(screen(second)).toContain("no unsent drafts")
  })

  test("a draft is saved after the typing pause with no help from the terminal closing", async () => {
    const shared = daemon()
    const h = await terminal(shared, tempDir())
    await h.type("saved by the timer")
    expect(shared.drafts.size).toBe(0)
    await Bun.sleep(480)
    expect(shared.drafts.get(h.sessionId)?.text).toBe("saved by the timer")
  })

  test("no notice when nothing was left unsent, and the session's own draft does not count", async () => {
    const shared = daemon()
    const dataDir = tempDir()
    const clean = await terminal(shared, dataDir)
    expect(screen(clean)).not.toContain("Unsent draft")
    await clean.type("typed here")
    await clean.app.saveDrafts()
    // Another terminal in another project sees none of it either.
    const elsewhere = appHarness({ dataDir, directory: "/other", reply: (command) => command.type === "draft.list" ? { ok: true, result: { drafts: [] } } : shared.reply(command) })
    elsewhere.app.applySettings({ onboarded: true })
    await Bun.sleep(15)
    elsewhere.app.render()
    expect(elsewhere.text().join("\n")).not.toContain("Unsent draft")
  })

  test("restoring over a prompt being typed parks that prompt in the stash instead of losing it", async () => {
    const shared = daemon()
    const dataDir = tempDir()
    const first = await terminal(shared, dataDir)
    await first.type("the old draft")
    await first.app.saveDrafts()
    const second = await terminal(shared, dataDir)
    await second.type("something else already typed")
    await second.type("\x12")
    expect(screen(second)).toContain("the old draft")
    expect(screen(second)).toContain("the prompt you had is in /stash")
    await second.type("\x03")
    await second.type("/stash")
    await second.type("\r")
    expect(screen(second)).toContain("something else already typed")
  })

  test("a large paste is saved at once and survives, and one over the limit is kept truncated with a notice", async () => {
    const shared = daemon()
    const h = await terminal(shared, tempDir())
    const paste = "line of a log file\n".repeat(400)
    await h.app.onInput(`\x1b[200~${paste}\x1b[201~`)
    await Bun.sleep(5)
    expect(shared.drafts.get(h.sessionId)?.text.length).toBe(paste.replace(/\r\n?/g, "\n").length)
    const huge = "x".repeat(70_000)
    await h.app.onInput(`\x1b[200~${huge}\x1b[201~`)
    await Bun.sleep(5)
    h.app.render()
    expect(h.sentOf("draft.set").at(-1)!.text.length).toBe(65_536)
    expect(screen(h)).toContain("draft over 64 KB: saved truncated")
  })

  test("a paste that makes the prompt over 64 KB goes as a text attachment under its label, in pieces when long, and the prompt is sent", async () => {
    const shared = daemon()
    const puts: Array<{ name: string; bytes: number; part?: { index: number; last: boolean } }> = []
    const h = await terminal({ ...shared, reply: (command) => {
      if (command.type !== "attachment.put") return shared.reply(command)
      puts.push({ name: command.name, bytes: Buffer.from(command.data, "base64").length, ...(command.part ? { part: { index: command.part.index, last: command.part.last } } : {}) })
      return command.part && !command.part.last ? { ok: true, result: { received: 1 } } : { ok: true, result: { attachment: { sha256: "a".repeat(64), bytes: 300_000, mime: "text/plain" }, name: command.name } }
    } }, tempDir())
    await h.type("read this: ")
    const long = "a long transcript line\n".repeat(13_100)
    await h.app.onInput(`\x1b[200~${long}\x1b[201~`)
    await h.app.onKey("\r")
    // 301,300 bytes: three pieces of at most 140,000, in order, the last one marked.
    expect(puts.map((put) => [put.name, put.bytes, put.part?.index, put.part?.last])).toEqual([["paste-1.txt", 140_000, 0, false], ["paste-1.txt", 140_000, 1, false], ["paste-1.txt", 21_300, 2, true]])
    const sent = h.sentOf("user.submit").at(-1) as { text: string; attachments: Array<{ mime: string; label?: string; at?: number }> }
    expect(sent.text).toBe("read this: [Pasted Content 301300 chars]")
    expect(sent.attachments).toEqual([expect.objectContaining({ mime: "text/plain", label: "[Pasted Content 301300 chars]", at: sent.text.length })])
  })

  test("a submitted prompt is in the history of the next terminal", async () => {
    const shared = daemon()
    const dataDir = tempDir()
    const first = await terminal(shared, dataDir)
    await first.type("deploy the staging build")
    await first.app.onKey("\r")
    await Bun.sleep(10)
    const second = await terminal(shared, dataDir)
    await second.app.onKey("\x1b[A")
    await Bun.sleep(10)
    second.app.render()
    expect(screen(second)).toContain("deploy the staging build")
    expect(second.sentOf("prompt.history")[0]).toMatchObject({ directory: DIRECTORY })
  })
})

describe("/drafts", () => {
  test("lists unsent drafts with a preview, restores one with enter and deletes one with ctrl-d twice", async () => {
    const shared = daemon()
    const dataDir = tempDir()
    const a = await terminal(shared, dataDir)
    await a.type("first idea about retries")
    await a.app.saveDrafts()
    const b = await terminal(shared, dataDir)
    await b.type("second idea about caching with a longer text")
    await b.app.saveDrafts()
    const now = await terminal(shared, dataDir)
    expect(screen(now)).toContain("2 unsent drafts saved")

    await now.type("/drafts")
    await now.type("\r")
    const listed = screen(now)
    expect(listed).toContain("Unsent drafts")
    expect(listed).toContain("second idea about caching")
    expect(listed).toContain("first idea about retries")
    expect(listed.indexOf("second idea")).toBeLessThan(listed.indexOf("first idea"))

    await now.type("\x1b[B")
    await now.type("\x04")
    expect(screen(now)).toContain("ctrl-d confirm delete")
    await now.type("\x04")
    expect(shared.drafts.has(a.sessionId)).toBe(false)
    expect(screen(now)).not.toContain("first idea about retries")

    await now.type("\r")
    expect(screen(now)).toContain("second idea about caching with a longer text")
    expect(shared.drafts.has(b.sessionId)).toBe(false)
  })
})

describe("draft retention", () => {
  test("the start asks the daemon to prune drafts older than the setting, and 0 keeps them", async () => {
    const dataDir = tempDir()
    const shared = daemon()
    const kept = await terminal(shared, dataDir)
    expect(kept.sentOf("draft.list")[0]).toMatchObject({ directory: DIRECTORY, maxAgeDays: 14 })
    const custom = await terminal(shared, dataDir, { draftRetentionDays: 3 })
    expect(custom.sentOf("draft.list")[0]).toMatchObject({ maxAgeDays: 3 })
    const forever = await terminal(shared, dataDir, { draftRetentionDays: 0 })
    expect(forever.sentOf("draft.list")[0]).not.toHaveProperty("maxAgeDays")
  })
})

describe("/customize rows", () => {
  const rowState = (row: string) => ({ row: CUSTOMIZE_ROWS.indexOf(row as never) })
  test("copy on select toggles and draft retention takes a whole number of days", () => {
    expect(DEFAULT_TUI_PROFILE.copyOnSelect).toBe(true)
    expect(DEFAULT_TUI_PROFILE.draftRetentionDays).toBe(14)
    const toggled = customizePageKey(rowState("copyOnSelect"), " ", DEFAULT_TUI_PROFILE)
    expect(toggled.action).toEqual({ type: "set", patch: { copyOnSelect: false } })
    let state = customizePageKey(rowState("draftRetentionDays"), "\r", DEFAULT_TUI_PROFILE).state
    expect(state.typing).toBe("14")
    state = customizePageKey({ ...state, typing: "" }, "x", DEFAULT_TUI_PROFILE).state
    expect(customizePageKey(state, "\r", DEFAULT_TUI_PROFILE).state.error).toContain("0..3650")
    expect(customizePageKey({ ...state, typing: "7" }, "\r", DEFAULT_TUI_PROFILE).action).toEqual({ type: "set", patch: { draftRetentionDays: 7 } })
    expect(customizePageKey({ ...state, typing: "0" }, "\r", DEFAULT_TUI_PROFILE).action).toEqual({ type: "set", patch: { draftRetentionDays: 0 } })
    expect(customizePageKey({ ...state, typing: "4000" }, "\r", DEFAULT_TUI_PROFILE).state.error).toContain("0..3650")
  })
})

describe("notice text", () => {
  test("says how much was kept and how to get it back", () => {
    const draft = { sessionId: "s" as never, title: "", chars: 1200, attachments: 0, preview: "", updatedAt: 1 }
    expect(charsLabel(1200)).toBe("1.2k chars")
    expect(charsLabel(2000)).toBe("2k chars")
    expect(charsLabel(340)).toBe("340 chars")
    expect(unsentNotice([], "ctrl+r")).toBeUndefined()
    expect(unsentNotice([draft], "ctrl+r")).toBe("Unsent draft saved (1.2k chars) · ctrl+r restore")
    expect(unsentNotice([draft, draft], "ctrl+r")).toBe("2 unsent drafts saved · ctrl+r restores the newest · /drafts lists them")
  })
})
