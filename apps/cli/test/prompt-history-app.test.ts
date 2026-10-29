import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { CommandInput, CommandReply } from "@mendcode/client"
import { openStore, type Store } from "@mendcode/store"
import { promptSearchBar, worthKeeping } from "../src/view/prompt-search"
import { appHarness, cleanTemps, ids, tempDir } from "./session-ui-harness"

const stores: Store[] = []
const dirs: string[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  cleanTemps()
})

const DIRECTORY = "/repo"
const ESC = "\x1b"
const UP = "\x1b[A"
const DOWN = "\x1b[B"
const LONG = "a long draft nobody should lose"

/**
 * The daemon's prompt history on a real store: a sent message or shell line is recorded when it is queued, `prompt.record`
 * adds what the terminal ran itself. A second terminal on the same data dir is a restart.
 */
function daemon(dir = mkdtempSync(path.join(tmpdir(), "mendcode-history-app-"))) {
  if (!dirs.includes(dir)) dirs.push(dir)
  // A restart: the earlier process lets go of the data dir first.
  for (const open of stores.splice(0)) open.close()
  const store = openStore({ dir })
  stores.push(store)
  const sessionId = store.listSessions({})[0]?.sessionId ?? (() => {
    const id = ids("session")
    store.createSession({ id, directory: DIRECTORY, title: "" })
    return id
  })()
  const reply = (command: CommandInput): CommandReply | undefined => {
    if (command.type === "user.submit") store.sessionSink.append({ type: "queue.added", sessionId, queueId: ids("queue"), text: command.text, attachments: [] })
    else if (command.type === "user.shell") store.sessionSink.append({ type: "queue.added", sessionId, queueId: ids("queue"), text: command.command, attachments: [], shell: true, ...(command.local ? { local: true as const } : {}) })
    else if (command.type === "prompt.history") {
      const entries = store.promptEntries(command.directory, command.limit)
      return { ok: true, result: { prompts: entries.map((entry) => entry.text), entries } }
    } else if (command.type === "prompt.record") return { ok: true, result: { kept: store.recordPrompt(command.sessionId, command.text, command.kind) } }
    else if (command.type === "prompt.history.delete") return { ok: true, result: { removed: command.entryId !== undefined ? Number(store.removePrompt(command.directory, command.entryId)) : store.clearPromptDrafts(command.directory) } }
    return undefined
  }
  return { store, sessionId, dir, reply }
}

async function terminal(shared: ReturnType<typeof daemon>, options: { remote?: boolean } = {}) {
  const h = appHarness({ dataDir: tempDir(), directory: DIRECTORY, sessionId: shared.sessionId, reply: shared.reply, width: 110, height: 30, ...(options.remote ? { remote: { host: "test.invalid", readOnly: false } } : {}) })
  h.app.applySettings({ onboarded: true })
  await Bun.sleep(10)
  return h
}
type Terminal = Awaited<ReturnType<typeof terminal>>

/** What ↑ shows from an empty prompt, one entry per press, until the list ends. */
async function recalled(h: Terminal, count: number) {
  const seen: string[] = []
  for (let i = 0; i < count; i++) {
    await h.type(UP)
    seen.push(h.app.editor.text)
  }
  return seen
}
const entries = (shared: ReturnType<typeof daemon>) => shared.store.promptEntries(DIRECTORY).map(({ kind, text }) => [kind, text])
const screen = (h: Terminal) => h.text().join("\n")
const inShell = (h: Terminal) => screen(h).includes("esc exit shell mode")

describe("↑ recalls everything entered in the prompt", () => {
  test("a message, a slash command with arguments, a shell line and a /btw question come back newest first after a restart", async () => {
    const shared = daemon()
    const first = await terminal(shared)
    await first.type("fix the flaky test\r")
    await first.type("/panel next\r")
    await first.type("/btw what is the cache key\r")
    await first.type(ESC)
    await first.type("!")
    await first.type("ls -la\r")
    expect(entries(shared)).toEqual([["shell", "ls -la"], ["command", "/btw what is the cache key"], ["command", "/panel next"], ["sent", "fix the flaky test"]])

    const second = await terminal(daemon(shared.dir))
    expect(await recalled(second, 4)).toEqual(["ls -la", "/btw what is the cache key", "/panel next", "fix the flaky test"])
  })

  test("a recalled shell line goes back into shell mode and a recalled message leaves it", async () => {
    const shared = daemon()
    const first = await terminal(shared)
    await first.type("explain the build\r")
    await first.type("!")
    await first.type("git status\r")
    await first.type("!")
    await first.type("!echo local only\r")
    expect(entries(shared).map(([, text]) => text)).toEqual(["!echo local only", "git status", "explain the build"])

    const second = await terminal(daemon(shared.dir))
    await second.type(UP)
    expect(second.app.editor.text).toBe("!echo local only")
    expect(inShell(second)).toBe(true)
    await second.type(UP)
    expect(second.app.editor.text).toBe("git status")
    expect(inShell(second)).toBe(true)
    await second.type(UP)
    expect(second.app.editor.text).toBe("explain the build")
    expect(inShell(second)).toBe(false)
    await second.type(DOWN)
    expect(inShell(second)).toBe(true)
    await second.type(DOWN)
    await second.type(DOWN)
    expect(second.app.editor.text).toBe("")
    expect(inShell(second)).toBe(false)
    // Sent from shell mode, a recalled line runs again as a shell command.
    await second.type(UP)
    await second.type(UP)
    await second.type("\r")
    expect(second.sentOf("user.shell")).toHaveLength(1)
    expect(second.sentOf("user.shell")[0]).toMatchObject({ command: "git status" })
  })

  test("a command completed from the slash menu is recorded, and so is one picked with enter", async () => {
    const shared = daemon()
    const h = await terminal(shared)
    await h.type("/mod")
    await h.type("\t")
    expect(h.app.editor.text.startsWith("/model")).toBe(true)
    await h.type("\r")
    await h.type(ESC)
    await h.type("/sessio")
    await h.type("\r")
    await h.type(ESC)
    expect(entries(shared).map(([, text]) => text)).toContain("/model")
    expect(entries(shared).map(([, text]) => text)).toContain("/sessions")
  })

  test("a connect line with a key is never kept", async () => {
    const shared = daemon()
    const h = await terminal(shared)
    await h.type("/connect openai\r")
    expect(entries(shared)).toEqual([])
  })

  test("a text sent again moves to the top instead of repeating", async () => {
    const shared = daemon()
    const h = await terminal(shared)
    await h.type("first message\r")
    await h.type("second message\r")
    await h.type(UP)
    await h.type(UP)
    expect(h.app.editor.text).toBe("first message")
    await h.type("\r")
    expect(entries(shared)).toEqual([["sent", "first message"], ["sent", "second message"]])
    await h.type(UP)
    expect(h.app.editor.text).toBe("first message")
    await h.type(UP)
    expect(h.app.editor.text).toBe("second message")
  })
})

describe("a discarded draft is not lost", () => {
  test("ctrl+c, ctrl+u and a select-all delete keep text of 12 characters or more, and say so once", async () => {
    const shared = daemon()
    const h = await terminal(shared)
    await h.type(LONG)
    await h.type("\x03")
    await Bun.sleep(5)
    expect(entries(shared)).toEqual([["draft", LONG]])
    h.app.render()
    // Kept without a word: success is silent (the `confirmNotices` profile key says it again).
    expect(screen(h)).not.toContain("draft saved")
    await h.type("another draft written line")
    await h.type("\x15")
    await Bun.sleep(5)
    expect(entries(shared)).toEqual([["draft", "another draft written line"], ["draft", LONG]])
    const second = await terminal(daemon(shared.dir))
    expect(await recalled(second, 2)).toEqual(["another draft written line", LONG])
  })

  test("tiny text is not kept, nor announced", async () => {
    const shared = daemon()
    const h = await terminal(shared)
    await h.type("short one")
    await h.type("\x03")
    await Bun.sleep(5)
    expect(entries(shared)).toEqual([])
    h.app.render()
    expect(screen(h)).not.toContain("draft saved")
    expect(worthKeeping("eleven char")).toBe(false)
    expect(worthKeeping("twelve chars")).toBe(true)
    expect(worthKeeping("a\nb")).toBe(true)
    expect(worthKeeping("  a  \n")).toBe(false)
  })

  test("a multi-line draft is kept whole even when short", async () => {
    const shared = daemon()
    const h = await terminal(shared)
    h.app.editor.replaceAll("a\nb")
    await h.type("\x03")
    await Bun.sleep(5)
    expect(entries(shared)).toEqual([["draft", "a\nb"]])
  })

  test("recalling a draft shows the muted draft hint, and sending it unchanged moves it to the top as a sent message", async () => {
    const shared = daemon()
    const h = await terminal(shared)
    await h.type("an earlier sent message\r")
    await h.type(LONG)
    await h.type("\x03")
    await Bun.sleep(5)
    await h.type(UP)
    expect(h.app.editor.text).toBe(LONG)
    expect(screen(h)).toContain("draft · not sent")
    await h.type("\r")
    expect(entries(shared)).toEqual([["sent", LONG], ["sent", "an earlier sent message"]])
  })

  test("the same draft cleared twice in a row is stored once", async () => {
    const shared = daemon()
    const h = await terminal(shared)
    for (let i = 0; i < 2; i++) {
      await h.type(LONG)
      await h.type("\x03")
      await Bun.sleep(5)
    }
    expect(entries(shared)).toEqual([["draft", LONG]])
  })

  test("replacing the unsent text by recalling an entry keeps it as a draft, and ↓ still returns to it", async () => {
    const shared = daemon()
    const h = await terminal(shared)
    await h.type("older message\r")
    await h.type(LONG)
    await h.type(UP)
    expect(h.app.editor.text).toBe("older message")
    await Bun.sleep(5)
    expect(entries(shared)).toEqual([["draft", LONG], ["sent", "older message"]])
    await h.type(DOWN)
    expect(h.app.editor.text).toBe(LONG)
  })

  test("a multi-line entry moves within the text first and only then to the history", async () => {
    const shared = daemon()
    shared.store.recordPrompt(shared.sessionId, "multi one\nmulti two", "draft")
    shared.store.recordPrompt(shared.sessionId, "plain entry", "command")
    const t = await terminal(shared)
    await t.type(UP)
    expect(t.app.editor.text).toBe("plain entry")
    await t.type(UP)
    expect(t.app.editor.text).toBe("multi one\nmulti two")
    expect(t.app.editor.cursor.row).toBe(1)
    await t.type(UP)
    expect(t.app.editor.text).toBe("multi one\nmulti two")
    expect(t.app.editor.cursor.row).toBe(0)
  })

  test("closing the terminal with text in the prompt keeps it as a draft", async () => {
    const shared = daemon()
    const h = await terminal(shared)
    await h.type(LONG)
    await h.app.saveDrafts()
    expect(entries(shared)).toEqual([["draft", LONG]])
  })

  test("a key that opens the sessions picker takes the text out of the prompt: it is kept as a draft", async () => {
    const shared = daemon()
    const h = await terminal(shared)
    await h.type(LONG)
    await h.type("\x18")
    await h.type("l")
    await Bun.sleep(5)
    expect(h.app.editor.text).toBe("")
    expect(entries(shared)).toEqual([["draft", LONG]])
  })

  test("a draft kept by the picker is a draft of the project, read by another session's ↑", async () => {
    const shared = daemon()
    const other = ids("session")
    shared.store.createSession({ id: other, directory: DIRECTORY, title: "" })
    const h = await terminal(shared)
    await h.type(LONG)
    await h.type("\x03")
    await Bun.sleep(5)
    const second = appHarness({ dataDir: tempDir(), directory: DIRECTORY, sessionId: other, reply: shared.reply })
    second.app.applySettings({ onboarded: true })
    await Bun.sleep(10)
    await second.type(UP)
    expect(second.app.editor.text).toBe(LONG)
  })
})

describe("secrets, remote clients and the search list", () => {
  test("the terminal hands the daemon what was typed; marker-only drafts are the daemon's to refuse", async () => {
    const shared = daemon()
    const h = await terminal(shared)
    await h.type("‹secret:1›‹secret:2›")
    await h.type("\x03")
    await Bun.sleep(5)
    expect(entries(shared)).toEqual([])
    expect(h.sentOf("prompt.record")).toHaveLength(1)
  })

  test("a remote terminal never asks for or records the local history, and keeps its own in memory", async () => {
    const shared = daemon()
    shared.store.recordPrompt(shared.sessionId, "/local command", "command")
    const h = await terminal(shared, { remote: true })
    await h.type("typed on the remote\r")
    await h.type(LONG)
    await h.type("\x03")
    await h.type("/panel next\r")
    await Bun.sleep(5)
    expect(h.sentOf("prompt.history")).toHaveLength(0)
    expect(h.sentOf("prompt.record")).toHaveLength(0)
    await h.type(UP)
    expect(h.app.editor.text).toBe("/panel next")
    await h.type(UP)
    expect(h.app.editor.text).toBe("typed on the remote")
    // Only the daemon's own record of the sent message is there: no draft, no command from the remote terminal.
    expect(entries(shared)).toEqual([["sent", "typed on the remote"], ["command", "/local command"]])
  })

  test("/prompt-history lists the kinds, searches, deletes one entry with two ctrl+d and clears drafts", async () => {
    const shared = daemon()
    const h = await terminal(shared)
    await h.type("deploy the staging build\r")
    await h.type("/panel next\r")
    await h.type("!")
    await h.type("deploy --dry-run\r")
    await h.type("notes about the deploy plan")
    await h.type("\x03")
    await Bun.sleep(5)
    await h.type("\x1br")
    expect(h.app.editor.text).toBe("notes about the deploy plan")
    expect(screen(h)).toContain("draft")
    await h.type(UP)
    expect(screen(h)).toContain("shell")
    await h.type(UP)
    expect(screen(h)).toContain("command")
    await h.type("deploy")
    expect(h.app.editor.text).toBe("notes about the deploy plan")
    await h.type("\x04")
    expect(screen(h)).toContain("ctrl+d again to delete")
    await h.type("\x04")
    await Bun.sleep(5)
    expect(entries(shared).map(([, text]) => text)).not.toContain("notes about the deploy plan")
    expect(h.app.editor.text).toBe("deploy --dry-run")
    await h.type("\r")
    h.app.editor.clear()
    await h.type(ESC)

    shared.store.recordPrompt(shared.sessionId, "an old draft to clear", "draft")
    await h.type("/prompt-history clear-drafts\r")
    await Bun.sleep(5)
    expect(entries(shared).some(([kind]) => kind === "draft")).toBe(false)
    expect(entries(shared).map(([, text]) => text)).toContain("/panel next")
  })

  test("the search bar names the shown entry's kind and still fits narrow frames", () => {
    for (const width of [40, 60, 100, 180]) {
      const bar = promptSearchBar({ state: { query: "deploy", prompts: ["a", "b"], kinds: ["draft", "shell"], matches: [0, 1], at: 0, draft: "" }, width, margin: 2 })
      const text = bar.row.map((span) => span.text).join("")
      expect(text).toContain("draft")
      expect(text).toContain("1/2")
      expect([...text].length).toBeLessThanOrEqual(width)
    }
  })

  test("an older daemon that answers only prompts still recalls them as sent messages", async () => {
    const h = appHarness({ dataDir: tempDir(), directory: DIRECTORY, reply: (command) => (command.type === "prompt.history" ? { ok: true, result: { prompts: ["from an older daemon"] } } : undefined) })
    h.app.applySettings({ onboarded: true })
    await Bun.sleep(10)
    await h.type(UP)
    expect(h.app.editor.text).toBe("from an older daemon")
    expect(screen(h)).not.toContain("draft")
  })
})
