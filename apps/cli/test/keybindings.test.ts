import { afterEach, describe, expect, test } from "bun:test"
import { buildBindings, parseAction, parseKeybindings, parseKeySpec } from "../src/extensions/keybindings"
import { createBindings, DEFAULT_BINDINGS, KEY_ACTIONS, keymapHelp, LEADER_KEY, resolveKey } from "../src/ui/keymap"
import { helpKeyRows } from "../src/view/help-page"
import { appHarness, extension, scratch } from "./extensions-harness"

const made: Array<ReturnType<typeof scratch>> = []
function layout() {
  const next = scratch()
  made.push(next)
  return next
}
afterEach(() => {
  for (const item of made.splice(0)) item.cleanup()
})

/** The command palette asks for this many sessions (startup asks for 50), which tells the two `session.list` apart. */
const PALETTE_LIMIT = 30

const direct = (spec: string) => {
  const parsed = parseKeySpec(spec)
  if (!parsed.ok || parsed.target.kind !== "direct") throw new Error(`${spec}: ${parsed.ok ? "not direct" : parsed.error}`)
  return parsed.target.seqs
}

describe("key names", () => {
  test("ctrl, alt, function, navigation and leader keys parse to raw sequences", () => {
    expect(direct("ctrl+g")).toEqual(["\x07"])
    expect(direct("CTRL+G")).toEqual(["\x07"])
    expect(direct("ctrl+space")).toEqual(["\x00"])
    expect(direct("alt+x")).toEqual(["\x1bx"])
    expect(direct("alt+X")).toEqual(["\x1bX"])
    expect(direct(" f2 ")).toEqual(["\x1bOQ", "\x1b[12~"])
    expect(direct("f12")).toEqual(["\x1b[24~"])
    expect(direct("pgup")).toEqual(["\x1b[5~"])
    expect(direct("shift+tab")).toEqual(["\x1b[Z"])
    expect(direct("home")).toContain("\x1b[1~")
    expect(direct("\x07")).toEqual(["\x07"])
    expect(parseKeySpec("leader+G")).toMatchObject({ ok: true, target: { kind: "leader", key: "g" } })
  })

  test("reserved and unknown keys are refused with a reason", () => {
    for (const reserved of ["ctrl+c", "ctrl+x", "enter", "esc", "tab", "backspace", "ctrl+j", "ctrl+m", "ctrl+i", "ctrl+h", "\x03", "\r"]) {
      const parsed = parseKeySpec(reserved)
      expect(parsed.ok).toBe(false)
      if (!parsed.ok) expect(parsed.error).toContain("reserved")
    }
    for (const unknown of ["banana", "ctrl+1", "alt+", "leader+", "leader+ab", "f13", "ctrl+", ""]) expect(parseKeySpec(unknown).ok).toBe(false)
  })

  test("actions: every built-in, command:<name>, page:<id>, modal:<id> and action:<id>; anything else is refused", () => {
    for (const action of KEY_ACTIONS) expect(parseAction(action)).toBe(action)
    expect(parseAction("command:fetch")).toBe("command:fetch")
    expect(parseAction("page:dash.main")).toBe("page:dash.main")
    expect(parseAction("modal:git.pick")).toBe("modal:git.pick")
    expect(parseAction("action:deploy-now")).toBe("action:deploy-now")
    for (const bad of ["nope", "command:", "page:", "modal:", "action:", "action:has space", "modal:a/b", "command:has space", "NEW", ""]) expect(parseAction(bad)).toBeUndefined()
  })
})

describe("keybindings.json", () => {
  test("valid entries apply; invalid keys and actions are reported once each and skipped", () => {
    const parsed = parseKeybindings(JSON.stringify({ "ctrl+g": "usage", "ctrl+t": null, "banana": "help", "f3": "nonsense", "f4": 7, "ctrl+c": "quit", "leader+g": "help" }))
    expect(parsed.entries.map((entry) => [entry.spec, entry.action])).toEqual([["ctrl+g", "usage"], ["ctrl+t", null], ["leader+g", "help"]])
    expect(parsed.problems).toEqual([
      'keybindings.json: unknown key "banana"',
      'keybindings.json: unknown action "nonsense" for f3',
      "keybindings.json: unknown action 7 for f4",
      "keybindings.json: ctrl+c is reserved",
    ])
  })

  test("not JSON, or not an object, is one problem and no entries", () => {
    expect(parseKeybindings("{ nope")).toEqual({ entries: [], problems: ["keybindings.json: not valid JSON"] })
    expect(parseKeybindings("[1]").problems).toEqual(['keybindings.json: expected an object of "key": "action"'])
    expect(parseKeybindings("null").entries).toEqual([])
  })

  test("without a file the defaults are exactly today's keymap", () => {
    const built = buildBindings({})
    expect([...built.bindings.direct]).toEqual([...DEFAULT_BINDINGS.direct])
    expect([...built.bindings.leader]).toEqual([...DEFAULT_BINDINGS.leader])
    expect([...built.bindings.inline]).toEqual([...DEFAULT_BINDINGS.inline])
    expect(built.problems).toEqual([])
    // The same answers as before the keymap became configurable.
    const state = {}
    expect(resolveKey(state, "\x14", 0)).toEqual({ kind: "action", action: "dock" })
    expect(resolveKey(state, "\x1bOQ", 0)).toEqual({ kind: "action", action: "model.next" })
    expect(resolveKey(state, LEADER_KEY, 0)).toEqual({ kind: "armed" })
    expect(resolveKey(state, "N", 1)).toEqual({ kind: "action", action: "new" })
    expect(DEFAULT_BINDINGS.inline.get("\x0f")).toBe("tools.expand")
  })

  test("remap, unbind and leader chords change what resolveKey answers", () => {
    const file = parseKeybindings(JSON.stringify({ "ctrl+g": "usage", "ctrl+t": null, "leader+g": "help", "leader+n": null, "f2": "help", "ctrl+o": null, "alt+o": "tools.expand" })).entries
    const { bindings } = buildBindings({ file })
    expect(resolveKey({}, "\x07", 0, bindings)).toEqual({ kind: "action", action: "usage" })
    expect(resolveKey({}, "\x14", 0, bindings)).toEqual({ kind: "pass" })
    for (const f2 of ["\x1bOQ", "\x1b[12~"]) expect(resolveKey({}, f2, 0, bindings)).toEqual({ kind: "action", action: "help" })
    expect(resolveKey({}, "\x1bOR", 0, bindings)).toEqual({ kind: "action", action: "effort.next" })
    const chord = (key: string) => {
      const state = {}
      resolveKey(state, LEADER_KEY, 0, bindings)
      return resolveKey(state, key, 1, bindings)
    }
    expect(chord("g")).toEqual({ kind: "action", action: "help" })
    expect(chord("n")).toEqual({ kind: "cancelled" })
    expect(chord("q")).toEqual({ kind: "action", action: "quit" })
    // ctrl+o is free (an inline default that was unbound) and alt+o took over its action.
    expect(bindings.inline.has("\x0f")).toBe(false)
    expect(resolveKey({}, "\x1bo", 0, bindings)).toEqual({ kind: "action", action: "tools.expand" })
    // The defaults were not touched.
    expect(DEFAULT_BINDINGS.direct.has("\x14")).toBe(true)
    expect(DEFAULT_BINDINGS.leader.has("n")).toBe(true)
  })

  test("the help rows list the effective keys, not the defaults", () => {
    const file = parseKeybindings(JSON.stringify({ "ctrl+g": "usage", "ctrl+t": null, "ctrl+o": null, "ctrl+s": "queue.send" })).entries
    const { bindings } = buildBindings({ file })
    const keys = keymapHelp(bindings)
    expect(keys).toContainEqual({ keys: "ctrl+g", label: "usage" })
    expect(keys.some((row) => row.keys === "ctrl+t")).toBe(false)
    const rows = helpKeyRows(bindings)
    expect(rows.some(([key]) => key === "ctrl+o")).toBe(false)
    expect(rows).toContainEqual(["ctrl+s", "send first queued now (or continue a held queue)"])
    expect(rows).toContainEqual(["ctrl+g", "usage"])
  })

  test("the default help rows retain editor hints and add recent reverse and terminal suspend", () => {
    const rows = helpKeyRows().filter(([, what]) => what !== "command palette" && what !== "paste an image from the clipboard")
    expect(rows.slice(0, 14)).toEqual([
      ["enter", "send"],
      ["alt+enter / ctrl+j", "newline"],
      ["esc esc", "cancel turn"],
      ["ctrl+o", "expand tool output"],
      ["pgup / pgdn / wheel", "scroll"],
      ["a / s / d", "approve once / for session / deny (empty prompt)"],
      ["↑ / ↓", "move between rows · previous prompts at the first and last"],
      ["ctrl+s", "send first queued now (or continue a held queue)"],
      ["ctrl+k", "drop last queued (empty prompt)"],
      ["tab", "complete /command"],
      ["shift+tab", "permissions: ask · edits · full · plan"],
      ["home / end", "scroll to the top / bottom (empty prompt)"],
      ["!", "shell mode: run the line as a command (first character)"],
      ["ctrl+c", "clear the prompt · quit when it is empty"],
    ])
    expect(rows.slice(14)).toEqual([...new Set([...createBindings().leader.keys()].map((key) => `ctrl+x ${key === "\x1b[B" || key === "\x1bOB" ? "down" : key}`))].map((key) => [key, expect.any(String)]).concat([["ctrl+g", "comment on the selection (or walk the newest answer)"], ["alt+q", "comment on the selection (or walk the newest answer)"], ["alt+l", "the pending comments: list, edit, reorder"], ["shift+f2", "previous recent model"], ["ctrl+z", "suspend terminal"], ["ctrl+t", "session widgets"], ["ctrl+f", "find in the transcript"], ["f2", "next model"], ["f3", "next effort"], ["alt+,", "previous effort"], ["alt+.", "next effort"], ["alt+r", "search earlier prompts"], ["alt+p", "earlier prompt, from any row"], ["alt+n", "later prompt, or the text being typed"], ["alt+up", "pull the newest queued prompt back to edit"], ["shift+f3", "select variant"], ["ctrl+alt+y", "scroll one line up"], ["ctrl+alt+e", "scroll one line down"], ["ctrl+alt+u", "scroll half a page up"], ["ctrl+alt+d", "scroll half a page down"], ["ctrl+\\", "focus the right panel or the open file (esc gives the keyboard back)"], ["alt+}", "focus the right panel or the open file (esc gives the keyboard back)"], ["alt+{", "show the open file or the right panel in the right slot"], ["alt+o", "open the file path in the selection, or in the item in view (a list when there are several)"], ["alt+x", "close the open file"],["ctrl+_", "undo prompt edit"], ["ctrl+y", "redo prompt edit"]]) as never)
  })
})

describe("in the app", () => {
  const FILE = { "ctrl+g": "help", "leader+g": "usage", "ctrl+t": null, "leader+n": null, "ctrl+p": null, "f4": "command:usage" }

  test("remapped keys run their action, unbound defaults do nothing, and /help lists what is effective", async () => {
    const { dataDir, write } = layout()
    write("data/keybindings.json", JSON.stringify(FILE))
    const h = await appHarness({ dataDir, width: 140, height: 100 })
    await h.start()
    await h.key("\x07")
    expect(h.app.page).toBe("help")
    const help = h.text()
    expect(help).toContain("ctrl+g")
    expect(help).toContain("ctrl+x g")
    expect(help).not.toContain("ctrl+t ")
    expect(help).not.toContain("ctrl+x n")
    await h.key("\x1b")
    expect(h.app.page).toBe("chat")
    // leader+g, then the chord.
    await h.key(LEADER_KEY)
    await h.key("g")
    expect(h.app.page).toBe("usage")
    await h.key("\x1b")
    // f4 runs `/usage`.
    await h.key("\x1bOS")
    expect(h.app.page).toBe("usage")
    await h.key("\x1b")
    // Unbound defaults: leader+n is swallowed without a new session, ctrl+p opens no palette.
    await h.key(LEADER_KEY)
    await h.key("n")
    await h.key("\x10")
    expect(h.sent.some((command) => command.type === "session.create" || (command.type === "session.list" && command.limit === PALETTE_LIMIT))).toBe(false)
  })

  test("the same keys still do their default job when the file is absent", async () => {
    const { dataDir } = layout()
    const h = await appHarness({ dataDir })
    await h.start()
    await h.key("\x10")
    expect(h.sent.some((command) => command.type === "session.list" && command.limit === PALETTE_LIMIT)).toBe(true)
    await h.key("\x1b")
    await h.key(LEADER_KEY)
    await h.key("U")
    expect(h.app.page).toBe("usage")
  })

  test("invalid entries are reported in one toast and in /help while the valid ones apply", async () => {
    const { dataDir, write } = layout()
    write("data/keybindings.json", JSON.stringify({ "ctrl+c": "quit", "banana": "help", "ctrl+g": "nonsense", "f5": 7, "ctrl+o": "help" }))
    const h = await appHarness({ dataDir, width: 140, height: 60 })
    await h.start()
    expect(h.text()).toContain("4 extension problems")
    await h.key("\x0f")
    expect(h.app.page).toBe("help")
    const help = h.text()
    expect(help).toContain("keybindings.json: ctrl+c is reserved")
    expect(help).toContain('keybindings.json: unknown key "banana"')
    expect(help).toContain('keybindings.json: unknown action "nonsense" for ctrl+g')
  })

  test("a broken file is one problem and the defaults stay", async () => {
    const { dataDir, write } = layout()
    write("data/keybindings.json", "{ not json")
    const h = await appHarness({ dataDir })
    await h.start()
    expect(h.text()).toContain("keybindings.json: not valid JSON")
    await h.key("\x14")
    await h.key(LEADER_KEY)
    await h.key("U")
    expect(h.app.page).toBe("usage")
  })

  test("inline defaults can move: ctrl+o unbound stops expanding tools, another key takes over", async () => {
    const { dataDir, write } = layout()
    write("data/keybindings.json", JSON.stringify({ "ctrl+o": null, "ctrl+g": "tools.expand", "alt+p": "permission.next" }))
    const h = await appHarness({ dataDir })
    await h.start()
    await h.key("\x0f")
    expect(h.app.transcript.toolsExpanded).toBe(false)
    await h.key("\x07")
    expect(h.app.transcript.toolsExpanded).toBe(true)
    await h.key("\x1bp")
    expect(h.sent).toContainEqual(expect.objectContaining({ type: "session.permission.set", mode: "edits" }))
  })

  test("the default ctrl+o still expands tools without a file", async () => {
    const { dataDir } = layout()
    const h = await appHarness({ dataDir })
    await h.start()
    await h.key("\x0f")
    expect(h.app.transcript.toolsExpanded).toBe(true)
  })
})

describe("extension keys", () => {
  test("api.key overrides keybindings.json, takes leader chords and raw keys, and shows in /help", async () => {
    const { dataDir, write } = layout()
    write("data/keybindings.json", JSON.stringify({ "ctrl+g": "help", "f9": "usage" }))
    write(
      "data/extensions/keys.ts",
      extension(
        "keys",
        `
      api.key("ctrl+g", (actions) => actions.toast("ctrl+g from keys"))
      api.key("leader+e", (actions) => actions.toast("chord from keys"))
      api.key("alt+z", (actions) => actions.insert("inserted by key"))
      api.key("ctrl+t", (actions) => actions.toast("dock is mine now"))
      api.key("banana", () => {})
    `,
      ),
    )
    const h = await appHarness({ dataDir, width: 140, height: 80 })
    await h.start()
    await h.key("\x07")
    expect(h.app.page).toBe("chat")
    expect(h.text()).toContain("ctrl+g from keys")
    await h.key(LEADER_KEY)
    await h.key("e")
    expect(h.text()).toContain("chord from keys")
    await h.key("\x1bz")
    expect(h.app.editor.text).toBe("inserted by key")
    h.app.editor.clear()
    await h.key("\x14")
    expect(h.text()).toContain("dock is mine now")
    // The file's other key still works.
    await h.key("\x1b[20~")
    expect(h.app.page).toBe("usage")
    await h.key("\x1b")
    // The invalid key was reported once.
    await h.type("/help\r")
    const help = h.text()
    expect(help).toContain('keys: key unknown key "banana"')
    expect(help).toContain("extension keys")
  })

  test("keybindings.json runs an extension's named action and opens its modal; an id no extension has is a toast", async () => {
    const { dataDir, write } = layout()
    write("data/keybindings.json", JSON.stringify({ f5: "action:greet", f6: "modal:pick", f7: "action:ghost" }))
    write(
      "data/extensions/acts.ts",
      extension(
        "acts",
        `
      api.action("greet", (actions) => actions.toast("greeted by action"), { title: "Greet" })
      api.modal("pick", { title: "Pick one", render: () => [[{ text: "MODAL BODY" }]] })
    `,
      ),
    )
    const h = await appHarness({ dataDir, width: 120, height: 30 })
    await h.start()
    await h.key("\x1b[15~")
    expect(h.text()).toContain("greeted by action")
    await h.key("\x1b[17~")
    expect(h.text()).toContain("MODAL BODY")
    await h.key("\x1b")
    expect(h.text()).not.toContain("MODAL BODY")
    await h.key("\x1b[18~")
    expect(h.text()).toContain("unknown action: ghost")
  })

  test("a key that throws is reported and does not stop the terminal", async () => {
    const { dataDir, write } = layout()
    write("data/extensions/keys.ts", extension("keys", `api.key("ctrl+g", () => { throw new Error("key blew up") })`))
    const h = await appHarness({ dataDir })
    await h.start()
    await h.key("\x07")
    await Bun.sleep(5)
    h.app.render()
    expect(h.text()).toContain("keys: key failed: key blew up")
    await h.key("\x07")
    expect(h.app.page).toBe("chat")
  })
})

describe("live keys", () => {
  test("an edited keybindings.json applies on the daemon's extensions.changed, and page:<id> opens a built-in page by its command", async () => {
    const { dataDir, write } = layout()
    const h = await appHarness({ dataDir })
    await h.start()
    write("data/keybindings.json", JSON.stringify({ "ctrl+g": "page:usage" }))
    h.app.onGlobal({ type: "extensions.changed", revision: 1, seq: 1, at: 0 } as never)
    await Bun.sleep(30)
    await h.key("\x07")
    await Bun.sleep(5)
    expect(h.app.page).toBe("usage")
  })
})
