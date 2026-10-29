import { afterEach, describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import path from "node:path"
import { createEditor } from "../src/view/editor"
import { promptSearchBar, searchPrompts } from "../src/view/prompt-search"
import { renderShortcutOverlay, shortcutEntries } from "../src/view/shortcut-overlay"
import { createBindings } from "../src/ui/keymap"
import { textWidth } from "../src/view/wrap"
import { DEFAULT_TUI_PROFILE, writeTuiProfile } from "../src/view/tui-profile"
import { b56Harness } from "./b56-harness"
import { appHarness, cleanTemps, conversation, ids, tempDir } from "./session-ui-harness"

afterEach(cleanTemps)

const ALT_UP = "\x1b[1;3A"

describe("kill ring and jump to character", () => {
  test("consecutive kills grow one entry, yank brings it back and yank-pop swaps in the previous kill", () => {
    const editor = createEditor()
    editor.insert("alpha beta gamma")
    editor.action("delete-word-backward")
    editor.action("delete-word-backward")
    expect(editor.text).toBe("alpha ")
    expect(editor.killRing).toEqual(["beta gamma"])
    editor.action("yank")
    expect(editor.text).toBe("alpha beta gamma")
    expect(editor.undo()).toBe(true)
    expect(editor.text).toBe("alpha ")
  })

  test("a move ends the chain; yank-pop walks back through older kills and only works right after a yank", () => {
    const editor = createEditor()
    editor.insert("one two")
    editor.action("delete-word-backward")
    editor.action("line-home")
    editor.action("delete-to-line-end")
    expect(editor.text).toBe("")
    expect(editor.killRing).toEqual(["one ", "two"])
    expect(editor.action("yank-pop")).toBe("none")
    editor.action("yank")
    expect(editor.text).toBe("one ")
    editor.action("yank-pop")
    expect(editor.text).toBe("two")
    editor.action("yank-pop")
    expect(editor.text).toBe("one ")
    editor.action("move-left")
    expect(editor.action("yank-pop")).toBe("none")
  })

  test("killing a selection is not a kill, and yank with an empty ring does nothing", () => {
    const editor = createEditor()
    editor.insert("keep me")
    expect(editor.action("yank")).toBe("none")
    editor.action("buffer-home")
    editor.action("select-word-forward")
    editor.action("delete-word-forward")
    expect(editor.killRing).toEqual([])
  })

  test("jump-forward waits for a character and moves to its next occurrence; jump-backward goes the other way", () => {
    const editor = createEditor()
    editor.insert("hello world")
    editor.action("line-home")
    editor.action("jump-forward")
    expect(editor.jumpPending).toBe(true)
    expect(editor.jumpTo("o")).toBe(true)
    expect(editor.cursor.col).toBe(4)
    editor.action("jump-forward")
    editor.jumpTo("o")
    expect(editor.cursor.col).toBe(7)
    editor.action("jump-backward")
    editor.jumpTo("o")
    expect(editor.cursor.col).toBe(4)
    editor.action("jump-forward")
    expect(editor.jumpTo("z")).toBe(false)
    expect(editor.jumpPending).toBe(false)
    expect(editor.cursor.col).toBe(4)
  })

  test("option+backspace deletes the word before the cursor however the terminal encodes it, and so does ctrl+backspace", async () => {
    for (const seq of ["\x1b\x7f", "\x1b\b", "\x1b[127;3u", "\x1b[127;5u"]) {
      const h = appHarness()
      h.app.applySettings({ onboarded: true })
      await h.type("hola mundo feliz")
      await h.type(seq)
      expect(h.app.editor.text).toBe("hola mundo ")
      await h.type(seq)
      expect(h.app.editor.text).toBe("hola ")
    }
  })

  test("alt+y, alt+shift+y, alt+j and alt+shift+j are the default keys", async () => {
    const h = appHarness()
    h.app.applySettings({ onboarded: true })
    await h.type("alpha beta")
    await h.type("\x17")
    expect(h.app.editor.text).toBe("alpha ")
    await h.type("\x1by")
    expect(h.app.editor.text).toBe("alpha beta")
    await h.type("\x01")
    await h.type("\x1bj")
    await h.type("b")
    expect(h.app.editor.cursor.col).toBe(6)
    expect(h.app.editor.text).toBe("alpha beta")
  })
})

describe("history search", () => {
  test("searchPrompts is newest first, de-duplicated and case-insensitive unless the query has a capital", () => {
    const prompts = ["fix the deploy script", "add tests", "Deploy notes", "add tests", "deploy again"]
    expect(searchPrompts(prompts, "")).toEqual([0, 1, 2, 4])
    expect(searchPrompts(prompts, "deploy")).toEqual([0, 2, 4])
    expect(searchPrompts(prompts, "Deploy")).toEqual([2])
    expect(searchPrompts(prompts, "zzz")).toEqual([])
  })

  test("the bar fits narrow and wide frames and shows the count", () => {
    for (const width of [40, 60, 100, 180]) {
      const bar = promptSearchBar({ state: { query: "deploy", prompts: ["a", "b"], matches: [0, 1], at: 1, draft: "" }, width, margin: 2 })
      expect(textWidth(bar.row.map((span) => span.text).join(""))).toBeLessThanOrEqual(width)
      expect(bar.row.map((span) => span.text).join("")).toContain("2/2")
    }
  })

  test("alt+r searches as you type, ctrl+r goes older, enter keeps the match without sending it", async () => {
    const h = appHarness({ directory: "/work/app", reply: (command) => command.type === "prompt.history" ? { ok: true, result: { prompts: ["fix the deploy script", "add tests for deploy", "write docs", "Deploy notes"] } } : undefined })
    h.app.applySettings({ onboarded: true })
    await h.type("\x1br")
    expect(h.sentOf("prompt.history")[0]).toMatchObject({ directory: "/work/app", limit: 500 })
    expect(h.app.editor.text).toBe("fix the deploy script")
    expect(h.text().join("\n")).toContain("search")
    await h.type("deploy")
    expect(h.app.editor.text).toBe("fix the deploy script")
    expect(h.text().join("\n")).toContain("1/3")
    await h.type("\x12")
    expect(h.app.editor.text).toBe("add tests for deploy")
    await h.type("\x12")
    await h.type("\x12")
    expect(h.app.editor.text).toBe("Deploy notes")
    await h.type("\x1b[B")
    expect(h.app.editor.text).toBe("add tests for deploy")
    await h.type("\r")
    expect(h.app.editor.text).toBe("add tests for deploy")
    expect(h.sentOf("user.submit")).toHaveLength(0)
    expect(h.text().join("\n")).not.toContain("1/3")
  })

  test("esc puts the draft back, a query with no match leaves the draft in place, and the bar is gone afterwards", async () => {
    const h = appHarness({ directory: "/work/app", reply: (command) => command.type === "prompt.history" ? { ok: true, result: { prompts: ["alpha", "beta"] } } : undefined })
    h.app.applySettings({ onboarded: true })
    await h.type("half typed")
    await h.type("\x1br")
    expect(h.app.editor.text).toBe("alpha")
    await h.type("zzz")
    expect(h.app.editor.text).toBe("half typed")
    expect(h.text().join("\n")).toContain("no matches")
    await h.type("\x1b")
    expect(h.app.editor.text).toBe("half typed")
    expect(h.text().join("\n")).not.toContain("no matches")
  })

  test("/prompt-history starts with a query, and a project with no prompts says so", async () => {
    const h = appHarness({ directory: "/work/app", reply: (command) => command.type === "prompt.history" ? { ok: true, result: { prompts: ["alpha one", "beta two"] } } : undefined })
    h.app.applySettings({ onboarded: true })
    await h.type("/prompt-history beta\r")
    expect(h.app.editor.text).toBe("beta two")
    const empty = appHarness({ directory: "/work/app", reply: (command) => command.type === "prompt.history" ? { ok: true, result: { prompts: [] } } : undefined })
    empty.app.applySettings({ onboarded: true })
    await empty.type("\x1br")
    expect(empty.text().join("\n")).toContain("no earlier prompts")
  })
})

function queued(options: { queueRestore?: boolean } = {}) {
  const dataDir = tempDir()
  if (options.queueRestore) writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, queueRestore: true })
  const h = appHarness({ dataDir, width: 100, height: 30, reply: (command) => command.type === "queue.remove" || command.type === "turn.cancel" ? { ok: true } : undefined })
  h.app.applySettings({ onboarded: true })
  const chat = conversation(h.sessionId, h.app.onEvent)
  chat.exchange("hello", "hi")
  const turnId = ids("turn")
  chat.emit({ type: "turn.started", turnId, queueId: ids("queue") })
  chat.emit({ type: "foreground.state", state: "generating", turnId })
  const first = ids("queue")
  const second = ids("queue")
  chat.emit({ type: "queue.added", queueId: first, text: "check the first thing\nwith two lines", attachments: [] })
  chat.emit({ type: "queue.added", queueId: second, text: "then the second", attachments: [] })
  const entries = [{ queueId: first, preview: "check the first thing with two lines", attachments: 0 }, { queueId: second, preview: "then the second", attachments: 0 }]
  chat.emit({ type: "queue.changed", queue: entries })
  h.app.render()
  return { ...h, chat, first, second, entries }
}

describe("edit a queued prompt", () => {
  test("alt+up removes the newest queued prompt and puts its text in the editor; again, the older one goes in front", async () => {
    const h = queued()
    await h.type(ALT_UP)
    expect(h.sentOf("queue.remove").at(-1)).toMatchObject({ queueId: h.second })
    expect(h.app.editor.text).toBe("then the second")
    h.chat.emit({ type: "queue.changed", queue: h.entries.slice(0, 1) })
    await h.type(ALT_UP)
    expect(h.sentOf("queue.remove").at(-1)).toMatchObject({ queueId: h.first })
    expect(h.app.editor.text).toBe("check the first thing\nwith two lines\nthen the second")
    h.chat.emit({ type: "queue.changed", queue: [] })
    await h.type(ALT_UP)
    expect(h.text().join("\n")).toContain("nothing queued")
  })

  test("the queue panel names the key", () => {
    const h = queued()
    expect(h.text().join("\n")).toContain("alt+↑ edit")
  })

  test("a message that already started is reported and the editor stays as it was", async () => {
    const failing = appHarness({ reply: (command) => command.type === "queue.remove" ? { ok: false, error: { code: "target_mismatch", message: "[ACTOR]: queued message not found" } } : undefined })
    failing.app.applySettings({ onboarded: true })
    const chat = conversation(failing.sessionId, failing.app.onEvent)
    const id = ids("queue")
    chat.emit({ type: "queue.added", queueId: id, text: "gone", attachments: [] })
    chat.emit({ type: "queue.changed", queue: [{ queueId: id, preview: "gone", attachments: 0 }] })
    await failing.type(ALT_UP)
    expect(failing.app.editor.text).toBe("")
    expect(failing.text().join("\n")).toContain("already started")
  })

  test("a shell line is refused while the prompt holds text, and notices cannot be pulled back", async () => {
    const h = queued()
    const shell = ids("queue")
    h.chat.emit({ type: "queue.added", queueId: shell, text: "git status", attachments: [], shell: true })
    h.chat.emit({ type: "queue.changed", queue: [...h.entries, { queueId: shell, preview: "git status", attachments: 0 }] })
    await h.type("typing")
    await h.type(ALT_UP)
    expect(h.sentOf("queue.remove")).toHaveLength(0)
    expect(h.text().join("\n")).toContain("clear the prompt first")
    await h.type("\x03")
    await h.type(ALT_UP)
    expect(h.sentOf("queue.remove").at(-1)).toMatchObject({ queueId: shell })
    expect(h.app.editor.text).toBe("git status")
  })

  test("↑ on an empty prompt edits the newest queued prompt; with text typed or nothing queued it is the cursor and the history", async () => {
    const h = queued()
    await h.type("\x1b[A")
    expect(h.sentOf("queue.remove").at(-1)).toMatchObject({ queueId: h.second })
    expect(h.app.editor.text).toBe("then the second")
    await h.type("\x1b[A")
    expect(h.sentOf("queue.remove")).toHaveLength(1)
    h.app.editor.clear()
    h.chat.emit({ type: "queue.changed", queue: [] })
    await h.type("\x1b[A")
    expect(h.sentOf("queue.remove")).toHaveLength(1)
    expect(h.text().join("\n")).not.toContain("nothing queued")
  })

  test("Esc Esc on a running turn sends the queue on by default and returns the messages to the prompt with queueRestore", async () => {
    const plain = queued()
    await plain.type("\x1b")
    await plain.type("\x1b")
    expect(plain.sentOf("turn.cancel")).toHaveLength(1)
    expect(plain.sentOf("queue.remove")).toHaveLength(0)
    expect(plain.sentOf("queue.promote")).toMatchObject([{ queueId: plain.first }])
    expect(plain.text().join("\n")).toContain("sending the queued message")
    const restoring = queued({ queueRestore: true })
    await restoring.type("\x1b")
    await restoring.type("\x1b")
    expect(restoring.sentOf("turn.cancel")).toHaveLength(1)
    expect(restoring.sentOf("queue.remove").map((command) => (command as { queueId: string }).queueId)).toEqual([restoring.first, restoring.second])
    expect(restoring.app.editor.text).toBe("check the first thing\nwith two lines\nthen the second")
  })
})

describe("Esc Esc backtrack", () => {
  test("the second Esc on an idle empty prompt opens a picker of the user's prompts; Enter reverts to the selected one", async () => {
    const h = b56Harness()
    await h.type("\x1b")
    expect(h.text().join("\n")).toContain("esc again")
    expect(h.app.page).toBe("chat")
    await h.type("\x1b")
    expect(h.app.page).toBe("messages")
    const screen = h.text().join("\n")
    expect(screen).toContain("Backtrack")
    expect(screen).toContain("Include the tool details")
    expect(screen).not.toContain("Read the complete session")
    await h.type("\x1b[A")
    await h.type("\r")
    expect(h.sentOf("session.undo").at(-1)).toMatchObject({ atItemId: h.turns[0]!.items[0]!.itemId })
    expect(h.app.page).toBe("chat")
    expect(h.app.editor.text).toBe(h.turns[0]!.items[0]!.text)
  })

  test("f forks from the selected prompt and Esc leaves the picker", async () => {
    const h = b56Harness()
    await h.type("\x1b")
    await h.type("\x1b")
    await h.type("f")
    expect(h.sentOf("session.fork")[0]).toMatchObject({ atItemId: h.turns[1]!.items[0]!.itemId })
    const other = b56Harness()
    await other.type("\x1b")
    await other.type("\x1b")
    await other.type("\x1b")
    expect(other.app.page).toBe("chat")
    expect(other.sentOf("session.undo")).toHaveLength(0)
  })

  test("it needs an empty prompt and an earlier prompt, and /backtrack opens the same picker", async () => {
    const h = b56Harness()
    await h.type("draft")
    await h.type("\x1b")
    await h.type("\x1b")
    expect(h.app.page).toBe("chat")
    await h.type("\x03")
    await h.type("/backtrack\r")
    expect(h.app.page).toBe("messages")
    const fresh = appHarness()
    fresh.app.applySettings({ onboarded: true })
    await fresh.type("\x1b")
    await fresh.type("\x1b")
    expect(fresh.app.page).toBe("chat")
  })

  test("escBacktrack off leaves Esc alone", async () => {
    const dataDir = tempDir()
    writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, escBacktrack: false })
    const h = b56Harness({ dataDir })
    await h.type("\x1b")
    await h.type("\x1b")
    expect(h.app.page).toBe("chat")
  })
})

describe("? shortcut overlay", () => {
  test("? on an empty prompt opens it; any other key closes it and acts; ?? types a question mark", async () => {
    const h = appHarness()
    h.app.applySettings({ onboarded: true })
    await h.type("?")
    expect(h.app.editor.text).toBe("")
    expect(h.text().join("\n")).toContain("Shortcuts")
    await h.type("x")
    expect(h.text().join("\n")).not.toContain("Shortcuts")
    expect(h.app.editor.text).toBe("x")
    await h.type("\x03")
    await h.type("?")
    await h.type("?")
    expect(h.app.editor.text).toBe("?")
    await h.type("\x03")
    await h.type("?")
    await h.type("\x1b")
    expect(h.text().join("\n")).not.toContain("Shortcuts")
    expect(h.app.editor.text).toBe("")
  })

  test("with text in the prompt ? is a character, and the setting turns it off", async () => {
    const h = appHarness()
    h.app.applySettings({ onboarded: true })
    await h.type("why")
    await h.type("?")
    expect(h.app.editor.text).toBe("why?")
    const dataDir = tempDir()
    writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, shortcutOverlay: false })
    const off = appHarness({ dataDir })
    off.app.applySettings({ onboarded: true })
    await off.type("?")
    expect(off.app.editor.text).toBe("?")
  })

  test("it lists the keys as bound now and fits narrow and tall frames", async () => {
    const dataDir = tempDir()
    writeFileSync(path.join(dataDir, "keybindings.json"), JSON.stringify({ "alt+h": "history.search", "alt+r": null }))
    const h = appHarness({ dataDir, width: 120, height: 40 })
    h.app.applySettings({ onboarded: true })
    await h.type("/shortcuts\r")
    const screen = h.text().join("\n")
    expect(screen).toContain("alt+h")
    expect(screen).not.toContain("alt+r")
    for (const [width, height] of [[60, 20], [100, 30], [160, 45]] as const) {
      const rows = renderShortcutOverlay({ width, entries: shortcutEntries(createBindings(), { multiline: false, backtrack: true }), maxRows: Math.max(2, height - 18) })
      expect(rows.length).toBeGreaterThan(2)
      expect(rows.every((row) => textWidth(row.map((span) => span.text).join("")) <= width)).toBe(true)
    }
  })
})

describe("/multiline", () => {
  test("Enter adds a line, alt+enter sends, slash commands still send on Enter, and it persists in the profile", async () => {
    const dataDir = tempDir()
    const h = appHarness({ dataDir })
    h.app.applySettings({ onboarded: true })
    await h.type("/multiline on\r")
    await h.type("line one")
    await h.type("\r")
    await h.type("line two")
    expect(h.app.editor.text).toBe("line one\nline two")
    expect(h.sentOf("user.submit")).toHaveLength(0)
    await h.type("\x1b\r")
    expect(h.sentOf("user.submit")[0]).toMatchObject({ text: "line one\nline two" })
    await h.type("/multiline off\r")
    await h.type("plain")
    await h.type("\r")
    expect(h.sentOf("user.submit")[1]).toMatchObject({ text: "plain" })
  })

  test("a bare Enter on an empty prompt adds nothing, and bad arguments show the usage", async () => {
    const h = appHarness()
    h.app.applySettings({ onboarded: true })
    await h.type("/multiline on\r")
    await h.type("\r")
    expect(h.app.editor.text).toBe("")
    await h.type("/multiline maybe\r")
    expect(h.text().join("\n")).toContain("usage: /multiline")
  })
})

describe("effort step keys", () => {
  const report = { engine: "native", selectable: true, defaults: { model: "local:main", effort: "low" }, roles: {}, effective: { model: "local:main", effort: "medium" }, models: [{ id: "local:main", name: "Local", efforts: ["low", "medium", "high"], defaultEffort: "low" }] }

  test("alt+. steps the effort up, alt+, steps it down, F3 still cycles forward", async () => {
    const h = appHarness({ reply: (command) => command.type === "models.list" || command.type === "session.model.set" ? { ok: true, result: report } : undefined })
    h.app.applySettings({ onboarded: true })
    await h.type("\x1b.")
    expect(h.sentOf("session.model.set").at(-1)).toMatchObject({ choice: { model: "local:main", effort: "high" } })
    await h.type("\x1b,")
    expect(h.sentOf("session.model.set").at(-1)).toMatchObject({ choice: { model: "local:main", effort: "low" } })
    await h.type("\x1bOR")
    expect(h.sentOf("session.model.set").at(-1)).toMatchObject({ choice: { model: "local:main", effort: "high" } })
  })
})

describe("paste bursts without bracketed paste", () => {
  test("several lines in one plain read are inserted, not sent line by line", async () => {
    const h = appHarness()
    h.app.applySettings({ onboarded: true })
    await h.type("alpha\rbeta\rgamma")
    expect(h.app.editor.text).toBe("alpha\nbeta\ngamma")
    expect(h.sentOf("user.submit")).toHaveLength(0)
  })

  test("a read with a newline right after a burst joins it; a line and its Enter, or a bare Enter, is typing", async () => {
    const h = appHarness()
    h.app.applySettings({ onboarded: true })
    await h.type("a\rb\rc")
    await h.type("d\r")
    expect(h.app.editor.text).toBe("a\nb\ncd\n")
    expect(h.sentOf("user.submit")).toHaveLength(0)
    const typed = appHarness()
    typed.app.applySettings({ onboarded: true })
    await typed.type("one line")
    await typed.type("\r")
    expect(typed.sentOf("user.submit")[0]).toMatchObject({ text: "one line" })
    await typed.type("next prompt\r")
    expect(typed.sentOf("user.submit")[1]).toMatchObject({ text: "next prompt" })
  })

  test("a slash command followed by more text is still typed ahead, and the setting turns detection off", async () => {
    const h = appHarness()
    h.app.applySettings({ onboarded: true })
    await h.type("/help\rx\ry")
    expect(h.app.page).toBe("help")
    const dataDir = tempDir()
    writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, pasteBurst: false })
    const off = appHarness({ dataDir })
    off.app.applySettings({ onboarded: true })
    await off.type("alpha\rbeta\rgamma")
    expect(off.sentOf("user.submit")[0]).toMatchObject({ text: "alpha" })
  })

  test("a bracketed paste is unchanged", async () => {
    const h = appHarness()
    h.app.applySettings({ onboarded: true })
    await h.type("\x1b[200~one\ntwo\x1b[201~")
    expect(h.app.editor.text).toBe("one\ntwo")
  })
})
