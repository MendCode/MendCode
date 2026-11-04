import { afterAll, expect, test } from "bun:test"
import { appHarness, cleanTemps } from "./session-ui-harness"
import { repoSections, type RepoRow } from "../src/view/repo-output"
import { createTextPageState, renderTextPage, textPageRows } from "../src/view/text-page"
import { lineWidth } from "../src/view/wrap"
import { themeSelection, setTheme, sgr } from "../src/ui/theme"

afterAll(cleanTemps)
const watches: RepoRow[] = [
  { directory: "/work/alpha", state: "watching", role: "requested", open: 12, publish: "allowed" },
  { directory: "/work/beta", state: "paused", role: "all", open: 3, publish: "denied" },
  { directory: "/work/old", state: "ended (stopped)", role: "config", open: 0, publish: "not asked" },
]
const report = Array.from({ length: 70 }, (_, n) => `Repository report line ${n}: all details remain readable`).join("\n")

for (const [width, height] of [[80, 24], [100, 30], [200, 60]]) {
  for (const minimal of [false, true]) test(`repository page golden ${width}x${height}, minimal=${minimal}`, () => {
    const state = createTextPageState({ title: "Repository watches", summary: "[ ] select · s stop · r restart · R refresh", sections: repoSections(watches, 0, report) })
    const frame = renderTextPage({ state, width: width!, height: height!, minimal })
    expect(frame).toHaveLength(height!)
    expect(frame.every((row) => lineWidth(row) <= width!)).toBe(true)
    expect(frame.map((row) => row.map((span) => span.text).join("")).join("\n")).toMatchSnapshot()
    expect(textPageRows(state, width! - 4).flatMap((row) => row.map((span) => span.text)).join("\n")).toContain("Repository report line 69")
    if (minimal) expect(frame.flatMap((row) => row.map((span) => span.text)).join("")).not.toMatch(/[╭╮╰╯│]/)
  })
}

test("repos opens a table, scrolls to the complete report, and actions target the selected directory", async () => {
  const h = appHarness({ width: 100, height: 30, reply: (command) => command.type === "pr.review" ? { ok: true, result: { watches, text: report } } : undefined })
  await h.type("/pr repos\r")
  expect(h.text().join("\n")).toContain("Directory")
  await h.app.onKey("G")
  expect(h.text().join("\n")).toContain("Repository report line 69")
  await h.app.onKey("]")
  await h.app.onKey("s")
  expect(h.sentOf("pr.review").at(-1)).toMatchObject({ action: "unwatch-repo", directory: "/work/beta" })
  await h.app.onKey("r")
  expect(h.sentOf("pr.review").at(-1)).toMatchObject({ action: "watch-repo", directory: "/work/beta", role: "all" })
  await h.app.onKey("\x1b")
  expect(h.text().join("\n")).not.toContain("Repository watches")
})

test("/pr review [pr] full asks the daemon to review the head again whole; without it, no full flag is sent", async () => {
  const h = appHarness({ reply: (command) => command.type === "pr.review" ? { ok: true, result: { text: "ok" } } : undefined })
  await h.type("/pr review 7 full\r")
  expect(h.sentOf("pr.review").at(-1)).toMatchObject({ action: "review", pr: "7", full: true })
  await h.type("/pr review full\r")
  expect(h.sentOf("pr.review").at(-1)).toMatchObject({ action: "review", full: true })
  expect(h.sentOf("pr.review").at(-1)).not.toHaveProperty("pr")
  await h.type("/pr review 7\r")
  expect(h.sentOf("pr.review").at(-1)).not.toHaveProperty("full")
})

test("long daemon replies and notices use a scrollable page, short confirmations do not", async () => {
  const h = appHarness({ reply: (command) => command.type === "pr.review" ? { ok: true, result: { text: report } } : undefined })
  await h.type("/pr review 7\r")
  expect(h.text().join("\n")).toContain("F4 full text")
  await h.app.onKey("\x1bOS")
  expect(h.text().join("\n")).toContain("esc back")
  await h.app.onKey("G")
  expect(h.text().join("\n")).toContain("Repository report line 69")
  const short = appHarness({ reply: (command) => command.type === "pr.review" ? { ok: true, result: { text: "watch started" } } : undefined })
  await short.type("/pr watch-repo\r")
  expect(short.text().join("\n")).toContain("watch started")
  expect(short.text().join("\n")).not.toContain("esc back")
  const notice = appHarness()
  await notice.type("/theme not-a-theme\r")
  await notice.app.onKey("\x1bOS")
  expect(notice.text().join("\n")).toContain("Command output")
})

test("F4 preserves the open repository page and draft, including after scrolling", async () => {
  const h = appHarness({ reply: (command) => command.type === "pr.review" ? { ok: true, result: { watches, text: report } } : undefined })
  await h.type("/pr review 7\r")
  await h.type("my draft")
  await h.app.onKey("\x1bOS")
  await h.app.onKey("G")
  await h.app.onKey("\x1b")
  expect(h.app.editor.text).toBe("my draft")
  h.app.editor.clear()
  await h.type("/pr repos\r")
  await h.app.onKey("G")
  await h.app.onKey("\x1bOS")
  await h.app.onKey("\x1b")
  expect(h.text().join("\n")).toContain("Repository report line 69")
})

test("repository colors resolve in light and dark themes, ended watches remain secondary", () => {
  const before = themeSelection()
  try {
    for (const theme of ["mend", "paper"]) {
      expect(setTheme(theme)).toBe(true)
      const frame = renderTextPage({ state: createTextPageState({ title: "Repositories", sections: repoSections(watches, 0, report) }), width: 100, height: 30 })
      const ended = frame.flat().find((span) => span.text.includes("/work/old"))!
      expect(ended.fg).toBe("muted")
      expect(sgr(ended, "truecolor")).toContain("38;2;")
    }
  } finally { setTheme(before) }
})
