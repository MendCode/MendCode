import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { editExternally, resolveEditor, splitCommand } from "../src/index"

const made: string[] = []
function scratch() {
  const dir = mkdtempSync(path.join(tmpdir(), "mendcode-editor-test-"))
  made.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** An "editor" that is a shell script: it runs `body` with the file as $1. */
function fakeEditor(body: string) {
  const file = path.join(scratch(), "fake-editor.sh")
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
  return file
}

describe("resolveEditor", () => {
  test("VISUAL wins over EDITOR; blanks count as unset", () => {
    expect(resolveEditor({ VISUAL: "vim", EDITOR: "nano" })).toBe("vim")
    expect(resolveEditor({ VISUAL: "  ", EDITOR: "nano" })).toBe("nano")
    expect(resolveEditor({ EDITOR: "nano" })).toBe("nano")
    expect(resolveEditor({})).toBeUndefined()
  })
})

describe("splitCommand", () => {
  test("splits on spaces and keeps quoted words together", () => {
    expect(splitCommand("code --wait")).toEqual(["code", "--wait"])
    expect(splitCommand(`"/Applications/My Editor/bin/ed" -w 'a b'`)).toEqual(["/Applications/My Editor/bin/ed", "-w", "a b"])
    expect(splitCommand("  vim   ")).toEqual(["vim"])
    expect(splitCommand("a\\ b c")).toEqual(["a b", "c"])
    expect(splitCommand("")).toEqual([])
  })
})

describe("editExternally", () => {
  test("hands the text to the editor, reads the saved file back and drops the final newline", () => {
    const editor = fakeEditor(`printf 'first line\\nsecond line\\n' > "$1"`)
    const result = editExternally({ text: "draft", env: { EDITOR: editor } })
    expect(result).toEqual({ ok: true, text: "first line\nsecond line", changed: true })
  })

  test("the editor sees the prompt text in the file it is given", () => {
    const seen = path.join(scratch(), "seen.txt")
    const editor = fakeEditor(`cat "$1" > "${seen}"`)
    const result = editExternally({ text: "what I typed\nover two lines", env: { VISUAL: editor } })
    expect(readFileSync(seen, "utf8")).toBe("what I typed\nover two lines")
    expect(result).toEqual({ ok: true, text: "what I typed\nover two lines", changed: false })
  })

  test("extra words in the editor command are passed before the file", () => {
    const seen = path.join(scratch(), "args.txt")
    const editor = fakeEditor(`printf '%s|%s' "$1" "$(basename "$2")" > "${seen}"`)
    editExternally({ text: "x", editor: `${editor} --wait` })
    expect(readFileSync(seen, "utf8")).toBe("--wait|prompt.md")
  })

  test("suspend runs before the editor and resume after it, even when the editor fails", () => {
    const order: string[] = []
    const marker = path.join(scratch(), "ran.txt")
    const editor = fakeEditor(`echo ran > "${marker}"; exit 3`)
    const result = editExternally({
      text: "x",
      editor,
      suspend: () => order.push(existsSync(marker) ? "suspend-late" : "suspend"),
      resume: () => order.push(existsSync(marker) ? "resume" : "resume-early"),
    })
    expect(order).toEqual(["suspend", "resume"])
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("exit-code")
      expect(result.message).toContain("code 3")
    }
  })

  test("a missing editor program is reported and still resumes the terminal", () => {
    let resumed = false
    const result = editExternally({ text: "x", editor: "/nonexistent/mendcode-editor", resume: () => (resumed = true) })
    expect(resumed).toBe(true)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(["spawn-failed", "exit-code"]).toContain(result.reason)
  })

  test("no VISUAL or EDITOR is a clear failure that never touches the terminal", () => {
    let touched = false
    const result = editExternally({ text: "x", env: {}, suspend: () => (touched = true), resume: () => (touched = true) })
    expect(result).toMatchObject({ ok: false, reason: "no-editor" })
    expect(touched).toBe(false)
  })

  test("the temporary file is removed after success and after failure", () => {
    const tmp = scratch()
    editExternally({ text: "x", tmpDir: tmp, editor: fakeEditor(`echo done > "$1"`) })
    expect(readdirSync(tmp)).toEqual([])
    editExternally({ text: "x", tmpDir: tmp, editor: fakeEditor("exit 1") })
    expect(readdirSync(tmp)).toEqual([])
  })

  test("the temporary file is private to the user", () => {
    const mode = path.join(scratch(), "mode.txt")
    const editor = fakeEditor(`ls -l "$1" | cut -c1-10 > "${mode}"`)
    editExternally({ text: "secret", editor })
    expect(readFileSync(mode, "utf8").trim()).toBe("-rw-------")
  })
})
