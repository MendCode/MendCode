/**
 * The diagram families the terminal renders, by the name the system prompt gives the model and the mermaid
 * headers each one covers. mermaid.test.ts holds this list, the registry and the native system prompt
 * (packages/engine-native/prompts/system.md) to each other: a new registry entry fails the test until its
 * family is listed here and named in the prompt.
 */
export const DIAGRAM_FAMILIES: ReadonlyArray<{ name: string; headers: readonly string[] }> = [
  { name: "flowchart", headers: ["flowchart", "graph"] },
  { name: "sequence", headers: ["sequencediagram"] },
  { name: "class", headers: ["classdiagram", "classdiagram-v2"] },
  { name: "state", headers: ["statediagram", "statediagram-v2"] },
  { name: "ER", headers: ["erdiagram"] },
  { name: "gantt", headers: ["gantt"] },
  { name: "pie", headers: ["pie"] },
  { name: "mindmap", headers: ["mindmap"] },
  { name: "timeline", headers: ["timeline"] },
  { name: "journey", headers: ["journey"] },
  { name: "gitGraph", headers: ["gitgraph"] },
  { name: "quadrant", headers: ["quadrantchart"] },
  { name: "requirement", headers: ["requirementdiagram"] },
  { name: "C4", headers: ["c4context", "c4container", "c4component", "c4dynamic", "c4deployment"] },
  { name: "xychart", headers: ["xychart", "xychart-beta"] },
  { name: "sankey", headers: ["sankey", "sankey-beta"] },
  { name: "block", headers: ["block", "block-beta"] },
  { name: "packet", headers: ["packet", "packet-beta"] },
  { name: "architecture", headers: ["architecture-beta"] },
  { name: "kanban", headers: ["kanban"] },
  { name: "radar", headers: ["radar-beta"] },
  { name: "venn", headers: ["venn-beta"] },
  { name: "treemap", headers: ["treemap-beta"] },
  { name: "swimlane", headers: ["swimlane-beta"] },
  { name: "zenuml", headers: ["zenuml"] },
  { name: "eventmodeling", headers: ["eventmodeling"] },
  { name: "ishikawa", headers: ["ishikawa-beta"] },
  { name: "wardley", headers: ["wardley-beta"] },
  { name: "cynefin", headers: ["cynefin-beta"] },
  { name: "treeview", headers: ["treeview-beta"] },
]
