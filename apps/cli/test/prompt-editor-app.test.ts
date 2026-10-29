import { CUSTOMIZE_ROWS } from "../src/view/customize-page"
import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import type { EditRequest, EditResult } from "@mendcode/editor-launch"
import { osc52Copy, OSC52_MAX_BASE64 } from "../src/ui/osc52"
import { stashPath } from "../src/ui/prompt-stash"
import { DEFAULT_TUI_PROFILE, writeTuiProfile } from "../src/view/tui-profile"
import { appHarness, scratch } from "./extensions-harness"

const NOW = 1_800_000_000_000
const made: Array<ReturnType<typeof scratch>> = []
function layout() {
  const next = scratch()
  made.push(next)
  return next
}
afterEach(() => {
  for (const item of made.splice(0)) item.cleanup()
})

type Harness = Awaited<ReturnType<typeof appHarness>>
async function typeKeys(h: Harness, text: string) {
  for (const char of text) await h.app.onKey(char)
}
const chord = async (h: Harness, key: string) => {
  await h.key("\x18")
  await h.key(key)
}

describe("undo and redo in the prompt", () => {
  test("ctrl+_ undoes the last word and ctrl+y redoes it; with nothing to do a toast says so", async () => {
    const h = await appHarness()
    await h.start()
    await typeKeys(h, "write the tests")
    await h.key("\x1f")
    expect(h.app.editor.text).toBe("write the")
    await h.key("\x1f")
    expect(h.app.editor.text).toBe("write")
    await h.key("\x19")
    expect(h.app.editor.text).toBe("write the")
    await h.key("\x19")
    await h.key("\x19")
    expect(h.app.editor.text).toBe("write the tests")
    expect(h.text()).toContain("nothing to redo")
    while (h.app.editor.canUndo) await h.key("\x1f")
    await h.key("\x1f")
    expect(h.text()).toContain("nothing to undo")
  })

  test("ctrl+c clears the prompt and undo brings it back; a sent prompt starts a clean history", async () => {
    const h = await appHarness()
    await h.start()
    await typeKeys(h, "half a thought")
    await h.key("\x03")
    expect(h.app.editor.text).toBe("")
    await h.key("\x1f")
    expect(h.app.editor.text).toBe("half a thought")
    await h.key("\r")
    expect(h.app.editor.text).toBe("")
    expect(h.app.editor.canUndo).toBe(false)
  })

  test("the keys are rebindable in keybindings.json", async () => {
    const { dataDir, write } = layout()
    write("data/keybindings.json", JSON.stringify({ "alt+z": "edit.undo", "alt+y": "edit.redo", "ctrl+y": null }))
    const h = await appHarness({ dataDir })
    await h.start()
    await typeKeys(h, "one two")
    await h.key("\x1bz")
    expect(h.app.editor.text).toBe("one")
    await h.key("\x1by")
    expect(h.app.editor.text).toBe("one two")
    await h.key("\x1bz")
    await h.key("\x19")
    expect(h.app.editor.text).toBe("one")
  })
})

describe("prompt stash", () => {
  test("ctrl+x p parks the prompt, ctrl+x o brings it back, and the file keeps it across terminals", async () => {
    const { dataDir } = layout()
    const h = await appHarness({ dataDir })
    await h.start()
    await typeKeys(h, "draft for later")
    await chord(h, "p")
    expect(h.app.editor.text).toBe("")
    expect(h.text()).toContain("stashed")
    expect(JSON.parse(readFileSync(stashPath(dataDir), "utf8")).entries.map((entry: { text: string }) => entry.text)).toEqual(["draft for later"])

    const other = await appHarness({ dataDir })
    await other.start()
    await chord(other, "o")
    expect(other.app.editor.text).toBe("draft for later")
    expect(JSON.parse(readFileSync(stashPath(dataDir), "utf8")).entries).toEqual([])
    await chord(other, "o")
    expect(other.text()).toContain("the stash is empty")
  })

  test("restoring while typing stashes what was typed, so nothing is lost; undo steps back", async () => {
    const { dataDir } = layout()
    const h = await appHarness({ dataDir })
    await h.start()
    await typeKeys(h, "first")
    await chord(h, "p")
    await typeKeys(h, "second")
    await chord(h, "o")
    expect(h.app.editor.text).toBe("first")
    expect(readFileSync(stashPath(dataDir), "utf8")).toContain("second")
    await h.key("\x1f")
    expect(h.app.editor.text).toBe("second")
  })

  test("an empty prompt has nothing to stash", async () => {
    const { dataDir } = layout()
    const h = await appHarness({ dataDir })
    await h.start()
    await chord(h, "p")
    expect(h.text()).toContain("nothing to stash")
  })

  test("/stash lists, pops a numbered entry, drops and clears", async () => {
    const { dataDir } = layout()
    const h = await appHarness({ dataDir })
    await h.start()
    for (const text of ["alpha", "beta", "gamma"]) {
      await typeKeys(h, text)
      await chord(h, "p")
    }
    await h.type("/stash")
    await h.key("\r")
    expect(h.app.page).toBe("stash")
    for (const draft of ["gamma", "beta", "alpha"]) expect(h.text()).toContain(draft)
    await h.key("\x1b")
    await h.type("/stash pop 2")
    await h.key("\r")
    expect(h.app.editor.text).toBe("beta")
    await h.app.editor.clear()
    await h.type("/stash drop")
    await h.key("\r")
    expect(readFileSync(stashPath(dataDir), "utf8")).not.toContain("gamma")
    await h.type("/stash clear")
    await h.key("\r")
    expect(JSON.parse(readFileSync(stashPath(dataDir), "utf8")).entries).toEqual([])
  })
})

describe("external editor", () => {
  function launcher(reply: (request: EditRequest) => EditResult) {
    const requests: EditRequest[] = []
    return {
      requests,
      load: async () => (request: EditRequest) => {
        requests.push(request)
        return reply(request)
      },
    }
  }

  test("ctrl+x e hands the prompt to the launcher with VISUAL/EDITOR and the terminal hand-over, then takes the result", async () => {
    const calls: string[] = []
    const fake = launcher((request) => {
      request.suspend?.()
      request.resume?.()
      return { ok: true, text: `${request.text}\nadded in the editor`, changed: true }
    })
    const h = await appHarness({ editorLauncher: fake.load, env: { VISUAL: "code --wait", EDITOR: "nano" }, terminal: { suspend: () => calls.push("suspend"), resume: () => calls.push("resume") } })
    await h.start()
    await typeKeys(h, "my prompt")
    await chord(h, "e")
    expect(fake.requests).toHaveLength(1)
    expect(fake.requests[0]).toMatchObject({ text: "my prompt", env: { VISUAL: "code --wait", EDITOR: "nano" } })
    expect(calls).toEqual(["suspend", "resume"])
    expect(h.app.editor.text).toBe("my prompt\nadded in the editor")
    // The prompt shows the new text: nothing is said about it.
    expect(h.text()).not.toContain("prompt updated from your editor")
    await h.key("\x1f")
    expect(h.app.editor.text).toBe("my prompt")
  })

  test("an unchanged file leaves the prompt, its cursor and its history alone", async () => {
    const fake = launcher((request) => ({ ok: true, text: request.text, changed: false }))
    const h = await appHarness({ editorLauncher: fake.load })
    await h.start()
    await typeKeys(h, "same")
    await h.key("\x1b[D")
    await chord(h, "e")
    expect(h.app.editor.text).toBe("same")
    expect(h.app.editor.cursor).toEqual({ row: 0, col: 3 })
    expect(h.text()).toContain("prompt unchanged")
  })

  test("no editor configured and a failing editor are toasts, and the prompt stays", async () => {
    const none = launcher(() => ({ ok: false, reason: "no-editor", message: "set $VISUAL or $EDITOR to edit the prompt in your editor" }))
    const h = await appHarness({ editorLauncher: none.load })
    await h.start()
    await typeKeys(h, "keep me")
    await chord(h, "e")
    expect(h.text()).toContain("set $VISUAL or $EDITOR")
    expect(h.app.editor.text).toBe("keep me")

    const failing = launcher(() => ({ ok: false, reason: "exit-code", message: "vim exited with code 1; prompt left as it was" }))
    const again = await appHarness({ editorLauncher: failing.load })
    await again.start()
    await typeKeys(again, "keep me too")
    await chord(again, "e")
    expect(again.text()).toContain("vim exited with code 1")
    expect(again.app.editor.text).toBe("keep me too")
  })

  test("a launcher that cannot be loaded is reported", async () => {
    const h = await appHarness({
      editorLauncher: async () => {
        throw new Error("Cannot find package")
      },
    })
    await h.start()
    await chord(h, "e")
    expect(h.text()).toContain("external editor is not available")
  })
})

describe("copying an answer", () => {
  test("osc52Copy encodes the text, and wraps it for tmux with every ESC doubled", () => {
    expect(osc52Copy("héllo")).toBe(`\x1b]52;c;${Buffer.from("héllo").toString("base64")}\x07`)
    expect(osc52Copy("x", { tmux: true })).toBe(`\x1bPtmux;\x1b\x1b]52;c;eA==\x07\x1b\\`)
    expect(osc52Copy("")).toBeUndefined()
    expect(osc52Copy("a".repeat(OSC52_MAX_BASE64))).toBeUndefined()
  })

  test("ctrl+x y writes an OSC 52 sequence with the last assistant answer", async () => {
    const h = await appHarness({ env: {} })
    await h.start()
    await chord(h, "y")
    expect(h.text()).toContain("no answer to copy yet")
    h.message("first question", "first answer")
    h.message("second question", "the **second** answer\nwith two lines")
    await chord(h, "y")
    expect(h.written).toEqual([osc52Copy("the **second** answer\nwith two lines")!])
    expect(h.text()).toContain("copied the last answer")
  })

  test("/copy 2 takes the answer before the last; a number past the start is a warning", async () => {
    const h = await appHarness({ env: { TMUX: "/tmp/tmux-1/default,1,0" } })
    await h.start()
    h.message("q1", "older answer")
    h.message("q2", "newer answer")
    await h.type("/copy 2")
    await h.key("\r")
    expect(h.written).toEqual([osc52Copy("older answer", { tmux: true })!])
    await h.type("/copy 3")
    await h.key("\r")
    expect(h.written).toHaveLength(1)
    expect(h.text()).toContain("only 2 answers so far")
  })
})

describe("turn bell", () => {
  async function withBell(on: boolean) {
    const { dataDir } = layout()
    writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, turnBell: on })
    const h = await appHarness({ dataDir })
    await h.start()
    return h
  }

  test("rings when a live turn completes or fails, never for a replayed one", async () => {
    const h = await withBell(true)
    h.event({ type: "turn.completed", turnId: "turn_a", at: NOW - 60_000 })
    expect(h.written).toEqual([])
    h.event({ type: "turn.completed", turnId: "turn_b", at: NOW })
    h.event({ type: "turn.failed", turnId: "turn_c", at: NOW + 1_000 })
    expect(h.written).toEqual(["\x07", "\x07"])
  })

  test("stays silent by default, and on a cancel", async () => {
    const off = await withBell(false)
    off.event({ type: "turn.completed", turnId: "turn_a", at: NOW })
    expect(off.written).toEqual([])
    const on = await withBell(true)
    on.event({ type: "turn.cancelled", turnId: "turn_a", at: NOW, by: "user" })
    expect(on.written).toEqual([])
  })

  test("a desktop notice goes out through OSC 9 or OSC 777 when a turn ends or asks for approval, and only then", async () => {
    for (const [mode, sequence] of [["osc9", "\x1b]9;MendCode: turn finished\x07"], ["osc777", "\x1b]777;notify;MendCode;turn finished\x07"]] as const) {
      const { dataDir } = layout()
      writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, turnNotify: mode })
      const h = await appHarness({ dataDir })
      await h.start()
      h.event({ type: "turn.completed", turnId: "turn_old", at: NOW - 60_000 })
      expect(h.written).toEqual([])
      h.event({ type: "turn.completed", turnId: "turn_a", at: NOW })
      expect(h.written).toEqual([sequence])
      h.event({ type: "turn.cancelled", turnId: "turn_b", at: NOW, by: "user" })
      expect(h.written).toHaveLength(1)
      h.event({ type: "server.request", requestId: "req_a", turnId: "turn_c", kind: "approval", title: "Run rm;\x1b[31m -rf", detail: "", at: NOW })
      expect(h.written[1]).toContain("needs approval: Run rm [31m -rf")
      expect(h.written[1]).not.toContain("\x1b[31m")
    }
    const { dataDir } = layout()
    const off = await appHarness({ dataDir })
    await off.start()
    off.event({ type: "turn.completed", turnId: "turn_a", at: NOW })
    expect(off.written).toEqual([])
  })

  test("/customize has a bell row that toggles and saves", async () => {
    const { dataDir } = layout()
    const h = await appHarness({ dataDir })
    await h.start()
    await h.type("/customize")
    await h.key("\r")
    for (let i = 0; i < CUSTOMIZE_ROWS.indexOf("turnBell"); i++) await h.key("\x1b[B")
    expect(h.text()).toContain("Bell")
    await h.key("\r")
    expect(JSON.parse(readFileSync(`${dataDir}/tui/profile.json`, "utf8")).turnBell).toBe(true)
  })
})
