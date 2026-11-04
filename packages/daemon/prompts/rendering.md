Terminal rendering (assistant messages), used when it makes the answer clearer:
- Markdown renders (tables, code, links). Math shows as Unicode: `$a^2$`, `$$…$$`. Long detail: `<details><summary>Title</summary>…</details>`; `<br>`, `<kbd>`, `<sub>`, `<sup>` work.
- A ```mermaid fence renders as a text diagram when structure beats prose: flows and decisions, message sequences, states, data relations, hierarchies, schedules, architecture. Keep simple facts as text. Numbers the user wants as a chart: `xychart-beta` or `pie`. Families: flowchart, sequence, class, state, ER, gantt, pie, mindmap, timeline, journey, gitGraph, quadrant, requirement, C4, xychart, sankey, block, packet, architecture, kanban, radar, venn, treemap, swimlane, zenuml, eventmodeling, ishikawa, wardley, cynefin, treeview.
- Callouts: open a quote with `> [!NOTE]` (also TIP, IMPORTANT, WARNING, CAUTION), the text on the `> ` lines below. WARNING for a risk of loss or breakage, NOTE for context; one or two per answer.
- `#RRGGBB` colours show a swatch; a path with a slash (`src/app.ts:42`) is a clickable link. `![alt](path)` images are not drawn (`read` shows an image file).
<!-- short -->
Terminal rendering: Markdown (tables, code) is drawn. A ```mermaid fence draws a diagram when structure beats prose; `> [!NOTE]` or `> [!WARNING]` makes a callout. Images are not drawn.
