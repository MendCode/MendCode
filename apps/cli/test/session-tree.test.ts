import { afterEach, describe, expect, test } from "bun:test"
import type { CommandInput, CommandReply } from "@mendcode/client"
import type { ItemId, SessionId, SessionTreeNode, TimelineEntry } from "@mendcode/protocol"
import { menuCatalog } from "../src/view/slash-menu"
import { buildTree, treeCounts, treeRows, type TreeFilter, type TreeModel } from "../src/view/session-tree"
import { createTreeState, settle, treeKey, type TreeState } from "../src/view/session-tree-keys"
import { renderTreePage, statsText, treeHints } from "../src/view/session-tree-page"
import { DEFAULT_TUI_PROFILE } from "../src/view/tui-profile"
import { appHarness, cleanTemps, conversation, ids, NOW, plain, tempDir } from "./session-ui-harness"

afterEach(cleanTemps)

const node = (input: Partial<SessionTreeNode> & { sessionId: SessionId }): SessionTreeNode => ({ title: "untitled", directory: "/project", createdAt: NOW - 60_000, updatedAt: NOW - 30_000, archived: false, current: false, labels: [], kind: "fork", ...input })
const message = (index: number, extra: Partial<TimelineEntry> = {}): TimelineEntry => ({ turnId: ids("turn"), itemId: ids("item"), at: NOW - (100 - index) * 60_000, preview: `question ${index}`, reverted: false, ...extra })
const lines = (model: TreeModel, state: Partial<TreeState> = {}) => treeRows(model, { filter: "all", query: "", folded: [], ...state }).map((row) => `${row.prefix}${row.node.kind === "session" ? row.node.session.title : row.node.kind === "mark" ? `◆ ${row.node.mark!.label}` : `#${row.node.number} ${row.node.entry!.preview}`}`)

/** A family: the open session `main` with five messages, a fork cut at the second, a sub-agent started during the fourth with a child of its own, and a bookmarked message of the fork. */
function family(main: SessionId = ids("session")) {
  const fork = ids("session"), agent = ids("session"), nested = ids("session")
  const entries = [1, 2, 3, 4, 5].map((index) => message(index))
  const nodes = [
    node({ sessionId: main, title: "Main work", current: true, state: "idle", createdAt: NOW - 500 * 60_000, updatedAt: NOW }),
    node({ sessionId: fork, parentId: main, atItemId: entries[1]!.itemId, atPreview: "question 2", title: "fork: Main work", unmerged: 2, createdAt: NOW - 90 * 60_000, labels: [{ itemId: ids("item"), label: "risky", preview: "port everything" }] }),
    node({ sessionId: agent, parentId: main, title: "scan the repo", kind: "task", agent: "explore", model: "claude-haiku", state: "completed", headline: "Found 3 entry points", createdAt: NOW - 96 * 60_000 + 30_000 }),
    node({ sessionId: nested, parentId: agent, title: "read the daemon", kind: "task", agent: "general", model: "gpt-6-luna", state: "running", createdAt: NOW - 96 * 60_000 + 40_000 }),
  ]
  return { main, fork, agent, nested, entries, nodes, model: buildTree({ sessionId: main, entries, nodes }) }
}

describe("the model", () => {
  test("is one tree: messages, the fork under the message it was cut at, a sub-agent under the message it began during, bookmarks of other sessions", () => {
    const { model } = family()
    expect(lines(model)).toEqual([
      "Main work",
      "├─ #1 question 1",
      "├─ #2 question 2",
      "│  └─ fork: Main work",
      "│     └─ ◆ risky",
      "├─ #3 question 3",
      "├─ #4 question 4",
      "│  └─ scan the repo",
      "│     └─ read the daemon",
      "└─ #5 question 5",
    ])
  })

  test("marks the open place once: the newest message that was not undone, or the session when it has none", () => {
    const { model, entries, main, nodes } = family()
    expect(treeRows(model, { filter: "all", query: "", folded: [] }).filter((row) => row.here).map((row) => row.key)).toEqual([`m:${entries[4]!.itemId}`])
    const undone = buildTree({ sessionId: main, entries: entries.map((entry, index) => index === 4 ? { ...entry, reverted: true } : entry), nodes })
    expect(treeRows(undone, { filter: "all", query: "", folded: [] }).find((row) => row.here)?.node.entry?.preview).toBe("question 4")
    const empty = buildTree({ sessionId: main, entries: [], nodes })
    expect(treeRows(empty, { filter: "all", query: "", folded: [] }).filter((row) => row.here).map((row) => row.key)).toEqual([`s:${main}`])
  })

  test("hangs a fork cut at an unknown message, or copied whole, under the last message that began before it", () => {
    const main = ids("session"), whole = ids("session")
    const entries = [message(1), message(2), message(3)]
    const model = buildTree({ sessionId: main, entries, nodes: [node({ sessionId: main, current: true, title: "Main" }), node({ sessionId: whole, parentId: main, title: "whole copy", createdAt: entries[1]!.at + 1_000 })] })
    expect(lines(model)).toEqual(["Main", "├─ #1 question 1", "├─ #2 question 2", "│  └─ whole copy", "└─ #3 question 3"])
  })

  test("keeps the messages when the family is unavailable (a token that cannot read it)", () => {
    const main = ids("session")
    const model = buildTree({ sessionId: main, entries: [message(1), message(2)], nodes: undefined, title: "Solo" })
    expect(lines(model)).toEqual(["Solo", "├─ #1 question 1", "└─ #2 question 2"])
    expect(treeCounts(model)).toEqual({ messages: 2, branches: 0, agents: 0, running: 0, bookmarked: 0 })
  })

  test("filters: messages only, branches & agents with the cut message as a note, bookmarked only", () => {
    const { model } = family()
    expect(lines(model, { filter: "messages" })).toEqual(["Main work", "├─ #1 question 1", "├─ #2 question 2", "├─ #3 question 3", "├─ #4 question 4", "└─ #5 question 5"])
    expect(lines(model, { filter: "branches" })).toEqual(["Main work", "├─ fork: Main work", "└─ scan the repo", "   └─ read the daemon"])
    expect(lines(model, { filter: "labeled" })).toEqual(["Main work", "└─ #2 question 2", "   └─ fork: Main work", "      └─ ◆ risky"])
    const labeled = buildTree({ sessionId: family().main, entries: [message(1, { label: "start" }), message(2)], nodes: undefined, title: "Solo" })
    expect(lines(labeled, { filter: "labeled" })).toEqual(["Solo", "└─ #1 question 1"])
  })

  test("search keeps the ancestors of a hit, ignores folds, and finds sub-agents by agent name", () => {
    const { model, entries } = family()
    expect(lines(model, { query: "DAEMON" })).toEqual(["Main work", "└─ #4 question 4", "   └─ scan the repo", "      └─ read the daemon"])
    expect(lines(model, { query: "explore" })).toContain("   └─ scan the repo")
    expect(lines(model, { query: "zzz" })).toEqual([])
    const folded = lines(model, { folded: [`m:${entries[3]!.itemId}`] })
    expect(folded).not.toContain("│  └─ scan the repo")
    expect(lines(model, { folded: [`m:${entries[3]!.itemId}`], query: "daemon" })).toContain("      └─ read the daemon")
  })

  test("counts what the summary line says", () => {
    expect(treeCounts(family().model)).toEqual({ messages: 5, branches: 1, agents: 2, running: 1, bookmarked: 1 })
  })
})

describe("the keys", () => {
  const { model, entries, fork } = family()
  const press = (state: TreeState, ...keys: string[]) => keys.reduce((acc, key) => { const result = treeKey(acc.state, key, model); return { state: result.state, actions: [...acc.actions, result.action] } }, { state, actions: [] as ReturnType<typeof treeKey>["action"][] })
  const start = () => settle(createTreeState(), model)

  test("start on the open place; arrows move and clamp; home and end go to the ends", () => {
    let state = start()
    expect(treeRows(model, state)[state.selected]!.here).toBe(true)
    state = press(state, "\x1b[B").state
    expect(state.selected).toBe(treeRows(model, state).length - 1)
    state = press(state, "\x1b[H").state
    expect(state.selected).toBe(0)
    state = press(state, "\x1b[A").state
    expect(state.selected).toBe(0)
    expect(press(state, "\x1b[F").state.selected).toBe(treeRows(model, state).length - 1)
  })

  test("left folds a branch point, then goes to the parent; right unfolds, then steps in", () => {
    let state = start()
    state = press(state, "\x1b[A", "\x1b[A", "\x1b[A").state
    expect(treeRows(model, state)[state.selected]!.node.entry?.preview).toBe("question 4")
    state = press(state, "\x1b[D").state
    expect(state.folded).toEqual([`m:${entries[3]!.itemId}`])
    expect(treeRows(model, state).some((row) => row.node.session.title === "scan the repo")).toBe(false)
    state = press(state, "\x1b[D").state
    expect(treeRows(model, state)[state.selected]!.node.session.title).toBe("Main work")
    // Down to the folded message, which a right arrow opens again.
    const folded = treeRows(model, state).findIndex((row) => row.folded)
    state = press(state, "\x1b[C", ...Array(folded - 1).fill("\x1b[B")).state
    expect(treeRows(model, state)[state.selected]!.node.entry?.preview).toBe("question 4")
    state = press(state, "\x1b[C").state
    expect(state.folded).toEqual([])
    expect(treeRows(model, state)[state.selected + 1]!.node.session.title).toBe("scan the repo")
    expect(press(state, "\x1b[C").state.selected).toBe(state.selected + 1)
  })

  test("tab and shift+tab cycle the filter and stay on the node when it is still shown", () => {
    let state = start()
    const order: TreeFilter[] = []
    for (let i = 0; i < 4; i++) {
      state = press(state, "\t").state
      order.push(state.filter)
      if (i === 0) expect(treeRows(model, state)[state.selected]!.here).toBe(true)
    }
    expect(order).toEqual(["messages", "branches", "labeled", "all"])
    expect(press(state, "\x1b[Z").state.filter).toBe("labeled")
  })

  test("typing searches, lands on the first match, backspace and ctrl+u shorten it, esc clears it before it closes", () => {
    let state = press(start(), "d", "a", "e").state
    expect(state.query).toBe("dae")
    expect(treeRows(model, state)[state.selected]!.node.session.title).toBe("read the daemon")
    state = press(state, "\x7f").state
    expect(state.query).toBe("da")
    state = press(state, "\x15").state
    expect(state.query).toBe("")
    state = press(state, "scan").state
    expect(state.query).toBe("scan")
    const cleared = treeKey(state, "\x1b", model)
    expect(cleared.state.query).toBe("")
    expect(cleared.action).toEqual({ type: "none" })
    expect(treeRows(model, cleared.state)[cleared.state.selected]!.node.session.title).toBe("scan the repo")
    expect(treeKey(cleared.state, "\x1b", model).action).toEqual({ type: "close" })
  })

  test("enter, ctrl+f, ctrl+l, ctrl+y, ctrl+r, ctrl+b and ctrl+a report what the node allows", () => {
    const at = (title: string) => { let state = press(start(), title).state; return state }
    const onMessage = start()
    expect(treeKey(onMessage, "\r", model).action).toEqual({ type: "jump", entry: entries[4] })
    expect(treeKey(onMessage, "\x06", model).action).toEqual({ type: "fork", entry: entries[4] })
    expect(treeKey(onMessage, "\x01", model).action).toEqual({ type: "actions", entry: entries[4] })
    expect(treeKey(onMessage, "\x19", model).action).toMatchObject({ type: "copy" })
    const typing = treeKey(onMessage, "\x0c", model)
    expect(typing.state.label).toBe("")
    const saved = press(typing.state, "good ", "one", "\r")
    expect(saved.actions.at(-1)).toMatchObject({ type: "label", text: "good one" })
    expect(saved.state.label).toBeUndefined()
    expect(press(typing.state, "x", "\x1b").state.label).toBeUndefined()
    const onFork = at("fork: Main")
    expect(treeKey(onFork, "\r", model).action).toMatchObject({ type: "open", node: { session: { sessionId: fork } } })
    expect(treeKey(onFork, "\x12", model).action).toMatchObject({ type: "summary" })
    expect(treeKey(onFork, "\x02", model).action).toMatchObject({ type: "merge" })
    expect(treeKey(onFork, "\x06", model).action).toEqual({ type: "warn", text: "select a message to fork at" })
    expect(treeKey(onFork, "\x0c", model).action).toEqual({ type: "warn", text: "select a message to bookmark" })
  })

  test("a bookmark in progress takes only text, backspace, enter and esc", () => {
    const typing = treeKey(start(), "\x0c", model).state
    const after = press(typing, "ab", "\x7f", "\t", "\x1b[A", "\x06").state
    expect(after.label).toBe("a")
    expect(after.filter).toBe("all")
  })

  test("the header lists only keys that work on the selected node", () => {
    const rows = treeRows(model, createTreeState())
    const hints = (index: number, pick = false, narrow = false) => treeHints(rows[index], createTreeState(), pick, narrow)
    expect(hints(0)).toContain("^R recap")
    expect(hints(0)).not.toContain("^F")
    expect(hints(0)).toContain("←→ fold")
    expect(hints(0)).not.toContain("^B")
    const messageRow = rows.findIndex((row) => row.node.kind === "message" && !row.foldable)
    expect(hints(messageRow)).toContain("^F fork")
    expect(hints(messageRow)).toContain("^A actions")
    expect(hints(messageRow)).not.toContain("←→")
    expect(hints(messageRow, true)).not.toContain("^F")
    expect(hints(messageRow, true)).toContain("enter fork here")
    expect(hints(rows.findIndex((row) => row.node.session.sessionId === fork && row.node.kind === "session"))).toContain("^B merge")
    expect(hints(rows.findIndex((row) => row.node.session.title === "scan the repo"))).not.toContain("^B")
    expect(treeHints(rows[0], { ...createTreeState(), label: "x" }, false)).toContain("enter save")
  })
})

describe("the page", () => {
  test("reads cost from the stats: tokens in and out, and active time", () => {
    expect(statsText({ input: 9000, output: 3100, cacheRead: 50000, ms: 192_000, turns: 3 })).toBe("12.1K tok · 3m 12s")
    expect(statsText({ input: 0, output: 0, cacheRead: 0, ms: 0, turns: 0 })).toBe("")
    expect(statsText(undefined)).toBe("")
  })

  test("loading, an error and an empty session are each said plainly", () => {
    const state = createTreeState()
    const page = (model: TreeModel | undefined, error?: string, filter: TreeFilter = "all") => renderTreePage({ model, ...(error ? { error } : {}), state: { ...state, filter }, width: 100, height: 20, now: NOW }).map(plain).join("\n")
    expect(page(undefined)).toContain("loading tree…")
    expect(page(undefined, "no such session")).toContain("no such session")
    const empty = buildTree({ sessionId: ids("session"), entries: [], nodes: undefined, title: "Solo" })
    expect(page(empty, undefined, "messages")).toContain("no messages in this session yet")
    expect(page(empty, undefined, "labeled")).toContain("no bookmarks yet")
    expect(renderTreePage({ model: empty, state: { ...state, query: "zz" }, width: 100, height: 20, now: NOW }).map(plain).join("\n")).toContain('no match for "zz"')
  })

  test("every page is exactly the size asked for, at narrow and wide widths, with the selected row in view", () => {
    const { model, main } = family()
    const many = buildTree({ sessionId: main, entries: Array.from({ length: 60 }, (_, index) => message(index + 1)), nodes: [node({ sessionId: main, current: true, title: "A very long session title that must be cut to fit the narrow panel" })] })
    for (const [width, height] of [[40, 12], [60, 14], [60, 20], [100, 20], [160, 50]] as const) {
      for (const shown of [model, many]) {
        const state = settle(createTreeState(), shown)
        const rows = renderTreePage({ model: shown, state, width, height, now: NOW })
        expect(rows).toHaveLength(height)
        for (const row of rows) expect(Bun.stringWidth(plain(row))).toBeLessThanOrEqual(width)
        expect(rows.some((row) => plain(row).includes(shown === many ? "question 60" : "question 5"))).toBe(true)
      }
    }
  })
})

type Reply = (command: CommandInput) => CommandReply | undefined

function treeApp(options: { width?: number; height?: number; entries?: TimelineEntry[]; nodes?: SessionTreeNode[]; reply?: Reply; tier?: "minimalist" | "balanced"; sessionId?: SessionId } = {}) {
  const sessionId = options.sessionId ?? ids("session")
  const state = { entries: options.entries ?? [], nodes: options.nodes ?? [] }
  const h = appHarness({ sessionId, dataDir: tempDir(), directory: "/project", width: options.width ?? 110, height: options.height ?? 30, reply: (command): CommandReply | undefined => {
    const custom = options.reply?.(command)
    if (custom) return custom
    if (command.type === "session.timeline") return { ok: true, result: { entries: state.entries } }
    if (command.type === "session.tree") return { ok: true, result: { current: sessionId, nodes: state.nodes } }
    if (command.type === "session.stats") return { ok: true, result: { stats: { turns: { total: 3, activeMs: 192_000 }, usage: { total: { input: 9000, output: 3100, cacheRead: 50_000 } } } } }
    if (command.type === "session.recap") return { ok: true, result: { text: "Goal: ship the tree\n- done: store\n- next: tests", at: NOW, cached: false } }
  } })
  h.app.applySettings({ onboarded: true, ...(options.tier ? { tier: options.tier } : {}) })
  return { h, state, sessionId }
}

/** The open session with a transcript of `count` exchanges and the daemon's answers for it. */
function talking(count: number, options: Parameters<typeof treeApp>[0] = {}) {
  const sessionId = ids("session")
  const app = treeApp({ ...options, sessionId })
  const talk = conversation(sessionId, app.h.app.onEvent)
  const exchanges = Array.from({ length: count }, (_, index) => talk.exchange(`question ${index + 1}`, `answer ${index + 1} ${"padding ".repeat(6)}`))
  app.state.entries = exchanges.map((exchange, index) => ({ turnId: exchange.turnId, itemId: exchange.itemId, at: NOW - (count - index) * 60_000, preview: `question ${index + 1}`, reverted: false }) as TimelineEntry)
  return { ...app, exchanges }
}

const screen = (h: ReturnType<typeof appHarness>) => h.text().join("\n")
const settleFrame = async (h: ReturnType<typeof appHarness>) => { await Bun.sleep(10); h.app.render() }

describe("/tree in the app", () => {
  test("opens on the newest message with the messages, the fork, the agents, what each cost and the keys that work", async () => {
    const sessionId = ids("session")
    const { fork, agent, nested, entries, nodes } = family(sessionId)
    const { h } = treeApp({ sessionId, entries, nodes })
    await h.type("/tree\r")
    await settleFrame(h)
    expect(h.app.page).toBe("tree")
    expect(h.sentOf("session.timeline").at(-1)).toEqual({ type: "session.timeline", sessionId })
    expect(h.sentOf("session.tree").at(-1)).toEqual({ type: "session.tree", sessionId })
    expect(h.sentOf("session.stats").map((command) => (command as { sessionId: string }).sessionId).sort()).toEqual([sessionId, fork, agent, nested].sort())
    const frame = screen(h)
    expect(frame).toContain("Tree")
    expect(frame).toContain("5 messages · 1 branch · 2 agents · 1 running")
    expect(frame).toContain("fork: Main work")
    expect(frame).toContain("+2 unmerged")
    expect(frame).toContain("◆ risky")
    expect(frame).toContain("scan the repo")
    expect(frame).toContain("explore · Haiku · completed")
    expect(frame).toContain("12.1K tok · 3m 12s")
    expect(h.text().find((row) => row.includes("❯"))).toContain("question 5")
    expect(frame).toContain("^F fork")
    expect(frame).not.toContain("^R recap")
  })

  test("enter on a message jumps the transcript to it", async () => {
    const { h } = talking(24)
    h.app.render()
    expect(screen(h)).not.toContain("question 1\n")
    await h.type("/tree\r")
    await h.type("\x1b[H")
    await h.type("\x1b[B")
    await h.type("\x1b[B")
    await h.type("\r")
    expect(h.app.page).toBe("chat")
    const rows = h.text()
    const first = rows.findIndex((row) => /question \d+/.test(row))
    expect(rows[first]).toContain("question 2")
  })

  test("enter on a sub-agent opens its session", async () => {
    const { h, state, sessionId } = talking(3)
    const agent = ids("session")
    state.nodes = [
      node({ sessionId, title: "Main work", current: true, updatedAt: NOW }),
      node({ sessionId: agent, parentId: sessionId, title: "scan the repo", kind: "task", agent: "explore", state: "completed", createdAt: NOW - 1_000 }),
    ]
    await h.type("/tree\r")
    await h.type("scan")
    await h.type("\r")
    expect(h.subscriptions.at(-1)?.sessionId).toBe(agent)
    expect(h.app.page).toBe("chat")
  })

  test("enter on a fork opens it, and enter on a bookmark of another session opens that session", async () => {
    const markItem = ids("item")
    const fork = ids("session")
    const open = async (query: string) => {
      const { h, state, sessionId } = talking(3)
      state.nodes = [
        node({ sessionId, title: "Main work", current: true }),
        node({ sessionId: fork, parentId: sessionId, atItemId: state.entries[0]!.itemId, title: "fork: Main work", labels: [{ itemId: markItem, label: "risky", preview: "port everything" }] }),
      ]
      await h.type("/tree\r")
      await h.type(query)
      await h.type("\r")
      return h
    }
    const forkRow = await open("fork: Main")
    expect(forkRow.subscriptions.at(-1)?.sessionId).toBe(fork)
    expect(forkRow.sentOf("client.unsubscribe").at(-1)).toMatchObject({ sessionId: forkRow.sessionId })
    const markRow = await open("risky")
    expect(markRow.subscriptions.at(-1)?.sessionId).toBe(fork)
  })

  test("ctrl+f forks at the message; /fork pick makes enter do it; neither is sent for an undone message", async () => {
    const forked = ids("session")
    const reply: Reply = (command) => command.type === "session.fork" ? { ok: true, result: { sessionId: forked, copied: 2, events: 9 } } : undefined
    const { h, exchanges } = talking(4, { reply })
    await h.type("/tree\r")
    await h.type("\x1b[A")
    await h.type("\x06")
    expect(h.sentOf("session.fork")).toEqual([{ type: "session.fork", sessionId: h.sessionId, atItemId: exchanges[2]!.itemId }])
    expect(h.app.sessionId).toBe(forked)

    const picked = talking(4, { reply })
    await picked.h.type("/fork pick\r")
    expect(screen(picked.h)).toContain("enter fork here")
    expect(screen(picked.h)).not.toContain("^F")
    await picked.h.type("\r")
    expect(picked.h.sentOf("session.fork")).toEqual([{ type: "session.fork", sessionId: picked.h.sessionId, atItemId: picked.exchanges[3]!.itemId }])

    const undone = talking(2, { reply })
    undone.state.entries = undone.state.entries.map((entry, index) => index === 1 ? { ...entry, reverted: true } : entry)
    await undone.h.type("/tree\r")
    await undone.h.type("\x1b[B")
    await undone.h.type("\x06")
    expect(undone.h.sentOf("session.fork")).toHaveLength(0)
    expect(screen(undone.h)).toContain("that message was undone")
  })

  test("/timeline opens the same page on the messages; tab walks the filters and shows the one in use", async () => {
    const { h, state, sessionId } = talking(3)
    state.nodes = [node({ sessionId, title: "Main work", current: true }), node({ sessionId: ids("session"), parentId: sessionId, title: "fork: Main work", createdAt: NOW })]
    await h.type("/timeline\r")
    expect(h.app.page).toBe("tree")
    expect(screen(h)).toContain("messages only")
    expect(h.text().some((row) => /[├└]─.*fork: Main work/.test(row))).toBe(false)
    for (const name of ["branches & agents", "bookmarked only", "3 messages"]) {
      await h.type("\t")
      expect(screen(h)).toContain(name)
    }
    expect(h.text().some((row) => /[├└]─.*fork: Main work/.test(row))).toBe(true)
  })

  test("typing searches while it types, keeps the ancestors, and esc clears it before it closes the page", async () => {
    const { h, state, sessionId } = talking(5)
    state.nodes = [node({ sessionId, title: "Main work", current: true })]
    await h.type("/tree\r")
    await h.type("question 2")
    let frame = screen(h)
    expect(frame).toContain("search: question 2▏")
    expect(frame).toContain("Main work")
    expect(frame).not.toContain("question 4")
    expect(h.text().find((row) => row.includes("❯"))).toContain("question 2")
    await h.type("zzz")
    expect(screen(h)).toContain('no match for "question 2zzz"')
    await h.type("\x1b")
    frame = screen(h)
    expect(frame).not.toContain("search:")
    expect(frame).toContain("question 4")
    expect(h.app.page).toBe("tree")
    await h.type("\x1b")
    expect(h.app.page).toBe("chat")
  })

  test("ctrl+l bookmarks the selected message, ctrl+l with no text removes it, and a bookmark of another session is labelled in its own session", async () => {
    const markItem = ids("item"), fork = ids("session")
    const reply: Reply = (command) => command.type === "session.label" ? { ok: true, result: { itemId: command.itemId, ...(command.label ? { label: command.label.trim() } : {}) } } : undefined
    const { h, state, sessionId } = talking(3, { reply })
    state.nodes = [node({ sessionId, title: "Main work", current: true }), node({ sessionId: fork, parentId: sessionId, atItemId: state.entries[0]!.itemId, title: "fork: Main work", labels: [{ itemId: markItem, label: "risky", preview: "port everything" }] })]
    await h.type("/tree\r")
    await h.type("\x1b[A")
    await h.type("\x0c")
    await h.type("idea a")
    expect(screen(h)).toContain("label: idea a")
    expect(screen(h)).toContain("enter save")
    await h.type("\r")
    expect(h.sentOf("session.label").at(-1)).toEqual({ type: "session.label", sessionId, itemId: state.entries[1]!.itemId, label: "idea a" })
    expect(screen(h)).toContain("◆ idea a")
    expect(screen(h)).toContain("2 bookmarked")
    await h.type("\x0c")
    for (let i = 0; i < 6; i++) await h.type("\x7f")
    await h.type("\r")
    expect(h.sentOf("session.label").at(-1)).toEqual({ type: "session.label", sessionId, itemId: state.entries[1]!.itemId })
    expect(screen(h)).not.toContain("◆ idea a")

    await h.type("risky")
    await h.type("\x0c")
    await h.type("\x7f".repeat(5))
    await h.type("worse\r")
    expect(h.sentOf("session.label").at(-1)).toEqual({ type: "session.label", sessionId: fork, itemId: markItem, label: "worse" })
  })

  test("ctrl+l on a session says what to select; /label still bookmarks the latest message", async () => {
    const reply: Reply = (command) => command.type === "session.label" ? { ok: true, result: { itemId: command.itemId, ...(command.label ? { label: command.label.trim() } : {}) } } : undefined
    const { h, state, sessionId } = talking(3, { reply })
    state.nodes = [node({ sessionId, title: "Main work", current: true })]
    await h.type("/tree\r")
    await h.type("\x1b[H")
    await h.type("\x0c")
    expect(screen(h)).toContain("select a message to bookmark")
    await h.type("\x1b")
    await h.type("/label ")
    await h.type("good fix\r")
    expect(h.sentOf("session.label").at(-1)).toEqual({ type: "session.label", sessionId, itemId: state.entries[2]!.itemId, label: "good fix" })
  })

  test("ctrl+y copies the whole message from the daemon, a branch by its title, a bookmark by its start", async () => {
    const full = "a long question ".repeat(20)
    const history = (turnId: string, itemId: string) => ({ turns: [{ turnId, at: NOW, seq: 1, preview: "a long question", outcome: "completed", items: [{ itemId, kind: "user_message", text: full, status: "ok" }] }] })
    const fork = ids("session")
    const holder: { entries: TimelineEntry[] } = { entries: [] }
    const reply: Reply = (command) => command.type === "session.history" ? { ok: true, result: history(String(command.turnId), holder.entries[2]!.itemId) } : undefined
    const { h, state, sessionId } = talking(3, { reply })
    holder.entries = state.entries
    state.nodes = [node({ sessionId, title: "Main work", current: true }), node({ sessionId: fork, parentId: sessionId, title: "fork: Main work", labels: [{ itemId: ids("item"), label: "risky", preview: "port everything" }] })]
    const copied = () => h.written.filter((data) => data.startsWith("\x1b]52;c;")).map((data) => Buffer.from(data.slice(7, -1), "base64").toString("utf8"))
    await h.type("/tree\r")
    await h.type("\x19")
    expect(h.sentOf("session.history").at(-1)).toMatchObject({ type: "session.history", sessionId, turnId: state.entries[2]!.turnId })
    expect(copied()).toEqual([full])
    expect(screen(h)).toContain("copied the message")
    await h.type("fork")
    await h.type("\x19")
    expect(copied().at(-1)).toBe("fork: Main work")
    await h.type("\x15")
    await h.type("risky")
    await h.type("\x19")
    expect(copied().at(-1)).toBe("port everything")
  })

  test("ctrl+r summarizes the selected branch beside the list, ctrl+b merges a fork and refuses a sub-agent", async () => {
    const fork = ids("session"), agent = ids("session")
    const reply: Reply = (command) => command.type === "session.merge" ? { ok: true, result: { fromSessionId: command.sessionId, intoSessionId: command.sessionId, turns: 2, omitted: 0, tokens: 1500, pending: 1 } } : undefined
    const { h, state, sessionId } = talking(3, { reply })
    state.nodes = [
      node({ sessionId, title: "Main work", current: true }),
      node({ sessionId: fork, parentId: sessionId, title: "fork: Main work", unmerged: 2, createdAt: NOW }),
      node({ sessionId: agent, parentId: sessionId, title: "scan the repo", kind: "task", agent: "explore", state: "completed", headline: "Found 3 entry points", createdAt: NOW }),
    ]
    await h.type("/tree\r")
    await h.type("scan")
    await settleFrame(h)
    expect(screen(h)).toContain("sub-agent")
    expect(screen(h)).toContain("Found 3 entry points")
    await h.type("\x02")
    expect(h.sentOf("session.merge")).toHaveLength(0)
    expect(screen(h)).toContain("only a fork can be merged back")
    await h.type("\x15")
    await h.type("fork: Main")
    await h.type("\x12")
    expect(h.sentOf("session.recap").at(-1)).toEqual({ type: "session.recap", sessionId: fork })
    expect(screen(h)).toContain("Goal: ship the tree")
    await h.type("\x02")
    expect(h.sentOf("session.merge").at(-1)).toEqual({ type: "session.merge", sessionId: fork })
    expect(screen(h)).toContain("merged 2 turns")
  })

  test("asks again when a sub-agent changes, keeps the row, and reads its cost once per change", async () => {
    const { h, state, sessionId } = talking(2)
    const agent = ids("session")
    let agentState = "running"
    const tree = () => [node({ sessionId, title: "Main work", current: true, updatedAt: NOW }), node({ sessionId: agent, parentId: sessionId, title: "scan the repo", kind: "task", agent: "explore", state: agentState, createdAt: NOW, updatedAt: agentState === "running" ? NOW : NOW + 1 })]
    state.nodes = tree()
    await h.type("/tree\r")
    await h.type("scan")
    await settleFrame(h)
    expect(screen(h)).toContain("explore · running")
    const statsAsked = h.sentOf("session.stats").length
    agentState = "completed"
    state.nodes = tree()
    h.app.onGlobal({ type: "task.changed", gseq: 1, at: NOW, sessionId: agent, parentId: sessionId })
    await settleFrame(h)
    expect(screen(h)).toContain("explore · completed")
    expect(h.text().find((row) => row.includes("❯"))).toContain("scan the repo")
    expect(h.sentOf("session.stats").length).toBe(statsAsked + 1)
  })

  test("shows the messages when the family cannot be read, and the error only when nothing loaded", async () => {
    const denied: Reply = (command) => command.type === "session.tree" ? { ok: false, error: { code: "forbidden", message: "[DAEMON]: the family is not readable here" } } : undefined
    const solo = talking(3, { reply: denied })
    await solo.h.type("/tree\r")
    await settleFrame(solo.h)
    expect(screen(solo.h)).toContain("question 3")
    expect(screen(solo.h)).not.toContain("not readable here")

    const none = treeApp({ reply: (command) => command.type === "session.timeline" || command.type === "session.tree" ? { ok: false, error: { code: "unknown_session", message: "[DAEMON]: unknown session" } } : undefined })
    await none.h.type("/tree\r")
    expect(screen(none.h)).toContain("unknown session")
    await none.h.type("\x1b")
    expect(none.h.app.page).toBe("chat")
  })

  test("a session with no sub-agents and no forks shows only its messages", async () => {
    const { h, state, sessionId } = talking(3)
    state.nodes = [node({ sessionId, title: "Main work", current: true })]
    await h.type("/tree\r")
    expect(screen(h)).toContain("3 messages")
    expect(screen(h)).not.toContain("agent")
    expect(screen(h)).not.toContain("branch")
  })

  test("works in the minimalist tier: /tree is listed and opens on the messages", async () => {
    expect(menuCatalog([], DEFAULT_TUI_PROFILE, { tier: "minimalist" }).map((command) => command.name)).toContain("tree")
    const { h, state, sessionId } = talking(3, { tier: "minimalist" })
    state.nodes = [node({ sessionId, title: "Main work", current: true })]
    await h.type("/tree\r")
    expect(h.app.page).toBe("tree")
    expect(screen(h)).toContain("question 3")
    await h.type("\x1b[A")
    await h.type("\r")
    expect(h.app.page).toBe("chat")
  })

  test("fits 60x20 with the detail under the list, and 180x50, without clipping", async () => {
    for (const [width, height] of [[60, 20], [180, 50]] as const) {
      const { h, state, sessionId } = talking(12, { width, height })
      const fork = ids("session")
      state.nodes = [node({ sessionId, title: "A very long session title that must be cut to fit the narrow panel", current: true }), node({ sessionId: fork, parentId: sessionId, atItemId: state.entries[3]!.itemId, title: "fork with a rather long title for this screen", labels: [{ itemId: ids("item"), label: "label with a rather long text", preview: "preview text of the message that was bookmarked" }] })]
      await h.type("/tree\r")
      await settleFrame(h)
      expect(h.text()).toHaveLength(height)
      for (const line of h.text()) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(width)
      expect(screen(h)).toContain("question 12")
      if (width < 70) expect(screen(h)).toContain("Message 12")
      await h.type("\x1b[H")
      await h.type("\x12")
      await settleFrame(h)
      expect(h.sentOf("session.recap").at(-1)).toEqual({ type: "session.recap", sessionId })
      expect(screen(h)).toContain("Goal: ship the tree")
      await h.type("\x1b")
      expect(h.app.page).toBe("chat")
    }
  })

  test("a message edited elsewhere shows its new text", async () => {
    const { h, state, sessionId, exchanges } = talking(2)
    state.nodes = [node({ sessionId, title: "Main work", current: true })]
    await h.type("/tree\r")
    h.app.onEvent({ sessionId, seq: 900, at: NOW, type: "message.revised", itemId: exchanges[1]!.itemId, snapshot: { text: "question two, reworded", status: "ok" } } as never)
    await settleFrame(h)
    expect(screen(h)).toContain("question two, reworded")
  })
})

export type { ItemId }
