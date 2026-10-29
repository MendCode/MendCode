import type { HistoryReport, ItemId, MessageRevision, SessionId, SessionTreeNode, TimelineEntry } from "@mendcode/protocol"
import { buildTree, createTreeState, settle, treeKey, treeRows, type preload } from "../lazy-pages"
import type { TreeFilter, TreeModel, TreeNode } from "../../view/session-tree"
import type { BranchStats } from "../../view/session-tree-page"
import type { TreeAction, TreeState } from "../../view/session-tree-keys"
import { truncateEnd } from "../../view/wrap"
import type { AppContext } from "./context"

/** Everything the tree page holds besides its own selection: what the daemon answered, the model built from it, and what each branch cost. */
export type TreeData = {
  entries: TimelineEntry[] | undefined
  nodes: SessionTreeNode[] | undefined
  model: TreeModel | undefined
  error: string
  stats: Map<string, BranchStats>
  /** `updatedAt` of each session when its stats were read, so a session that did not change is not asked again. */
  statsAt: Map<string, number>
  /** `/fork pick`: enter forks at a message instead of jumping to it. */
  pick: boolean
}

/** Sessions whose stats are read per load: the open one first, then the tree in order. */
const STATS_LIMIT = 24
const STATS_BATCH = 6

type StatsResult = { turns?: { total?: number; activeMs?: number }; usage?: { total?: { input?: number; output?: number; cacheRead?: number } } }

function readStats(result: unknown): BranchStats | undefined {
  const stats = (result as { stats?: StatsResult } | undefined)?.stats
  if (!stats) return undefined
  return { input: stats.usage?.total?.input ?? 0, output: stats.usage?.total?.output ?? 0, cacheRead: stats.usage?.total?.cacheRead ?? 0, ms: stats.turns?.activeMs ?? 0, turns: stats.turns?.total ?? 0 }
}

/**
 * `/tree` and `/timeline`, one page: the session's messages (`session.timeline`), its fork family and sub-agents
 * (`session.tree`) and what each branch cost (`session.stats`), merged into the model of `view/session-tree.ts`. This
 * module loads them, hands keys to the page, and does what the user asked: jump, fork, open, bookmark, copy, recap, merge.
 * `/label` lives here too: a bookmark is the same thing the tree shows on a message.
 */
export function createSessionTree(ctx: AppContext, actions: {
  loadPage(name: Parameters<typeof preload>[0] | undefined): Promise<void>
  sessionTitle(): string
  switchSession(sessionId: SessionId): Promise<unknown>
  jumpTo(entry: TimelineEntry): Promise<unknown>
  forkAt(entry: TimelineEntry): Promise<unknown>
  /** Merge-back of a fork into its parent; true when it was queued. */
  mergeFork(forkId: SessionId): Promise<boolean>
  openMessageActions(pick: boolean, itemId?: ItemId, turnId?: TimelineEntry["turnId"]): Promise<void>
}) {
  const { input, state, say, fail, requestFrame } = ctx

  /** True while `tree` is still the page the user is looking at. */
  const live = (tree: TreeData, sessionId: SessionId) => state.tree === tree && state.page === "tree" && state.sessionId === sessionId

  function rebuild(tree: TreeData) {
    tree.model = tree.entries || tree.nodes ? buildTree({ sessionId: state.sessionId, entries: tree.entries, nodes: tree.nodes, title: actions.sessionTitle() }) : undefined
    if (tree.model) state.treeState = settle(state.treeState, tree.model)
  }

  async function loadEntries(tree: TreeData, sessionId: SessionId) {
    const reply = await input.send({ type: "session.timeline", sessionId })
    if (!live(tree, sessionId)) return
    if (reply.ok) tree.entries = (reply.result?.entries as TimelineEntry[] | undefined) ?? []
    else tree.error = reply.error.message
    rebuild(tree)
    requestFrame()
  }

  async function loadNodes(tree: TreeData, sessionId: SessionId) {
    const reply = await input.send({ type: "session.tree", sessionId })
    if (!live(tree, sessionId)) return
    if (reply.ok) tree.nodes = (reply.result?.nodes as SessionTreeNode[] | undefined) ?? []
    // A token that cannot read the family still gets the messages; the error shows only when nothing else loaded.
    else tree.error ||= reply.error.message
    rebuild(tree)
    requestFrame()
    if (reply.ok) await loadStats(tree, sessionId)
  }

  /** What each branch and agent cost, from the daemon's own `session.stats`; a row shows it once it arrives. */
  async function loadStats(tree: TreeData, sessionId: SessionId) {
    const wanted = [...(tree.nodes ?? [])].sort((a, b) => Number(b.current) - Number(a.current)).slice(0, STATS_LIMIT).filter((node) => tree.statsAt.get(node.sessionId) !== node.updatedAt)
    for (let start = 0; start < wanted.length; start += STATS_BATCH) {
      await Promise.all(wanted.slice(start, start + STATS_BATCH).map(async (node) => {
        const reply = await input.send({ type: "session.stats", sessionId: node.sessionId })
        if (!live(tree, sessionId) || !reply.ok) return
        const stats = readStats(reply.result)
        if (!stats) return
        tree.stats.set(node.sessionId, stats)
        tree.statsAt.set(node.sessionId, node.updatedAt)
      }))
      if (!live(tree, sessionId)) return
      requestFrame()
    }
  }

  async function open(options: { filter?: TreeFilter; pick?: boolean } = {}) {
    await actions.loadPage("tree")
    const sessionId = state.sessionId
    const tree: TreeData = { entries: undefined, nodes: undefined, model: undefined, error: "", stats: new Map(), statsAt: new Map(), pick: options.pick ?? false }
    state.tree = tree
    state.treeState = createTreeState(options.filter ?? "all")
    state.page = "tree"
    requestFrame()
    await Promise.all([loadEntries(tree, sessionId), loadNodes(tree, sessionId)])
  }

  /** The family again after a sub-agent changed, on the row the user was on. */
  async function reload() {
    const tree = state.tree
    if (state.page === "tree" && tree) await loadNodes(tree, state.sessionId)
  }

  /** The tree opened on a session of the family (the agents card's click), if it is there. */
  function select(sessionId: string) {
    const tree = state.tree
    if (!tree?.model) return
    const key = `s:${sessionId}`
    if (treeRows(tree.model, state.treeState).some((row) => row.key === key)) state.treeState = settle({ ...state.treeState, key }, tree.model)
  }

  /** A message was edited or deleted: the tree shows the new text, or no longer lists it. */
  function noteRevision(event: MessageRevision) {
    const tree = state.tree
    if (!tree?.entries || state.page !== "tree" || event.sessionId !== state.sessionId) return
    tree.entries = tree.entries.flatMap((entry) => entry.itemId !== event.itemId ? [entry] : event.deleted ? [] : [{ ...entry, preview: (event.snapshot.text ?? "").replace(/\s+/g, " ").slice(0, 120) }])
    rebuild(tree)
    requestFrame()
  }

  /** The newest message that was not undone: what `/label` marks. */
  async function latestMessage() {
    const reply = await input.send({ type: "session.timeline", sessionId: state.sessionId })
    if (!reply.ok) { fail(reply.error.message); return undefined }
    return (reply.result?.entries as TimelineEntry[] | undefined)?.findLast((entry) => !entry.reverted)
  }

  /** Sets (or with empty text clears) the bookmark of a message; the open tree shows it at once. */
  async function setLabel(target: { sessionId: SessionId; itemId: ItemId; preview: string }, text: string) {
    const reply = await input.send({ type: "session.label", sessionId: target.sessionId, itemId: target.itemId, ...(text.trim() ? { label: text } : {}) })
    if (!reply.ok) { fail(reply.error.message); return false }
    const label = typeof reply.result?.label === "string" ? reply.result.label : undefined
    const tree = state.tree
    if (tree) {
      if (target.sessionId === state.sessionId && tree.entries) tree.entries = tree.entries.map((entry) => entry.itemId === target.itemId ? (({ label: _drop, ...rest }) => (label ? { ...rest, label } : rest))(entry) : entry)
      if (tree.nodes) tree.nodes = tree.nodes.map((node) => node.sessionId !== target.sessionId ? node : { ...node, labels: label ? [...node.labels.filter((mark) => mark.itemId !== target.itemId), { itemId: target.itemId, label, preview: target.preview }] : node.labels.filter((mark) => mark.itemId !== target.itemId) })
      rebuild(tree)
    }
    say(label ? `bookmarked "${truncateEnd(target.preview, 30)}" as ${label}` : "bookmark removed", "success")
    requestFrame()
    return true
  }

  /** `/label <text>` bookmarks the latest message, `/label` removes its bookmark; `/tree` (ctrl+l) bookmarks any message. */
  async function labelCommand(args: string) {
    const entry = await latestMessage()
    if (!entry) return state.notice = "no message to bookmark yet"
    await setLabel({ sessionId: state.sessionId, itemId: entry.itemId, preview: entry.preview }, args)
  }

  /** The text `ctrl+y` copies: a message in full (asked from the daemon, since the timeline keeps only its start), a branch by its title. */
  async function copyNode(node: TreeNode) {
    if (node.kind === "session") {
      const { title, headline, kind } = node.session
      return ctx.copyText(kind === "task" && headline ? `${title}\n${headline}` : title, kind === "task" ? "the sub-agent" : "the branch title")
    }
    if (node.kind === "mark") return ctx.copyText(node.mark!.preview, "the start of the bookmarked message")
    const entry = node.entry!
    const sessionId = state.sessionId
    const reply = await input.send({ type: "session.history", sessionId, turnId: entry.turnId })
    const item = reply.ok ? (reply.result as HistoryReport).turns.flatMap((turn) => turn.items).find((candidate) => candidate.itemId === entry.itemId) : undefined
    if (sessionId !== state.sessionId) return
    if (!item) return ctx.copyText(entry.preview, "the start of the message")
    ctx.copyText(item.text, item.truncated ? "the message (the daemon cut it)" : "the message")
  }

  async function summarize(node: TreeNode) {
    const sessionId = node.session.sessionId
    state.treeState = { ...state.treeState, loading: sessionId }
    requestFrame()
    const reply = await input.send({ type: "session.recap", sessionId })
    if (state.page !== "tree") return
    const { loading: _done, ...rest } = state.treeState
    state.treeState = { ...rest, summary: reply.ok ? { sessionId, text: String(reply.result?.text ?? "") } : { sessionId, error: reply.error.message } }
  }

  async function perform(action: TreeAction, tree: TreeData) {
    switch (action.type) {
      case "close":
        state.page = "chat"
        break
      case "warn":
        say(action.text, "warning")
        break
      case "jump":
        // `/fork pick` is the same page with enter meaning fork.
        if (tree.pick) await actions.forkAt(action.entry)
        else await actions.jumpTo(action.entry)
        break
      case "fork":
        await actions.forkAt(action.entry)
        break
      case "actions":
        if (action.entry.reverted) say("that message was undone · /redo brings it back", "warning")
        else await actions.openMessageActions(false, action.entry.itemId, action.entry.turnId)
        break
      case "open": {
        const target = action.node.session.sessionId
        state.page = "chat"
        if (target !== state.sessionId) await actions.switchSession(target)
        if (action.node.kind === "mark") await actions.jumpTo({ turnId: "" as TimelineEntry["turnId"], itemId: action.node.mark!.itemId as ItemId, at: 0, preview: "", reverted: false })
        break
      }
      case "label": {
        const node = action.node
        const itemId = (node.entry?.itemId ?? node.mark?.itemId) as ItemId
        await setLabel({ sessionId: node.session.sessionId, itemId, preview: node.entry?.preview ?? node.mark?.preview ?? "" }, action.text)
        break
      }
      case "copy":
        await copyNode(action.node)
        break
      case "summary":
        await summarize(action.node)
        break
      case "merge": {
        const session = action.node.session
        if (action.node.kind !== "session" || session.kind === "task" || !session.parentId) say("only a fork can be merged back into its parent", "warning")
        else if (await actions.mergeFork(session.sessionId)) await loadNodes(tree, state.sessionId)
        break
      }
      case "none":
        break
    }
  }

  async function key(raw: string) {
    const tree = state.tree
    if (!tree?.model) {
      if (raw === "\x1b") state.page = "chat"
      requestFrame()
      return
    }
    const result = treeKey(state.treeState, raw, tree.model)
    state.treeState = result.state
    await perform(result.action, tree)
    requestFrame()
  }

  return { open, reload, select, key, noteRevision, setLabel, labelCommand }
}
