import type { ComputerNode } from "@mendcode/protocol"

/**
 * computer_observe as text, the way the leading desktop agents hand a model its accessibility tree (Cua Driver, Peekaboo): one node
 * per line, indented under its parent, with only what a model acts on. Unnamed structure with nothing to act on is left out and its
 * children move up a level. JSON keys repeated per node were most of an observation's size; the nodes themselves stay whole in
 * computer_code, where a program reads them.
 */
const POINTER = ["click", "key", "scroll", "drag"] as const
const STRUCTURE = new Set(["AXGroup", "AXUnknown", "AXSplitGroup", "AXLayoutArea", "AXLayoutItem", "AXSplitter", "AXGenericElement", "AXMenu"])
export const TREE_LEGEND = "One node per line: id Role \"name\" =value [actions] {states}; children are indented. [ptr] = click, key, scroll and drag at the node. Node IDs stay the same while their element does."

type Node = ComputerNode

function semantic(node: Node) { return node.actions.filter((action) => !(POINTER as readonly string[]).includes(action)) }
/**
 * Left out of the text: an unnamed group, layout element or menu that offers nothing but pointer input and holds no focus, and a
 * menu separator or a disabled menu item (nothing can be done with either).
 */
function structural(node: Node) {
  if (node.role === "AXMenuItem") return !node.name || !node.states.includes("enabled")
  return STRUCTURE.has(node.role) && !node.name && node.value === undefined && !node.secure && semantic(node).length === 0 && !node.states.includes("focused")
}
function depthOf(node: Node) { return node.depth ?? node.id.split(".").length - 1 }
const round = (value: number) => Math.round(value)

export function nodeLine(node: Node): string {
  const parts = [node.id, node.role.replace(/^AX/, "") || "Unknown"]
  if (node.secure) parts.push("(secure)")
  else {
    if (node.name) parts.push(JSON.stringify(node.name))
    if (node.value !== undefined && node.value !== "" && node.value !== node.name) parts.push(`=${JSON.stringify(node.value)}`)
  }
  const pointer = POINTER.every((action) => node.actions.includes(action))
  const actions = pointer ? [...semantic(node), "ptr"] : node.actions
  if (actions.length) parts.push(`[${actions.join(",")}]`)
  const states = node.states.filter((state) => state !== "enabled" && state !== "secure")
  if (!node.secure && !node.states.includes("enabled")) states.push("disabled")
  if (states.length) parts.push(`{${states.join(",")}}`)
  return parts.join(" ")
}

/** The lines shown, in tree order, each with its indentation; structural nodes are skipped and their children move up. */
export function shownLines(nodes: Node[]): { id: string; line: string; indent: number }[] {
  const stack: { depth: number; shown: boolean }[] = []
  const lines: { id: string; line: string; indent: number }[] = []
  for (const [index, node] of nodes.entries()) {
    const depth = depthOf(node)
    while (stack.length && stack.at(-1)!.depth >= depth) stack.pop()
    const shown = index === 0 || !structural(node)
    const indent = stack.filter((entry) => entry.shown).length
    stack.push({ depth, shown })
    if (!shown) continue
    let line = nodeLine(node)
    if (index === 0 && node.bounds) line += ` @${round(node.bounds.x)},${round(node.bounds.y)} ${round(node.bounds.width)}x${round(node.bounds.height)}`
    lines.push({ id: node.id, line, indent })
  }
  return lines
}

export function renderTree(nodes: Node[]): string {
  return shownLines(nodes).map(({ line, indent }) => "  ".repeat(indent) + line).join("\n")
}

/** What the model last saw of each shown node, by ID. */
export type Shown = Map<string, string>
export function shownMap(nodes: Node[]): Shown {
  return new Map(shownLines(nodes).map(({ id, line }) => [id, line]))
}

/**
 * The change from what the model last saw: nothing (`unchanged`), a short list (`+` new, `~` changed, `-` gone), or undefined when
 * so much changed that the whole tree reads better.
 */
export function treeChanges(previous: Shown, current: Shown): { unchanged: true } | { changes: string } | undefined {
  const lines: string[] = []
  for (const [id, line] of current) {
    const before = previous.get(id)
    if (before === undefined) lines.push(`+ ${line}`)
    else if (before !== line) lines.push(`~ ${line}`)
  }
  for (const [id, line] of previous) if (!current.has(id)) lines.push(`- ${line}`)
  if (!lines.length) return { unchanged: true }
  if (lines.length > Math.max(10, Math.floor(current.size * 0.3))) return
  return { changes: lines.join("\n") }
}
