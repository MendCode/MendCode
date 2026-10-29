import { expect, test } from "bun:test"
import { findFileRefs, parseOpenTarget, rangeLabel, refAt, resolveRef } from "../src/view/file-ref"

const refs = (text: string) => findFileRefs(text).map(({ raw, line, endLine }) => ({ raw, ...(line ? { line } : {}), ...(endLine ? { endLine } : {}) }))

test("a file with a line, a line and column, and a range are references", () => {
  expect(refs("see src/app.rs:120 now")).toEqual([{ raw: "src/app.rs", line: 120 }])
  expect(refs("at src/ui.rs:300:5.")).toEqual([{ raw: "src/ui.rs", line: 300 }])
  expect(refs("in src/files/link.rs:56-79 there")).toEqual([{ raw: "src/files/link.rs", line: 56, endLine: 79 }])
})

test("GitHub style anchors give lines and ranges", () => {
  expect(refs("DESIGN.md#L10-L20")).toEqual([{ raw: "DESIGN.md", line: 10, endLine: 20 }])
  expect(refs("docs/layout.md#L7")).toEqual([{ raw: "docs/layout.md", line: 7 }])
  expect(refs("docs/layout.md#L7C3-L9C1")).toEqual([{ raw: "docs/layout.md", line: 7, endLine: 9 }])
})

test("relative, home and absolute paths, with backticks and trailing punctuation", () => {
  expect(refs("open ./AGENTS.md, then `src/index.ts`.")).toEqual([{ raw: "./AGENTS.md" }, { raw: "src/index.ts" }])
  expect(refs("(see /Users/me/project/src/a.ts:9)")).toEqual([{ raw: "/Users/me/project/src/a.ts", line: 9 }])
  expect(refs("~/notes/todo.md; ../sibling/file.go!")).toEqual([{ raw: "~/notes/todo.md" }, { raw: "../sibling/file.go" }])
  expect(refs("**`packages/daemon/src/file-view.ts`**")).toEqual([{ raw: "packages/daemon/src/file-view.ts" }])
})

test("a path wrapped in quotes or brackets still ends cleanly", () => {
  expect(refs('"src/a.ts" and [src/b.ts] and <src/c.ts>')).toEqual([{ raw: "src/a.ts" }, { raw: "src/b.ts" }, { raw: "src/c.ts" }])
})

test("bare names count for known extensions and known files only", () => {
  expect(refs("edit package.json and README.md and Makefile")).toEqual([{ raw: "package.json" }, { raw: "README.md" }, { raw: "Makefile" }])
  // `Node.js` has a known extension: it is a candidate, and opens only if the file exists (a click on it that finds nothing says nothing).
  expect(refs("e.g. this, i.e. that, Node.js and a.b and v1.2")).toEqual([{ raw: "Node.js" }])
})

test("URLs, Rust paths, dates, versions and prose are not references", () => {
  expect(refs("https://example.com/docs/config.md and http://localhost:3000/a/b.ts")).toEqual([])
  expect(refs("use std::collections::HashMap; and std::io::Result")).toEqual([])
  expect(refs("2026/10/07 and 1.2.3/4.5 and and/or and yes/no")).toEqual([])
  expect(refs("a word and a sentence. Another one!")).toEqual([])
  expect(refs("file:///etc/hosts is a URL")).toEqual([])
})

test("refAt finds the reference under a character, including its line suffix", () => {
  const text = "look at src/app.rs:120-130 please"
  const at = text.indexOf("app")
  expect(refAt(text, at)).toMatchObject({ raw: "src/app.rs", line: 120, endLine: 130 })
  expect(refAt(text, text.indexOf("130"))).toMatchObject({ raw: "src/app.rs" })
  expect(refAt(text, 0)).toBeUndefined()
  expect(refAt(text, text.length - 2)).toBeUndefined()
})

test("references resolve against the session directory and stay in the workspace", () => {
  const context = { cwd: "/work/proj", home: "/home/me", roots: ["/work/proj", "/work/extra"] }
  expect(resolveRef({ raw: "src/a.ts", line: 3 }, context)).toEqual({ ok: true, root: "/work/proj", path: "src/a.ts", absolute: "/work/proj/src/a.ts", line: 3 })
  expect(resolveRef({ raw: "./AGENTS.md" }, context)).toMatchObject({ ok: true, path: "AGENTS.md" })
  expect(resolveRef({ raw: "/work/proj/x/../y.ts" }, context)).toMatchObject({ ok: true, path: "y.ts" })
  expect(resolveRef({ raw: "/work/extra/notes.md" }, context)).toMatchObject({ ok: true, root: "/work/extra", path: "notes.md" })
  expect(resolveRef({ raw: "../outside.ts" }, context)).toMatchObject({ ok: false, reason: "outside" })
  expect(resolveRef({ raw: "/etc/hosts" }, context)).toMatchObject({ ok: false, reason: "outside" })
  expect(resolveRef({ raw: "~/notes/todo.md" }, context)).toMatchObject({ ok: false, reason: "outside" })
  expect(resolveRef({ raw: "/work/proj-evil/a.ts" }, context)).toMatchObject({ ok: false, reason: "outside" })
  expect(resolveRef({ raw: "/work/proj" }, context)).toMatchObject({ ok: true, path: "." })
  expect(resolveRef({ raw: "~/x.md" }, { cwd: "/work/proj", roots: ["/work/proj"] })).toMatchObject({ ok: false })
  expect(resolveRef({ raw: "~/p/a.ts" }, { cwd: "/work/proj", home: "/home/me", roots: ["/home/me/p"] })).toMatchObject({ ok: true, root: "/home/me/p", path: "a.ts" })
})

test("/open targets take the same spellings, with an optional @", () => {
  expect(parseOpenTarget("src/app.rs:120")).toEqual({ raw: "src/app.rs", line: 120 })
  expect(parseOpenTarget("src/app.rs:56-79")).toEqual({ raw: "src/app.rs", line: 56, endLine: 79 })
  expect(parseOpenTarget("@src/app.rs:7:3")).toEqual({ raw: "src/app.rs", line: 7 })
  expect(parseOpenTarget(" `DESIGN.md#L10-L20` ")).toEqual({ raw: "DESIGN.md", line: 10, endLine: 20 })
  expect(parseOpenTarget("src/app.rs")).toEqual({ raw: "src/app.rs" })
  expect(parseOpenTarget("   ")).toBeUndefined()
  expect(rangeLabel(5)).toBe("5")
  expect(rangeLabel(5, 9)).toBe("5-9")
})
