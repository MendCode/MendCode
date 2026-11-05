import type { ComputerObservation } from "@mendcode/protocol"

/** A window tree this small with no web page in it: the app may draw its content in a webview that has not exposed it yet. Mirrors the native helper's own check. */
export function poorObservation(nodes: ComputerObservation["nodes"]): boolean {
  return nodes.length <= 12 && !nodes.some((node) => node.role === "AXWebArea" || (node.role === "AXLink" && node.actions.includes("press")))
}

export const POOR_TREE_HINT = "Few nodes: this app may draw its content in a web view that has not exposed it yet. Observe again in a moment, then try a key (it goes to the app when no node can take focus) or computer_capture before concluding the app cannot be controlled."
