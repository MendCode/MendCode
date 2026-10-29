import type { GraphIndexMode } from "@mendcode/codegraph"
import type { Settings } from "@mendcode/protocol"
import { canonicalDir } from "@mendcode/tools"

/** The code graph's tools, as tool patterns: what a folder the graph does not index leaves out of the model's list. */
export const GRAPH_TOOL_PATTERNS = ["graph_*", "code_search"] as const

/** Where the code graph indexes for `directory`: the project's own `/graph` choice, then the global `codegraph_index`, then `auto`. */
export function graphIndexMode(settings: Pick<Settings, "codegraph_index" | "projectConfig">, directory: string): GraphIndexMode {
  const projects = settings.projectConfig
  return projects?.[canonicalDir(directory)]?.codegraph_index ?? projects?.[directory]?.codegraph_index ?? settings.codegraph_index ?? "auto"
}
