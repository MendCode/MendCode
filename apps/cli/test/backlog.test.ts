import { describe, expect, test } from "bun:test"
import { createIdFactory, type BacklogItem } from "@mendcode/protocol"
import { parseAutomation, runAutomation, SCHEMA, type Automation, type AutomationDeps } from "../src/automation"
import { guardClient } from "../src/agent-origin"
import { createApp } from "../src/ui/app"
import { glyphs, type Line } from "../src/ui/theme"
import { backlogCard, backlogChangeText, backlogCount, backlogLines, parseBacklogWords } from "../src/view/backlog"
import { SLASH_COMMANDS, takesArguments } from "../src/view/commands"
import { PANEL_PRESETS, SIDEBAR_PRESETS, WIDGET_TYPES, sidebarSpec } from "../src/view/sidebar-spec"
import { lineWidth } from "../src/view/wrap"

const ids = createIdFactory()
const NOW = 1_800_000_000_000
const text = (line: Line) => line.map((span) => span.text).join("")
const item = (id: number, words: string, patch: Partial<BacklogItem> = {}): BacklogItem => ({ id, text: words, done: false, createdAt: NOW, ...patch })
const ITEMS = [
  item(1, "fix the flaky store test", { origin: { sessionId: "ses_a1", path: "packages/store/src/store.ts", commit: "a1b2c3d4e5" } }),
  item(2, "rename the --dir flag", { done: true, doneAt: NOW }),
  item(3, "write the migration notes for the new settings key"),
]

describe("/backlog words", () => {
  test("list, add with an origin, the id verbs and clear", () => {
    expect(parseBacklogWords([])).toEqual({ kind: "list" })
    expect(parseBacklogWords(["list"])).toEqual({ kind: "list" })
    expect(parseBacklogWords(["add", "fix", "the", "test"], { sessionId: "ses_1" })).toEqual({ kind: "change", change: { op: "add", text: "fix the test", origin: { sessionId: "ses_1" } } })
    expect(parseBacklogWords(["add", "--file", "src/a.ts", "--commit", "abc1234", "look", "at", "--this"])).toEqual({ kind: "change", change: { op: "add", text: "look at --this", origin: { path: "src/a.ts", commit: "abc1234" } } })
    expect(parseBacklogWords(["add", "plain"])).toEqual({ kind: "change", change: { op: "add", text: "plain" } })
    expect(parseBacklogWords(["done", "#3"])).toEqual({ kind: "change", change: { op: "done", id: 3 } })
    expect(parseBacklogWords(["reopen", "3"])).toEqual({ kind: "change", change: { op: "reopen", id: 3 } })
    expect(parseBacklogWords(["rm", "2"])).toEqual({ kind: "change", change: { op: "remove", id: 2 } })
    expect(parseBacklogWords(["open", "1"])).toEqual({ kind: "open", id: 1 })
    expect(parseBacklogWords(["clear"])).toEqual({ kind: "change", change: { op: "clear-done" } })
  })

  test("what does not parse says why", () => {
    const why = (...words: string[]) => { const parsed = parseBacklogWords(words); return parsed.kind === "error" ? parsed.message : "" }
    expect(why("add")).toBe("add needs the item's text")
    expect(why("add", "x".repeat(301))).toBe("an item takes at most 300 characters (this one has 301)")
    expect(why("add", "--commit", "nope", "x")).toContain("commit hash")
    expect(why("add", "--file")).toBe("--file needs a value")
    expect(why("done")).toBe("done needs one item number")
    expect(why("done", "two")).toBe("done needs one item number")
    expect(why("clear", "all")).toContain("removes the finished items")
    expect(why("purge")).toBe("unknown backlog word: purge")
  })

  test("the slash command is /backlog, takes arguments and belongs to the feature; nothing collides with it", () => {
    const command = SLASH_COMMANDS.find((entry) => entry.name === "backlog")!
    expect(command).toMatchObject({ group: "context", feature: "backlog", aliases: [] })
    expect(takesArguments(command)).toBe(true)
    expect(SLASH_COMMANDS.filter((entry) => entry.name === "backlog" || entry.aliases.includes("backlog"))).toHaveLength(1)
    expect(SLASH_COMMANDS.some((entry) => entry.name === "todo" || entry.name === "todos" || entry.name === "board")).toBe(false)
  })
})

describe("backlog text", () => {
  test("lines list open items first with where each was born; the count and the change lines are one sentence", () => {
    expect(backlogLines(ITEMS)).toEqual([
      "#1 [ ] fix the flaky store test  (packages/store/src/store.ts · a1b2c3d · session ses_a1)",
      "#3 [ ] write the migration notes for the new settings key",
      "#2 [x] rename the --dir flag",
    ])
    expect(backlogCount(ITEMS)).toBe("2 open · 1 done")
    expect(backlogChangeText({ op: "add", text: "x" }, { added: 4, items: [] })).toBe("backlog: added #4")
    expect(backlogChangeText({ op: "done", id: 2 }, { items: [] })).toBe("backlog: #2 done")
    expect(backlogChangeText({ op: "reopen", id: 2 }, { items: [] })).toBe("backlog: #2 open again")
    expect(backlogChangeText({ op: "remove", id: 2 }, { items: [] })).toBe("backlog: #2 removed")
    expect(backlogChangeText({ op: "clear-done" }, { items: [ITEMS[0]!] }, ITEMS)).toBe("backlog: cleared 2 finished items")
    expect(backlogChangeText({ op: "clear-done" }, { items: ITEMS }, ITEMS)).toBe("backlog: nothing finished to clear")
  })
})

describe("the backlog card", () => {
  const card = (items: readonly BacklogItem[] | undefined, width: number, patch: { off?: boolean; ascii?: boolean } = {}) => backlogCard({ items, width, glyphs: glyphs(patch.ascii ? { ascii: true } as never : {}), off: patch.off }).map(text)

  test("wide: the count, open items first, then the finished one", () => {
    expect(card(ITEMS, 56)).toEqual([
      "2 open · 1 done",
      "□ #1 fix the flaky store test",
      "□ #3 write the migration notes for the new settings key",
      "✓ #2 rename the --dir flag",
    ])
  })

  test("narrow: every row fits the width and keeps its number", () => {
    const rows = backlogCard({ items: ITEMS, width: 24, glyphs: glyphs({}) })
    expect(rows.every((row) => lineWidth(row) <= 24)).toBe(true)
    expect(rows.map(text)).toEqual(["2 open · 1 done", "□ #1 fix the flaky stor…", "□ #3 write the migratio…", "✓ #2 rename the --dir f…"])
    expect(backlogCard({ items: ITEMS, width: 8, glyphs: glyphs({}) }).every((row) => lineWidth(row) <= 15)).toBe(true)
  })

  test("past six rows finished items leave first and the last line says how many are not shown", () => {
    const many = [...Array.from({ length: 5 }, (_, n) => item(n + 1, `open ${n + 1}`)), ...Array.from({ length: 4 }, (_, n) => item(n + 6, `done ${n + 6}`, { done: true }))]
    const rows = card(many, 40)
    expect(rows[0]).toBe("5 open · 4 done")
    expect(rows.slice(1, 7)).toEqual(["□ #1 open 1", "□ #2 open 2", "□ #3 open 3", "□ #4 open 4", "□ #5 open 5", "✓ #6 done 6"])
    expect(rows[7]).toBe("+3 more · /backlog")
    const allOpen = card(Array.from({ length: 9 }, (_, n) => item(n + 1, `open ${n + 1}`)), 40)
    expect(allOpen).toHaveLength(8)
    expect(allOpen[7]).toBe("+3 more · /backlog")
  })

  test("empty, unread and off states are one muted line each", () => {
    expect(card([], 48)).toEqual(["Nothing pending · /backlog add <text>"])
    expect(card(undefined, 48)).toEqual(["Reading the backlog…"])
    expect(card(ITEMS, 48, { off: true })).toEqual(["Backlog is off · /tier backlog on"])
    expect(backlogCard({ items: [], width: 20, glyphs: glyphs({}) }).every((row) => lineWidth(row) <= 20 && row.every((span) => span.fg === "muted"))).toBe(true)
    expect(card([item(1, "only", { done: true })], 30)).toEqual(["0 open · 1 done", "✓ #1 only"])
  })

  test("is a card type the panel accepts by name, and no preset includes it", () => {
    expect((WIDGET_TYPES as readonly string[]).includes("backlog")).toBe(true)
    expect(sidebarSpec([{ type: "backlog", options: {} }])).toEqual([{ type: "backlog", options: {} }])
    for (const preset of PANEL_PRESETS) expect(SIDEBAR_PRESETS[preset].some((widget) => widget.type === "backlog")).toBe(false)
  })
})

describe("/backlog in the app", () => {
  function harness(settings: Record<string, unknown> = { tier: "full" }) {
    const frames: Line[][] = []
    const sent: Array<Record<string, unknown>> = []
    let items: BacklogItem[] = []
    let next = 1
    const id = ids("session")
    const screen = { size: { width: 180, height: 40 }, draw: (rows: Line[]) => void frames.push(rows), setTitle() {} } as unknown as Parameters<typeof createApp>[0]["screen"]
    const send = async (command: Record<string, unknown>) => {
      sent.push(command)
      if (command.type === "backlog.get") return { ok: true, result: { directory: "/work/app", items } }
      if (command.type === "backlog.change") {
        const change = command.change as { op: string; text?: string; id?: number; origin?: BacklogItem["origin"] }
        if (change.op === "add") items = [...items, item(next++, change.text!, change.origin ? { origin: change.origin } : {})]
        else if (change.op === "done") items = items.map((entry) => entry.id === change.id ? { ...entry, done: true } : entry)
        else if (change.op === "remove") items = items.filter((entry) => entry.id !== change.id)
        else if (change.op === "clear-done") items = items.filter((entry) => !entry.done)
        return { ok: true, result: { directory: "/work/app", items, ...(change.op === "add" ? { added: next - 1 } : {}) } }
      }
      return { ok: true }
    }
    const app = createApp({ sessionId: id, screen, directory: "/work/app", exit() {}, schedule: (fn: () => void) => fn(), glyphs: glyphs({}), now: () => NOW, mode: "full", send } as never)
    app.applySettings(settings as never)
    const all = () => { app.render(); return frames.at(-1)!.map(text).join("\n") }
    /** Types a line and enter, then waits until the screen shows `shows` (the command answers after a daemon reply). */
    const type = async (line: string, shows: string) => {
      for (const key of line) app.onKey(key)
      app.onKey("\r")
      for (let waited = 0; waited < 3_000 && !all().includes(shows); waited += 5) await new Promise((resolve) => setTimeout(resolve, 5))
    }
    return { app, type, id, sent: (kind: string) => sent.filter((command) => command.type === kind), all }
  }

  test("add records the session it was typed in, done and clear change the list, and the list opens as a page", async () => {
    const h = harness()
    await h.type("/backlog add --file src/a.ts fix the flaky test", "backlog: added #1")
    expect(h.sent("backlog.change")[0]).toEqual({ type: "backlog.change", directory: "/work/app", change: { op: "add", text: "fix the flaky test", origin: { sessionId: h.id, path: "src/a.ts" } } })
    expect(h.all()).toContain("backlog: added #1")
    await h.type("/backlog add second thing", "backlog: added #2")
    await h.type("/backlog done 1", "backlog: #1 done")
    expect(h.all()).toContain("backlog: #1 done")
    await h.type("/backlog clear", "backlog: cleared 1 finished item")
    expect(h.all()).toContain("backlog: cleared 1 finished item")
    await h.type("/backlog add --file docs/x.md third thing", "backlog: added #3")
    await h.type("/backlog done 3", "backlog: #3 done")
    await h.type("/backlog", "1 open · 1 done")
    const page = h.all()
    expect(page).toContain("Backlog")
    expect(page).toContain("1 open · 1 done")
    expect(page).toContain("#2 [ ] second thing")
    expect(page).toContain(`#3 [x] third thing  (docs/x.md · session ${h.id})`)
    expect(h.sent("backlog.change").map((command) => (command.change as { op: string }).op)).toEqual(["add", "add", "done", "clear-done", "add", "done"])
  })

  test("a word that does not parse sends nothing and says the usage", async () => {
    const h = harness()
    await h.type("/backlog done", "done needs one item number")
    expect(h.sent("backlog.change")).toEqual([])
    expect(h.all()).toContain("done needs one item number")
  })
})

describe("mendcode backlog", () => {
  const parsed = (...argv: string[]): Automation => {
    const result = parseAutomation(argv)
    if (result.ok !== true) throw new Error(`not parsed: ${JSON.stringify(result)}`)
    return result.command
  }
  const failure = (...argv: string[]) => { const result = parseAutomation(argv); return result.ok === false ? result.message : "" }
  function harness(send: (command: Record<string, unknown>) => unknown) {
    const out: string[] = [], err: string[] = [], sent: Array<Record<string, unknown>> = []
    const deps = { client: { send: async (command: Record<string, unknown>) => (sent.push(command), send(command)) } as never, listen() {}, out: { write: (chunk: string) => void out.push(chunk) }, err: { write: (chunk: string) => void err.push(chunk) }, now: () => NOW, cwd: "/work/app" } as unknown as AutomationDeps
    return { deps, out, err, sent }
  }

  test("parses list, add with its origin flags, the id verbs and clear", () => {
    expect(parsed("backlog")).toMatchObject({ kind: "backlog", words: { kind: "list" }, json: false })
    expect(parsed("backlog", "list", "--json")).toMatchObject({ kind: "backlog", words: { kind: "list" }, json: true })
    expect(parsed("backlog", "add", "--file", "src/a.ts", "--commit", "abc1234", "--session", "ses_9", "fix", "it")).toMatchObject({ words: { kind: "change", change: { op: "add", text: "fix it", origin: { sessionId: "ses_9", path: "src/a.ts", commit: "abc1234" } } } })
    expect(parsed("backlog", "done", "3")).toMatchObject({ words: { change: { op: "done", id: 3 } } })
    expect(parsed("backlog", "remove", "3")).toMatchObject({ words: { change: { op: "remove", id: 3 } } })
    expect(parsed("backlog", "clear")).toMatchObject({ words: { change: { op: "clear-done" } } })
    expect(failure("backlog", "add")).toBe("backlog: add needs the item's text")
    expect(failure("backlog", "open", "1")).toContain("terminal UI")
    expect(failure("backlog", "nope")).toContain("unknown backlog word")
  })

  test("list prints the count and one line per item; --json prints the report", async () => {
    const report = { directory: "/work/app", items: ITEMS }
    const human = harness(() => ({ ok: true, result: report }))
    expect(await runAutomation(parsed("backlog", "list"), human.deps)).toBe(0)
    expect(human.sent).toEqual([{ type: "backlog.get", directory: "/work/app" }])
    expect(human.out.join("")).toBe("2 open · 1 done\n#1 [ ] fix the flaky store test  (packages/store/src/store.ts · a1b2c3d · session ses_a1)\n#3 [ ] write the migration notes for the new settings key\n#2 [x] rename the --dir flag\n")
    const json = harness(() => ({ ok: true, result: report }))
    await runAutomation(parsed("backlog", "list", "--json"), json.deps)
    expect(JSON.parse(json.out.join(""))).toEqual({ schema: SCHEMA, kind: "result", command: "backlog", data: report })
    const empty = harness(() => ({ ok: true, result: { directory: "/work/app", items: [] } }))
    await runAutomation(parsed("backlog"), empty.deps)
    expect(empty.out.join("")).toBe("Nothing pending\n")
  })

  test("add, done and remove send one change for this directory and say what happened", async () => {
    const add = harness(() => ({ ok: true, result: { directory: "/work/app", items: [item(4, "fix it")], added: 4 } }))
    await runAutomation(parsed("backlog", "add", "fix", "it"), add.deps)
    expect(add.sent).toEqual([{ type: "backlog.change", directory: "/work/app", change: { op: "add", text: "fix it" } }])
    expect(add.out.join("")).toBe("backlog: added #4\n")
    const done = harness(() => ({ ok: true, result: { directory: "/work/app", items: [] } }))
    await runAutomation(parsed("backlog", "done", "4", "--json"), done.deps)
    expect(JSON.parse(done.out.join(""))).toMatchObject({ kind: "result", command: "backlog", data: { items: [] } })
    const off = harness(() => ({ ok: false, error: { code: "invalid_command", message: "[DAEMON]: the project backlog is off (/tier backlog on)" } }))
    expect(await runAutomation(parsed("backlog", "list"), off.deps)).not.toBe(0)
    expect(off.err.join("")).toContain("the project backlog is off")
  })

  test("from a session's own shell the list is read and every write is refused before it is sent", async () => {
    const sent: string[] = []
    const client = guardClient({ send: async (command: { type: string }) => (sent.push(command.type), { ok: true, result: { directory: "/work/app", items: ITEMS } }) } as never, ["backlog", "add", "left undone: the docs"])
    const run = async (...argv: string[]) => {
      const out: string[] = [], err: string[] = []
      const code = await runAutomation(parsed(...argv), { client, listen() {}, out: { write: (chunk: string) => void out.push(chunk) }, err: { write: (chunk: string) => void err.push(chunk) }, now: () => NOW, cwd: "/work/app" } as unknown as AutomationDeps)
      return { code, out: out.join(""), err: err.join("") }
    }
    expect((await run("backlog", "list")).out).toContain("#1 [ ] fix the flaky store test")
    for (const argv of [["backlog", "add", "left undone: the docs"], ["backlog", "done", "1"], ["backlog", "remove", "1"], ["backlog", "clear"]]) {
      const refused = await run(...argv)
      expect(refused.code).not.toBe(0)
      expect(refused.err).toContain("needs backlog.change, which only the user decides")
    }
    expect(sent).toEqual(["backlog.get"])
  })
})
