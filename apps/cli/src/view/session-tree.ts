import type { SessionId, SessionTreeNode, TimelineEntry } from "@mendcode/protocol"
import { readablePreview } from "./reply-comments"

/**
 * The one tree of /tree and /timeline. A session is a node; under it hang its messages (the open session's come from
 * `session.timeline`, the others show only their bookmarked ones) and, under the message that started each, the forks and
 * the sub-agents it spawned. A fork carries the message it was cut at (`atItemId`); a sub-agent is placed under the last
 * message that began before it, since the daemon records no message for it. Pure data in, rows out: the keys and the page
 * read the same model.
 */
export type TreeFilter = "all" | "messages" | "branches" | "labeled"
export const TREE_FILTERS: readonly TreeFilter[] = ["all", "messages", "branches", "labeled"]
export const FILTER_NAME: Record<TreeFilter, string> = { all: "everything", messages: "messages only", branches: "branches & agents", labeled: "bookmarked only" }

export type TreeMark = { itemId: string; label: string; preview: string }
export type TreeNode = {
  key: string
  /** `message`: a user message of the open session; `mark`: a bookmarked message of another session. */
  kind: "session" | "message" | "mark"
  /** The session the node is, or belongs to. */
  session: SessionTreeNode
  entry?: TimelineEntry
  /** The message's place in its session, from 1: the number `/fork <n>` takes. */
  number?: number
  mark?: TreeMark
  /** A session hanging under the message it started from, not loose under its parent. */
  anchored?: boolean
  children: TreeNode[]
}
export type TreeModel = { roots: TreeNode[]; /** The key of the one place the open session stands: its newest message that was not undone. */ here: string }

export type TreeView = { filter: TreeFilter; query: string; folded: readonly string[] }
export type TreeRow = {
  key: string
  node: TreeNode
  /** The connector lines in front of the row. */
  prefix: string
  parent: string | undefined
  foldable: boolean
  folded: boolean
  here: boolean
  /** The row itself passes the filter and the search (an ancestor kept for context does not). */
  match: boolean
}

const isTask = (session: SessionTreeNode) => session.kind === "task"
export const isMessage = (node: TreeNode) => node.kind === "message" || node.kind === "mark"
export const itemOf = (node: TreeNode) => node.entry?.itemId ?? node.mark?.itemId
export const labelOf = (node: TreeNode) => node.entry?.label ?? node.mark?.label
export const previewOf = (node: TreeNode) => readablePreview(node.entry?.preview ?? node.mark?.preview ?? "")

const sessionKey = (id: string) => `s:${id}`

/** The text a search looks in. */
export function nodeText(node: TreeNode): string {
  if (node.kind === "session") return [node.session.title, node.session.agent, node.session.description, node.session.atPreview, node.session.state].filter(Boolean).join(" ")
  return [labelOf(node), previewOf(node)].filter(Boolean).join(" ")
}

export function buildTree(input: { sessionId: SessionId; entries: readonly TimelineEntry[] | undefined; nodes: readonly SessionTreeNode[] | undefined; /** The title of the open session when the daemon's family is missing. */ title?: string }): TreeModel {
  const family = [...(input.nodes ?? [])]
  // Without the family (a read-only token cannot ask for it) the open session still stands alone with its messages.
  if (!family.some((node) => node.sessionId === input.sessionId)) family.push({ sessionId: input.sessionId, title: input.title ?? "this session", directory: "", createdAt: 0, updatedAt: 0, archived: false, current: true, labels: [], kind: "fork" } as SessionTreeNode)
  const byId = new Map(family.map((node) => [node.sessionId as string, node]))
  const kids = new Map<string, SessionTreeNode[]>()
  const roots: SessionTreeNode[] = []
  for (const node of family) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined
    if (parent) kids.set(parent.sessionId, [...(kids.get(parent.sessionId) ?? []), node])
    else roots.push(node)
  }
  let here = sessionKey(input.sessionId)
  const build = (session: SessionTreeNode): TreeNode => {
    const open = session.sessionId === input.sessionId && input.entries !== undefined
    const anchors: TreeNode[] = open
      ? input.entries!.map((entry, index) => ({ key: `m:${entry.itemId}`, kind: "message", session, entry, number: index + 1, children: [] }))
      : session.labels.map((mark) => ({ key: `l:${session.sessionId}:${mark.itemId}`, kind: "mark", session, mark, children: [] }))
    if (open) {
      const live = input.entries!.findLast((entry) => !entry.reverted)
      if (live) here = `m:${live.itemId}`
    }
    const anchorFor = (child: SessionTreeNode) => anchors.find((anchor) => itemOf(anchor) === child.atItemId) ?? (open ? anchors.findLast((anchor) => !anchor.entry!.reverted && anchor.entry!.at <= child.createdAt) : undefined)
    const loose: TreeNode[] = []
    for (const child of [...(kids.get(session.sessionId) ?? [])].sort((a, b) => a.createdAt - b.createdAt)) {
      const node = build(child)
      const anchor = anchorFor(child)
      if (anchor) anchor.children.push({ ...node, anchored: true })
      else loose.push(node)
    }
    return { key: sessionKey(session.sessionId), kind: "session", session, children: [...anchors, ...loose] }
  }
  return { roots: roots.map(build), here }
}

/** Rows to draw: the tree depth first with its connectors, after the filter, the search and the folds. Ancestors of a hit stay for context. */
export function treeRows(model: TreeModel, view: TreeView): TreeRow[] {
  const query = view.query.trim().toLowerCase()
  // Branches & agents hides the messages themselves; what hangs under them moves up to the session.
  const transparent = (node: TreeNode) => view.filter === "branches" && node.kind !== "session"
  const passes = (node: TreeNode) => {
    if (transparent(node)) return false
    if (view.filter === "messages" && node.kind !== "message") return false
    if (view.filter === "branches" && node.kind !== "session") return false
    if (view.filter === "labeled" && !labelOf(node)) return false
    return query === "" || nodeText(node).toLowerCase().includes(query)
  }
  const memo = new Map<string, TreeNode[]>()
  const visible = (node: TreeNode): TreeNode[] => {
    const known = memo.get(node.key)
    if (known) return known
    const found = node.children.flatMap((child) => (transparent(child) ? visible(child) : shown(child) ? [child] : []))
    memo.set(node.key, found)
    return found
  }
  const shown = (node: TreeNode) => passes(node) || visible(node).length > 0
  const rows: TreeRow[] = []
  const walk = (node: TreeNode, indent: string, last: boolean, root: boolean, parent: string | undefined) => {
    const children = visible(node)
    const folded = query === "" && view.folded.includes(node.key)
    rows.push({ key: node.key, node, prefix: root ? "" : indent + (last ? "└─ " : "├─ "), parent, foldable: children.length > 0, folded: folded && children.length > 0, here: node.key === model.here, match: passes(node) })
    if (folded) return
    const inner = root ? "" : indent + (last ? "   " : "│  ")
    children.forEach((child, index) => walk(child, inner, index === children.length - 1, false, node.key))
  }
  const top = model.roots.filter(shown)
  top.forEach((root, index) => walk(root, "", index === top.length - 1, true, undefined))
  return rows
}

/** The row to start on: the open session's place; the first match when a search or filter hides it. */
export function startIndex(rows: readonly TreeRow[]): number {
  const here = rows.findIndex((row) => row.here)
  if (here >= 0) return here
  return Math.max(0, rows.findIndex((row) => row.match))
}

/** How many sessions of each kind, and how many bookmarks, the model holds: the summary line's figures. */
export function treeCounts(model: TreeModel) {
  const counts = { messages: 0, branches: 0, agents: 0, running: 0, bookmarked: 0 }
  const walk = (node: TreeNode) => {
    if (node.kind === "message") counts.messages++
    if (isMessage(node) && labelOf(node)) counts.bookmarked++
    if (node.kind === "session" && !node.session.current) {
      if (isTask(node.session)) counts.agents++
      else if (node.session.parentId) counts.branches++
    }
    if (node.kind === "session" && (isTask(node.session) ? ["queued", "running", "needs_input"].includes(node.session.state ?? "") : node.session.state === "running")) counts.running++
    node.children.forEach(walk)
  }
  model.roots.forEach(walk)
  return counts
}
