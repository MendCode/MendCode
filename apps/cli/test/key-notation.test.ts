import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { Glob } from "bun"
import path from "node:path"
import { configureKeyLabels, resetKeyLabels } from "../src/ui/key-labels"
import { cleanTemps } from "./session-ui-harness"
import { chat, click, frame, settle } from "./file-viewer-helpers"

afterEach(() => { cleanTemps(); resetKeyLabels() })

/** Emacs notation for a key (`M-}`, `C-x`): no hint of the app is written like that, the key-label system words every key. */
const EMACS = /(?<![\w-])[MC]-(?:[A-Za-z]|[{}[\]^\\])(?![\w-])/

const SRC = path.join(import.meta.dir, "..", "src")

/** The string and template literals of a source line, comments left out. */
function literals(line: string): string[] {
  const code = line.trimStart()
  if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return []
  return [...line.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)].map((match) => match[1] ?? match[2] ?? match[3] ?? "")
}

describe("key notation", () => {
  test("no string literal of the view and ui code writes a key as M-x or C-x", () => {
    const hits: string[] = []
    for (const file of new Glob("**/*.ts").scanSync({ cwd: SRC })) {
      readFileSync(path.join(SRC, file), "utf8").split("\n").forEach((line, index) => {
        for (const text of literals(line)) if (EMACS.test(text)) hits.push(`${file}:${index + 1}: ${text}`)
      })
    }
    expect(hits).toEqual([])
  })

  test("the pattern finds what it must", () => {
    for (const bad of ["M-} focus", "M-{ switch", "^] focus M-] close", "C-x f", "press M-x"]) expect(EMACS.test(bad)).toBe(true)
    for (const fine of ["Sec-Fetch", "ctrl+x f", "opt+} focus", "mendcode-file-viewer-M", "x-C-y", "Content-Type"]) expect(EMACS.test(fine)).toBe(false)
  })

  async function frames(label: "mac" | "linux") {
    const panel = { rightSidebar: true, sidebarWidgets: [{ type: "context", options: {} }] } as const
    const { h } = await chat({ text: "see src/app.rs:120 and src/files and AGENTS.md", profile: panel })
    // A new app goes back to canonical hints, so the host the frames pretend to run on is set after it.
    configureKeyLabels({ setting: "auto", platform: label === "mac" ? "darwin" : "linux", altWorks: false })
    h.app.render()
    const seen: string[] = [frame(h)]
    await click(h, "src/app.rs:120")
    seen.push(frame(h))
    // Focused, then the other side of the switch, then back to the file, then a folder.
    await h.app.onKey("\x1b}")
    h.app.render()
    seen.push(frame(h))
    await h.app.onKey("\x1b{")
    h.app.render()
    seen.push(frame(h))
    await h.app.onKey("\x1b}")
    h.app.render()
    seen.push(frame(h))
    await h.app.onKey("\x1b{")
    h.app.render()
    await h.type("/open src\r")
    await settle()
    h.app.render()
    seen.push(frame(h))
    return seen
  }

  for (const label of ["mac", "linux"] as const) {
    test(`no frame of the panel or the viewer uses M-/C- notation (${label})`, async () => {
      const seen = await frames(label)
      for (const text of seen) for (const row of text.split("\n")) expect(EMACS.test(row)).toBe(false)
    })
  }

  test("on a Mac the hints say the Option key or its chord, never the Emacs name", async () => {
    const seen = (await frames("mac")).join("\n")
    expect(seen).toMatch(/opt\+\}|ctrl\+x/)
    expect(seen).not.toMatch(/M-[{}]/)
  })
})
