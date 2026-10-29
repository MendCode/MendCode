import { afterEach, describe, expect, test } from "bun:test"
import { createIdFactory, type ItemId, type SessionEvent, type TurnId } from "@mendcode/protocol"
import { glyphs } from "../src/ui/theme"
import { foldOf } from "../src/view/line-meta"
import { FOLD_CARD, FOLD_PAGE, FOLD_RUN, renderToolCard, TOOL_PAGE_LINES } from "../src/view/tool-card"
import { foldLabel, readDetail, readResult } from "../src/view/tool-summary"
import { createTranscript, type PresentationMode } from "../src/view/transcript"
import { DEFAULT_TUI_PROFILE, writeTuiProfile } from "../src/view/tui-profile"
import { textWidth } from "../src/view/wrap"
import { appHarness, cleanTemps, conversation, tempDir } from "./session-ui-harness"

const ids = createIdFactory()
const sessionId = ids("session")
const NOW = new Date(2026, 8, 28, 15, 50).getTime()

function stream() {
  let seq = 0
  let clock = NOW - 60_000
  const events: SessionEvent[] = []
  const emit = (event: Record<string, unknown>, advance = 100) => {
    clock += advance
    events.push({ sessionId, seq: ++seq, at: clock, ...event } as SessionEvent)
  }
  const turn = () => {
    const turnId = ids("turn")
    emit({ type: "turn.started", turnId, queueId: ids("queue") })
    return turnId
  }
  /** One finished (or running) tool call; `input` is the call's JSON arguments, `meta` what the tool reported. */
  const tool = (turnId: TurnId, title: string, text: string, options: { status?: string; input?: object; meta?: Record<string, unknown>; deltas?: string[] } = {}) => {
    const itemId = ids("item")
    emit({ type: "item.started", turnId, itemId, kind: "tool_call", meta: { tool: title } })
    for (const delta of options.deltas ?? []) emit({ type: "item.delta", itemId, text: delta })
    if (options.status !== "running") emit({ type: "item.completed", itemId, status: options.status ?? "ok", text, ...(options.input ? { toolInput: JSON.stringify(options.input) } : {}), ...(options.meta ? { meta: options.meta } : {}) })
    return itemId
  }
  return { emit, turn, tool, events }
}

/** These tests pin what each kind of card shows in each view; the full view's `toolDensity` is `dense` (the whole preview) unless a test says otherwise. */
function view(events: SessionEvent[], options: { mode?: PresentationMode; width?: number; height?: number; toolOutput?: string; toolDensity?: "calm" | "standard" | "dense" } = {}) {
  const t = createTranscript({ appearance: { messageLayout: "classic", messageMeta: "full" }, glyphs: glyphs({}), mode: options.mode ?? "balanced", now: () => NOW })
  t.setAppearance({ reasoning: "auto", toolOutput: (options.toolOutput ?? "auto") as "auto", toolDensity: options.toolDensity ?? "dense", timestamps: false })
  for (const event of events) t.apply(event)
  const rows = () => t.viewport(options.width ?? 100, options.height ?? 400)
  return { t, rows, text: () => rows().map((line) => line.text).filter((line) => line.trim()) }
}

const numbered = (count: number) => Array.from({ length: count }, (_, i) => `${String(i + 1).padStart(6)}\tline ${i + 1}`).join("\n")
const names = (count: number, prefix = "entry") => Array.from({ length: count }, (_, i) => `${prefix}${i}`).join("\n")
const matchesOf = (count: number) => Array.from({ length: count }, (_, i) => `src/file${i % 4}.ts:${i + 1}:const foo = ${i}`).join("\n")
const diff = (rows: number) => ["@@ -1,1 +1,1 @@", ...Array.from({ length: rows }, (_, i) => `+added ${i}`)].join("\n")

/** One call per turn, so no two of them fold. */
function calls(entries: Array<{ title: string; text: string; options?: Parameters<ReturnType<typeof stream>["tool"]>[3] }>) {
  const { turn, tool, events } = stream()
  const itemIds = entries.map((entry) => tool(turn(), entry.title, entry.text, entry.options))
  return { events, itemIds }
}

const READING = [
  { title: "ls: .", text: names(24) },
  { title: "read: README.md", text: numbered(142) },
  { title: "glob: src", text: "No files found", options: { input: { pattern: "**/AGENTS.md" } } },
  { title: "grep: src", text: matchesOf(12), options: { input: { pattern: "foo", path: "src" } } },
]

describe("reading tools in balanced: a header, and for a listing or a search a few rows in its own form", () => {
  test("Read is its header alone, List is columns, Grep is files with one matching line each", () => {
    const { events } = calls(READING)
    const text = view(events).text()
    expect(text).toEqual([
      "     ▦ List .  24 entries",
      "     │ entry0  entry3  entry6  entry9   entry12  entry15  entry18  entry21",
      "     │ entry1  entry4  entry7  entry10  entry13  entry16  entry19  entry22",
      "     │ entry2  entry5  entry8  entry11  entry14  entry17  entry20  entry23",
      "     ▤ Read README.md  142 lines",
      "     ✲ Glob **/AGENTS.md  no files",
      '     ⌕ Grep "foo"  12 matches in 4 files',
      "     │ src/file0.ts  3 matches",
      "     │ 1  const foo = 0",
      "     │ src/file1.ts  3 matches",
      "     │ 2  const foo = 1",
      "     │ src/file2.ts  3 matches",
      "     │ 3  const foo = 2",
      "     │ … +9 more matches",
    ])
  })

  test("counts come from the tool's own report when it sent one, else from its text", () => {
    expect(readResult({ name: "read", text: numbered(30), counts: { lines: 2000 } })).toBe("2,000 lines")
    expect(readResult({ name: "read", text: `${numbered(30)}\n[output truncated: 70 more lines]`, counts: {} })).toBe("30+ lines")
    expect(readResult({ name: "read", text: "<path>/a</path>\n<type>directory</type>\n<entries>\nb\n</entries>\n(1 of 1 entries)", counts: {} })).toBe("1 entry")
    expect(readResult({ name: "read", text: "Image read successfully", counts: {} })).toBe("image")
    expect(readResult({ name: "ls", text: "(empty)", counts: {} })).toBe("empty")
    expect(readResult({ name: "ls", text: `${names(3)}\n[output truncated: 1,200 more entries]`, counts: { entries: 3 } })).toBe("1,203 entries")
    expect(readResult({ name: "glob", text: "a.ts", counts: {} })).toBe("1 file")
    expect(readResult({ name: "grep", text: "No matches found", counts: {} })).toBe("no matches")
    expect(readResult({ name: "grep", text: "a.ts:3:x", counts: {} })).toBe("1 match in 1 file")
    expect(readDetail({ name: "ls", detail: "", pattern: undefined })).toBe(".")
    expect(readDetail({ name: "grep", detail: "src", pattern: "TODO" })).toBe('"TODO"')
  })

  test("a result that is long never reaches the screen in balanced", () => {
    const { events } = calls([{ title: "read: big.ts", text: numbered(5000) }])
    const text = view(events).text()
    expect(text).toEqual(["     ▤ Read big.ts  5,000 lines"])
  })

  test("web fetch says its host and size, an MCP result its shape; neither has a body in balanced", () => {
    const body = `# Docs home\n${names(30)}`
    const { events } = calls([{ title: "webfetch: https://x.dev/docs", text: body, options: { meta: { bytes: 2_100, status: 200 } } }, { title: "mcp__graft__graft_find_code: x", text: body }])
    const text = view(events).text()
    expect(text[0]).toBe("     ⌁ Fetch Docs home  x.dev · 2.1 KB")
    expect(text[1]).toStartWith("     ⊙ graft · graft_find_code x  text · ")
    expect(text).toHaveLength(2)
  })

  test("a page without a heading is named by where it came from; an error status says so", () => {
    const text = view(calls([{ title: "webfetch: https://x.dev/a/b?q=1", text: "plain words", options: { meta: { bytes: 11, status: 200 } } }]).events).text()
    expect(text[0]).toBe("     ⌁ Fetch x.dev/a/b?q=1  11 B")
    const failed = view(calls([{ title: "webfetch: https://x.dev/gone", text: "HTTP 404 Not Found\n\nnope", options: { status: "error", meta: { status: 404, bytes: 4 } } }]).events).text()
    expect(failed[0]).toBe("     ✗ Fetch x.dev/gone  HTTP 404")
    expect(failed[1]).toBe("     │ HTTP 404 Not Found")
  })

  test("a running call is its header, and a search shows its groups once it finishes", () => {
    const { turn, tool, emit, events } = stream()
    const turnId = turn()
    const itemId = tool(turnId, "grep: src", "", { status: "running", deltas: [`${matchesOf(12)}\n`] })
    const live = view(events).text()
    expect(live[0]).toContain("Grep src")
    expect(live.filter((line) => line.includes("const foo"))).toHaveLength(4)
    emit({ type: "item.completed", itemId, status: "ok", text: matchesOf(12), toolInput: JSON.stringify({ pattern: "foo" }) })
    expect(view(events).text()[0]).toBe('     ⌕ Grep "foo"  12 matches in 4 files')
  })
})

describe("reading tools in each view", () => {
  test("minimal folds everything into one muted line", () => {
    const { events } = calls(READING)
    expect(view(events, { mode: "minimal" }).text()).toEqual(["◆ 4 tools · grep: src ✓"])
  })

  test("the full view adds the first rows of the file, never its tail, then how many are left", () => {
    const { events } = calls(READING)
    const text = view(events, { mode: "full" }).text()
    const body = (head: string, next: string) => text.slice(text.findIndex((line) => line.includes(head)) + 1, text.findIndex((line) => line.includes(next)))
    expect(body("Read README", "Glob")).toEqual(["     │ 1  line 1", "     │ 2  line 2", "     │ 3  line 3", "     │ 4  line 4", "     │ 5  line 5", "     │ 6  line 6", "     │ … 136 more lines"])
    expect(text.some((line) => line.includes("line 142"))).toBe(false)
    expect(text.find((line) => line.includes("Glob"))).toContain("no files")
  })

  test("a partial read says its range and its excerpt starts where the read did, numbers aligned to the widest", () => {
    const rows = Array.from({ length: 12 }, (_, i) => `${String(95 + i).padStart(6)}\trow ${95 + i}`).join("\n")
    const text = view(calls([{ title: "read: a.ts", text: rows, options: { input: { path: "a.ts", offset: 95, limit: 12 } } }]).events, { mode: "full" }).text()
    expect(text[0]).toBe("     ▤ Read a.ts  L95–106")
    expect(text.slice(1, 7)).toEqual(["     │  95  row 95", "     │  96  row 96", "     │  97  row 97", "     │  98  row 98", "     │  99  row 99", "     │ 100  row 100"])
    expect(text.at(-1)).toBe("     │ … 6 more lines")
  })

  test("the toolOutput setting: collapsed keeps the header even in full, expanded shows the full view's bodies in balanced", () => {
    const { events } = calls(READING)
    expect(view(events, { mode: "full", toolOutput: "collapsed" }).text()).toEqual(["     ▦ List .  24 entries", "     ▤ Read README.md  142 lines", "     ✲ Glob **/AGENTS.md  no files", '     ⌕ Grep "foo"  12 matches in 4 files'])
    const expanded = view(events, { toolOutput: "expanded" }).text()
    expect(expanded).toEqual(view(events, { mode: "full" }).text())
  })
})

describe("a run of reading calls folds", () => {
  const run = (count: number, extra?: (api: ReturnType<typeof stream>, turnId: TurnId) => void) => {
    const api = stream()
    const turnId = api.turn()
    const found: ItemId[] = []
    for (let i = 0; i < count; i++) found.push(api.tool(turnId, ["read: a.ts", "ls: src", "grep: src"][i % 3]!, i % 3 === 1 ? names(5) : i % 3 === 0 ? numbered(20) : matchesOf(4), { input: { pattern: "foo" } }))
    extra?.(api, turnId)
    return { ...api, found }
  }

  test("three or more of one turn become `Read 5 files · List 2 · Grep 3`", () => {
    const api = stream()
    const turnId = api.turn()
    for (const [title, text] of [["read: a", numbered(3)], ["read: b", numbered(3)], ["read: c", numbered(3)], ["read: d", numbered(3)], ["read: e", numbered(3)], ["ls: x", names(2)], ["ls: y", names(2)], ["grep: z", matchesOf(2)], ["grep: z", matchesOf(2)], ["grep: z", matchesOf(2)]] as const) api.tool(turnId, title, text)
    expect(view(api.events).text()).toEqual(["     ◇ Read 5 files · List 2 · Grep 3"])
    expect(foldLabel(["read", "grep", "read"])).toBe("Read 2 files · Grep 1")
  })

  test("two calls do not fold", () => {
    const { events } = run(2)
    const text = view(events).text()
    expect(text.filter((line) => /[▤▦⌕]/.test(line))).toHaveLength(2)
    expect(text.some((line) => line.includes("◇"))).toBe(false)
  })

  test("clicking the row (or ctrl+x f) opens the run into its one-line rows, and again closes it", () => {
    const { events, found } = run(4)
    const { t, rows, text } = view(events)
    const head = rows().find((line) => line.text.includes("Read 2 files"))!
    expect(foldOf(head.spans)).toBe(FOLD_RUN)
    expect(head.itemId).toBe(found[0])
    t.toggleDetails(found[0]!, FOLD_RUN)
    expect(text()[0]).toContain("◆ Read 2 files")
    expect(text().filter((line) => /[▤▦⌕]/.test(line))).toHaveLength(4)
    t.toggleDetails(found[0]!, FOLD_RUN)
    expect(text()).toHaveLength(1)
  })

  test("a failed call, or a running one, ends the run and always shows", () => {
    const api = stream()
    const turnId = api.turn()
    for (let i = 0; i < 3; i++) api.tool(turnId, `read: f${i}`, numbered(2))
    api.tool(turnId, "read: broken.ts", "ENOENT: no such file", { status: "error" })
    for (let i = 0; i < 2; i++) api.tool(turnId, `read: g${i}`, numbered(2))
    api.tool(turnId, "grep: src", "", { status: "running", deltas: ["a.ts:1:x\n"] })
    const text = view(api.events).text()
    expect(text[0]).toBe("     ◇ Read 3 files")
    expect(text.some((line) => line.includes("broken.ts"))).toBe(true)
    expect(text.some((line) => line.includes("ENOENT"))).toBe(true)
    expect(text.some((line) => line.includes("g0"))).toBe(true)
    expect(text.some((line) => line.includes("Grep src"))).toBe(true)
  })

  test("calls of different turns, and a shell between them, do not fold together", () => {
    const api = stream()
    for (let i = 0; i < 2; i++) {
      const turnId = api.turn()
      api.tool(turnId, "read: a", numbered(1))
      api.tool(turnId, "read: b", numbered(1))
    }
    expect(view(api.events).text().filter((line) => line.includes("◇"))).toEqual([])
    const { turn, tool, events } = stream()
    const turnId = turn()
    tool(turnId, "read: a", numbered(1))
    tool(turnId, "read: b", numbered(1))
    tool(turnId, "shell: ls", "x")
    tool(turnId, "read: c", numbered(1))
    expect(view(events).text().filter((line) => line.includes("◇"))).toEqual([])
  })

  test("full view and ctrl+o do not fold", () => {
    const { events } = run(6)
    expect(view(events, { mode: "full" }).text().some((line) => line.includes("Read 2 files"))).toBe(false)
    const { t, text } = view(events)
    expect(text()).toHaveLength(1)
    t.toggleTools()
    expect(text().some((line) => line.includes("Read 2 files"))).toBe(false)
  })
})

describe("expanding a card", () => {
  test("clicking a one-line card opens its body, again closes it; only that card", () => {
    const { events, itemIds } = calls(READING)
    const { t, rows, text } = view(events)
    expect(foldOf(rows().find((line) => line.text.includes("Read README"))!.spans)).toBe(FOLD_CARD)
    const before = text()
    t.toggleDetails(itemIds[1]!, FOLD_CARD)
    const opened = text()
    expect(opened.some((line) => line.includes("line 40"))).toBe(true)
    expect(opened.some((line) => line.includes("line 41"))).toBe(false)
    // The other cards keep the rows they had.
    expect(opened.filter((line) => line.includes("entry"))).toEqual(before.filter((line) => line.includes("entry")))
    t.toggleDetails(itemIds[1]!, FOLD_CARD)
    expect(text()).toEqual(before)
  })

  test("an opened body is a page, with a footer that turns the page and finally closes the card", () => {
    const { events, itemIds } = calls([{ title: "read: huge.log", text: numbered(5000) }])
    const { t, rows, text } = view(events)
    t.toggleDetails(itemIds[0]!, FOLD_CARD)
    const first = text()
    expect(first.length).toBeLessThanOrEqual(TOOL_PAGE_LINES + 2)
    expect(first.at(-1)).toContain("lines 1-40 of 5000 · click or ctrl+x f for the next page")
    expect(foldOf(rows().at(-2)!.spans) ?? foldOf(rows().at(-1)!.spans)).toBe(FOLD_PAGE)
    t.toggleDetails(itemIds[0]!, FOLD_PAGE)
    const second = text()
    expect(second.at(-1)).toContain("lines 41-80 of 5000")
    expect(second.some((line) => line.includes("line 41"))).toBe(true)
    expect(second.some((line) => line.includes("line 40"))).toBe(false)
    for (let i = 0; i < 200; i++) t.toggleDetails(itemIds[0]!, FOLD_PAGE)
    expect(text().at(-1)).toContain("lines 4961-5000 of 5000 · click or ctrl+o to close")
    expect(text().length).toBeLessThanOrEqual(TOOL_PAGE_LINES + 2)
  })

  test("every kind of card opens on its first page and starts there again after it was paged and closed", () => {
    const kinds = [
      { title: "read: README.md", text: numbered(126), first: "line 1" },
      { title: "ls: .", text: names(126), first: "entry0" },
      { title: "grep: src", text: matchesOf(126), first: "const foo = 0", options: { input: { pattern: "foo", path: "src" } } },
      { title: "shell: make", text: names(126, "out"), first: "out0" },
      { title: "edit: src/a.ts", text: diff(126), first: "added 0" },
      { title: "mcp__graft__graft_find_code: x", text: names(126, "hit"), first: "hit0" },
    ]
    for (const kind of kinds) {
      const { events, itemIds } = calls([kind])
      const { t, text } = view(events)
      t.toggleDetails(itemIds[0]!, FOLD_CARD)
      const opened = text()
      expect(opened.at(-1)).toContain("lines 1-40 of ")
      expect(opened.some((line) => line.includes(kind.first))).toBe(true)
      t.toggleDetails(itemIds[0]!, FOLD_PAGE)
      t.toggleDetails(itemIds[0]!, FOLD_PAGE)
      expect(text().at(-1)).toContain("lines 81-120 of ")
      t.toggleDetails(itemIds[0]!, FOLD_CARD)
      t.toggleDetails(itemIds[0]!, FOLD_CARD)
      expect(text()).toEqual(opened)
    }
  })

  test("ctrl+o opens every card at once and again closes them; a card closed by hand stays closed", () => {
    const { events, itemIds } = calls(READING)
    const { t, text } = view(events)
    const before = text()
    t.toggleTools()
    const row = /^ {5}│ +\d+ {2}line \d+$/
    expect(text().length).toBeGreaterThan(40)
    expect(text().filter((line) => row.test(line))).toHaveLength(40)
    t.toggleDetails(itemIds[1]!, FOLD_CARD)
    expect(text().filter((line) => row.test(line))).toHaveLength(0)
    expect(text().filter((line) => line.includes("entry"))).not.toHaveLength(0)
    t.toggleTools()
    expect(text()).toEqual(before)
  })

  test("in the full view's calm density an earlier edit and write keep their diff and content while the reads fold to a row", () => {
    const { events } = calls([
      { title: "edit: src/a.ts", text: diff(5) },
      { title: "write: notes.txt", text: "Created notes.txt (6 bytes)", options: { input: { path: "notes.txt", content: "hello\n" } } },
      { title: "read: src/b.ts", text: names(20, "row") },
      { title: "read: src/c.ts", text: names(20, "row") },
    ])
    const shown = view(events, { mode: "full", toolDensity: "calm" }).text()
    expect(shown.filter((line) => /\+ added \d+/.test(line))).toHaveLength(5)
    expect(shown.some((line) => /1 \+ hello$/.test(line.trimEnd()))).toBe(true)
    const earlierRead = shown.findIndex((line) => line.includes("src/b.ts"))
    expect(shown[earlierRead + 1]).toContain("src/c.ts")
  })

  test("an edit's diff is 40 rows in balanced, as in the full view, and opens to a page", () => {
    const { events, itemIds } = calls([{ title: "edit: src/a.ts", text: diff(100) }])
    const { t, text } = view(events)
    expect(text().filter((line) => /\+ added \d+/.test(line))).toHaveLength(40)
    expect(text().at(-1)).toContain("+60 lines")
    t.toggleDetails(itemIds[0]!, FOLD_CARD)
    expect(text().filter((line) => /\+ added \d+/.test(line))).toHaveLength(40)
    expect(text().at(-1)).toContain("lines 1-40 of 100")
  })

  test("a write shows what it put in the file as added lines in balanced and full; minimal keeps it to its row", () => {
    const { events } = calls([{ title: "write: simple-write.txt", text: "Created simple-write.txt (28 bytes)", options: { input: { path: "simple-write.txt", content: "Prueba de escritura simple.\n" } } }])
    for (const mode of ["full", "balanced"] as const) {
      const shown = view(events, { mode }).text()
      expect(shown[0]).toMatch(/Write simple-write\.txt {2}created {2}28 B {2}\+1/)
      expect(shown[1]!.trimEnd()).toMatch(/1 \+ Prueba de escritura simple\.$/)
    }
    expect(view(events, { mode: "minimal" }).text().join("\n")).not.toContain("Prueba de escritura simple")
    // A long write shows the rows an edit's diff does in the full view (40) and says how many lines are left, counting those it did not keep.
    const long = calls([{ title: "write: big.txt", text: "Created big.txt (9000 bytes)", options: { input: { path: "big.txt", content: names(1000, "line") } } }])
    const shown = view(long.events, { mode: "full" }).text()
    expect(shown.filter((line) => /\+ line\d+/.test(line))).toHaveLength(40)
    expect(shown.at(-1)).toContain("+960 lines")
    // A call stored cut off at 4000 characters is not JSON: the card still shows the whole lines it has, then that more follow.
    const stored = JSON.stringify({ path: "big.txt", content: names(1000, "line \"q\"") }).slice(0, 4000)
    const cut = { ...long.events.at(-1)!, toolInput: stored } as SessionEvent
    const partial = view([...long.events.slice(0, -1), cut], { mode: "full" }).text()
    expect(partial[0]).toMatch(/Write big\.txt {2}created {2}9 KB$/)
    expect(partial[1]!.trimEnd()).toMatch(/1 \+ line "q"0$/)
    expect(partial.at(-1)).toContain("more lines")
    // Without the call's content (a result saved before it was kept) the card is its header, as before.
    expect(view(calls([{ title: "write: a.txt", text: "Created a.txt (3 bytes)" }]).events).text()).toHaveLength(1)
  })

  test("the expanded body of a card with thousands of lines costs one page of rows", () => {
    const { events, itemIds } = calls([{ title: "shell: yes", text: names(20_000, "row") }])
    const { t, text } = view(events)
    t.toggleDetails(itemIds[0]!, FOLD_CARD)
    expect(text().length).toBeLessThanOrEqual(TOOL_PAGE_LINES + 6)
  })
})

describe("shell", () => {
  test("a finished command shows the command line and its last 6 rows, with +N lines", () => {
    const { events } = calls([{ title: "shell: bun test", text: names(20, "out") }])
    const text = view(events, { width: 60 }).text()
    expect(text[0]).toContain("$ bun test")
    expect(text.filter((line) => /│ out\d+/.test(line))).toHaveLength(6)
    expect(text.some((line) => line.includes("out19"))).toBe(true)
    expect(text.some((line) => line.includes("out13"))).toBe(false)
    expect(text.some((line) => line.includes("+14 lines"))).toBe(true)
  })

  test("a short output has no +N row, and no output says so", () => {
    expect(view(calls([{ title: "shell: echo a", text: "a" }]).events).text().some((line) => line.includes("+"))).toBe(false)
    expect(view(calls([{ title: "shell: true", text: "" }]).events).text()).toEqual(["     $ true  no output"])
  })

  test("a failure shows its error tail, 12 rows, in every view but minimal, where it is one line", () => {
    const { events } = calls([{ title: "shell: make", text: names(30, "err"), options: { status: "error", meta: { exitCode: 2 } } }])
    for (const mode of ["balanced", "full"] as const) {
      const text = view(events, { mode }).text()
      expect(text[0]).toContain("exit 2")
      expect(text.filter((line) => /│ err\d+/.test(line))).toHaveLength(12)
      expect(text.some((line) => line.includes("err29"))).toBe(true)
      expect(text.some((line) => line.includes("+18 lines"))).toBe(true)
    }
    const minimal = view(events, { mode: "minimal" }).text()
    expect(minimal).toHaveLength(1)
    expect(minimal[0]).toContain("shell: make")
    expect(minimal[0]).toContain("err29")
  })

  test("a running command shows at most 4 rows live", () => {
    const { turn, tool, events } = stream()
    tool(turn(), "shell: yes", "", { status: "running", deltas: [`${names(20, "tick")}\n`] })
    const text = view(events, { width: 60 }).text()
    expect(text.filter((line) => /│ tick\d+/.test(line))).toHaveLength(4)
    expect(text.some((line) => line.includes("+16 earlier lines"))).toBe(true)
  })

  test("the full view shows 10 rows", () => {
    const { events } = calls([{ title: "shell: bun test", text: names(20, "out") }])
    expect(view(events, { mode: "full", width: 60 }).text().filter((line) => /│ out\d+/.test(line))).toHaveLength(10)
  })

  const LONG = "cd /Users/user/Code/repos/heltecv4/heltecv4-32bit-windows && bun scripts/build.ts --base-url https://github.com/Obed0101"

  test("a long command wraps under its rail in the full view, finished or running, with the duration after its last word", () => {
    const finished = calls([{ title: `shell: ${LONG}`, text: "built" }]).events
    const running = stream()
    running.tool(running.turn(), `shell: ${LONG}`, "", { status: "running" })
    for (const events of [finished, running.events]) {
      const text = view(events, { mode: "full", width: 60 }).text()
      expect(text[0]).toMatch(/^ {5}\S cd$/)
      // The continuation rows hang from the card's rail, aligned under the command; read back to back they are the whole command.
      expect(text.slice(0, 4).every((line, at) => at === 0 || /^ {5}│ \S/.test(line))).toBe(true)
      expect(text.slice(0, 4).join("").replace(/[│$⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏\s]/g, "")).toContain(LONG.replace(/\s/g, ""))
      expect(text.every((line) => textWidth(line) <= 60)).toBe(true)
      expect(text.some((line) => line.includes("…"))).toBe(false)
    }
  })

  test("the same command is one row ending in an ellipsis in the balanced view", () => {
    const text = view(calls([{ title: `shell: ${LONG}`, text: "built" }]).events, { width: 60 }).text()
    expect(text[0]).toContain("…")
    expect(textWidth(text[0]!)).toBeLessThanOrEqual(60)
    expect(text.filter((line) => line.includes("$"))).toHaveLength(1)
  })

  test("the rows of a wrapped command are soft-wrapped, with the rail as their gutter, so a copy joins them", () => {
    const { t } = view(calls([{ title: `shell: ${LONG}`, text: "built" }]).events, { mode: "full", width: 60 })
    const rows = t.viewport(60, 20).filter((line) => line.kind === "tool_call")
    expect(rows.length).toBeGreaterThan(3)
    expect(rows[1]!.soft).toBeDefined()
    expect(rows[1]!.gutter).toBeGreaterThanOrEqual(5)
  })

  test("a command of hundreds of words ends its eighth row in an ellipsis", () => {
    const text = view(calls([{ title: `shell: echo ${"word ".repeat(300)}`, text: "output" }]).events, { mode: "full", width: 60 }).text()
    const head = text.filter((line) => line.includes("word"))
    expect(head).toHaveLength(8)
    expect(head.at(-1)).toContain("…")
    expect(text.filter((line) => line.includes("…"))).toHaveLength(1)
  })

  test("a call titled with its whole command (the Claude Code engine) wraps in the full view and ends in an ellipsis in balanced", () => {
    const { events } = calls([{ title: LONG, text: "built" }])
    const full = view(events, { mode: "full", width: 60 }).text()
    expect(full[0]).toMatch(/^ {5}◆ cd$/)
    expect(full.slice(0, 4).join("").replace(/[│◆\s]/g, "")).toContain(LONG.replace(/\s/g, ""))
    const balanced = view(events, { width: 60 }).text()
    expect(balanced[0]).toContain("…")
    expect(balanced.every((line) => textWidth(line) <= 60)).toBe(true)
  })
})

describe("failures are never folded", () => {
  test("a failed reading call keeps its head and error message in every view", () => {
    const { events } = calls([{ title: "read: nope.ts", text: "ENOENT: nope.ts does not exist", options: { status: "error" } }])
    for (const mode of ["balanced", "full"] as const) expect(view(events, { mode }).text()).toEqual(["     ✗ Read nope.ts  failed", "     │ ENOENT: nope.ts does not exist"])
    expect(view(events, { mode: "minimal" }).text()[0]).toContain("ENOENT")
  })
})

describe("find sees what the cards hide", () => {
  test("a hit inside a folded run or a capped body opens it while the bar is up and puts it back after", () => {
    const api = stream()
    const turnId = api.turn()
    api.tool(turnId, "read: a.ts", numbered(60).replace("line 55", "needle 55"))
    api.tool(turnId, "ls: src", names(3))
    api.tool(turnId, "grep: src", matchesOf(3))
    const { t, text } = view(api.events)
    expect(text()).toHaveLength(1)
    expect(text().some((line) => line.includes("needle"))).toBe(false)
    t.revealFind("needle", 100)
    expect(text().some((line) => line.includes("needle 55"))).toBe(true)
    t.revealFind("needle 5", 100)
    expect(text().some((line) => line.includes("needle 55"))).toBe(true)
    t.revealFind("zzz", 100)
    expect(text()).toHaveLength(1)
    t.revealFind("needle", 100)
    t.endFind()
    expect(text()).toHaveLength(1)
  })

  test("the model's result and the transcript's text are untouched by the display", () => {
    const { events, itemIds } = calls([{ title: "read: big.ts", text: numbered(300) }])
    const { t } = view(events)
    const block = t.blocks().find((entry) => entry.itemId === itemIds[0])!
    expect(block.text.split("\n")).toHaveLength(300)
  })
})

describe("in the app", () => {
  afterEach(cleanTemps)

  async function app(mode: "minimal" | "balanced" | "full", size = { width: 100, height: 30 }) {
    const dataDir = tempDir()
    writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, toolDensity: "dense" })
    const h = appHarness({ dataDir, ...size })
    h.app.applySettings({ onboarded: true, view: mode })
    await Bun.sleep(10)
    const { emit } = conversation(h.sessionId, h.app.onEvent)
    const turnId = ids("turn")
    emit({ type: "turn.started", turnId, queueId: ids("queue") })
    const user = ids("item")
    emit({ type: "item.started", turnId, itemId: user, kind: "user_message" })
    emit({ type: "item.completed", itemId: user, status: "ok", text: "what is in this repo" })
    const call = (title: string, text: string, input?: object) => {
      const itemId = ids("item")
      emit({ type: "item.started", turnId, itemId, kind: "tool_call", meta: { tool: title } })
      emit({ type: "item.completed", itemId, status: "ok", text, ...(input ? { toolInput: JSON.stringify(input) } : {}) })
    }
    call("ls: .", names(24, "entry"))
    call("read: README.md", numbered(142))
    h.app.render()
    return { h, call, emit, turnId }
  }

  test("balanced prints the list as columns and the read as one header, never the whole file", async () => {
    const { h } = await app("balanced")
    const text = h.text().join("\n")
    expect(text).toContain("List .  24 entries")
    expect(text).toContain("entry0  entry3  entry6")
    expect(text).toContain("Read README.md  142 lines")
    expect(text).not.toContain("line 1\n")
    expect(text).not.toContain("line 20")
  })

  test("ctrl+o opens a page of each card and again folds them back", async () => {
    const { h } = await app("balanced", { width: 100, height: 60 })
    await h.type("\x0f")
    expect(h.text().join("\n")).toContain("entry23")
    expect(h.text().join("\n")).toContain("line 40")
    expect(h.text().join("\n")).not.toContain("line 41")
    await h.type("\x0f")
    expect(h.text().join("\n")).not.toContain("line 40")
  })

  test("an opened card starts on its first page and keeps its header in view; a quick second click on its footer does not turn the page", async () => {
    for (const exchanges of [0, 14]) {
      let clock = 1_000_000
      const h = appHarness({ dataDir: tempDir(), width: 200, height: 60, now: () => clock })
      h.app.applySettings({ onboarded: true, view: "balanced" })
      await Bun.sleep(10)
      const chat = conversation(h.sessionId, h.app.onEvent)
      for (let i = 0; i < exchanges; i++) chat.exchange(`question ${i}`, `answer ${i}`)
      const turnId = ids("turn")
      chat.emit({ type: "turn.started", turnId, queueId: ids("queue") })
      const itemId = ids("item")
      chat.emit({ type: "item.started", turnId, itemId, kind: "tool_call", meta: { tool: "read: README.md" } })
      chat.emit({ type: "item.completed", itemId, status: "ok", text: numbered(126) })
      h.app.render()
      const row = h.text().findIndex((line) => line.includes("Read README.md"))
      const col = h.text()[row]!.indexOf("Read") + 3
      const footer = () => h.text().filter((line) => line.includes(" of 126"))
      const click = async (at: number) => {
        await h.type(`\x1b[<0;${col};${at + 1}M`)
        await h.type(`\x1b[<0;${col};${at + 1}m`)
      }
      await click(row)
      expect(footer()).toHaveLength(1)
      expect(footer()[0]).toContain("lines 1-40 of 126")
      expect(h.text().some((line) => line.includes("Read README.md"))).toBe(true)
      // The same spot again: a card at the bottom of the view has its footer there. It must not turn the page; one that grew downward closes.
      await click(row)
      expect(footer().every((line) => line.includes("lines 1-40 of 126"))).toBe(true)
      // Later, the footer is a real control.
      clock += 2_000
      const at = h.text().findIndex((line) => line.includes("lines 1-40 of 126"))
      if (at >= 0) {
        await click(at)
        expect(footer()[0]).toContain("lines 41-80 of 126")
        await click(h.text().findIndex((line) => line.includes("Read README.md")))
        expect(footer()).toHaveLength(0)
        await click(h.text().findIndex((line) => line.includes("Read README.md")))
        expect(footer()[0]).toContain("lines 1-40 of 126")
      }
    }
  })

  test("a card taller than the screen opens at its header, not at its end", async () => {
    const h = appHarness({ dataDir: tempDir(), width: 100, height: 20 })
    h.app.applySettings({ onboarded: true, view: "balanced" })
    await Bun.sleep(10)
    const chat = conversation(h.sessionId, h.app.onEvent)
    for (let i = 0; i < 6; i++) chat.exchange(`question ${i}`, `answer ${i}`)
    const turnId = ids("turn")
    chat.emit({ type: "turn.started", turnId, queueId: ids("queue") })
    const itemId = ids("item")
    chat.emit({ type: "item.started", turnId, itemId, kind: "tool_call", meta: { tool: "read: README.md" } })
    chat.emit({ type: "item.completed", itemId, status: "ok", text: numbered(126) })
    h.app.render()
    const row = h.text().findIndex((line) => line.includes("Read README.md"))
    await h.type(`\x1b[<0;${h.text()[row]!.indexOf("Read") + 3};${row + 1}M`)
    await h.type(`\x1b[<0;${h.text()[row]!.indexOf("Read") + 3};${row + 1}m`)
    const text = h.text().join("\n")
    expect(text).toContain("Read README.md  126 lines")
    expect(text).toContain("│  1  line 1")
    expect(text).not.toContain("lines 121-126")
  })

  test("the full view shows the head of the file and minimal folds the turn", async () => {
    const full = (await app("full", { width: 100, height: 60 })).h.text().join("\n")
    expect(full).toContain("entry0  entry3")
    expect(full).toContain("… 136 more lines")
    expect(full).toContain("│ 6  line 6")
    expect(full).not.toContain("line 7\n")
    const minimal = (await app("minimal")).h.text().join("\n")
    expect(minimal).toContain("2 tools")
    expect(minimal).not.toContain("entry5")
  })
})

test("a graph result saved before detail nodes draws the map only, opened or not", () => {
  const render = { type: "stack" as const, children: [
    { type: "graph" as const, root: "repo", edges: [{ from: "repo", to: "apps", label: "dir" }], title: "Project map" },
    { type: "text" as const, text: "Hub symbols", bold: true },
    { type: "list" as const, items: Array.from({ length: 22 }, (_, i) => `hub${i} a/b.ts:${i} callers:${i}`) },
  ] }
  const text = (expanded: boolean) => renderToolCard({ title: "graph_map", text: "", status: "ok", width: 100, render, expanded, frame: 0, tailLines: 4 }).map((line) => line.map((span) => span.text).join("")).join("\n")
  expect(text(false)).toContain("Project map")
  expect(text(false)).not.toContain("hub3")
  expect(text(true)).toContain("Project map")
  expect(text(true)).not.toContain("hub3")
  expect(text(true)).not.toContain("Hub symbols")
})
