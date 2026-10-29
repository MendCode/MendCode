# Terminal Mermaid diagrams

The `full` message renderer draws Mermaid fences as themed Unicode diagrams. `/diagram [n]`
opens a session diagram on a scrollable canvas. Arrows or `hjkl` pan, Shift moves a page,
`+`/`-` zoom, `0` resets, `n`/`p` switch diagrams, and Esc returns to chat. Labels use the
same grapheme and terminal-cell measurement as the rest of the CLI, including CJK,
combining marks and emoji sequences. Source fences remain available when layout fails.

`view/mermaid.ts` dispatches to one module per family in `view/mermaid/`. The registry,
parsers and layouts load through `mermaid-lazy.ts` only when a Mermaid fence is encountered.
No dependencies or protocol runtime schemas are added to startup.

## Legacy inventory and coverage

Reference inspected read-only: v1 `src/mendcode/packages/opencode/src/cli/cmd/tui/util/markdown-render.ts`
(`renderSimpleMermaid` and its family renderers), `component/styled-plan-markdown.tsx`, and
`test/cli/tui/markdown-render.test.ts`. The current v1 source has **30 families**: the ten
families called new in UI-9 already exist in that checkout. They are new to MendCode. Eight more
v1 families are retained as part of parity. The table describes the terminal subset,
not the complete browser Mermaid grammar. Style directives use the terminal theme.

| Family / headers | Syntax carried from legacy MendCode and drawn here |
| --- | --- |
| Flowchart / `flowchart`, `graph` | TD/TB/BT/LR/RL; bare/defined nodes; chains and `&` fan-out/in; cycles and self-links; subgraphs; semicolons; quoted/Markdown/HTML-break labels; `:::class`; solid/dashed/thick links, arrow/cross/circle/bidirectional endpoints, pipe/inline labels; bracket shapes and `@{shape, label}` aliases. |
| Sequence / `sequenceDiagram` | Explicit/implicit participants and aliases, actors, filled/open/cross/async and dashed messages, self-calls, notes over/left/right, loop/alt/opt/par and else/and, critical/break/rect and option, activations and `+`/`-`, autonumber start/step. |
| Timeline / `timeline [LR\|TD]` | Title, sections, named periods, multiple colon-separated events, continuation events; alternating boxes along a horizontal or vertical axis. |
| Journey / `journey` | Title, sections, tasks, score 1–5, actor lists; task boxes linked in order, scores drawn inside. |
| C4 / Context, Container, Component, Dynamic, Deployment | Person/System/Container/Component, external/database/queue variants, boundaries, Deployment_Node/Node_L/Node_R, descriptions, Rel/RelIndex/directional Rel/BiRel calls. Terminal boxes and labeled relationships. |
| Block / `block[-beta]` | Column grid, node labels/shapes, node order, inter-node links and backward connectors. |
| Architecture / `architecture-beta` | Groups and parent groups, services with icons/labels and membership, junctions, directional and group-qualified endpoints; grouped boxes and routed links. |
| Packet / `packet[-beta]` | Absolute bit ranges, single bits, relative `+N` fields, quoted labels and comments; word/bit annotations. MendCode splits fields crossing 32-bit words and wraps labels. |
| Radar / `radar-beta` | Title, named/labeled axes, multiple named/labeled curves with positional or keyed values, min/max; opposing axes for two values, polygons/rings for three or more, curve legend. Where the terminal draws pictures the web and the curves are painted (a tinted area, an outline and a dot per axis, one theme colour per curve, the legend's marks in the same colours); axis labels and the legend stay text. |
| Sankey / `sankey[-beta]` | CSV source,target,value, quoted labels; boxed endpoints joined by bands proportional to value. |
| Treemap / `treemap-beta` | Indented hierarchy, root and numeric leaves; proportional subdivisions with labels and values, boxed hierarchy without values. |
| XY / `xychart[-beta] [horizontal\|vertical]` | Title, category axis, y-axis title/range, multiple bar/line series, negative values, horizontal bars and vertical plotted curves. Where the terminal draws pictures, the plot of the upright chart is painted (solid bars, smooth lines with a dot on each value, one theme colour per series, faint rules at the quarters of the range) and the axes, ticks and labels stay text. |
| Class / `classDiagram[-v2]` | Classes, member blocks and `Class: member`, visibility/method text, inheritance/composition/aggregation/association/dependency/realization, multiplicities and relation labels. MendCode also lays out namespace clusters and explicit directions. |
| State / `stateDiagram[-v2]` | Initial/final markers, aliases, transitions/labels, directions, composite states, fork/join/choice stereotypes, cycles. MendCode also retains state descriptions and inline/multiline notes in boxes. |
| ER / `erDiagram` | Entities and every attribute/key field, identifying/non-identifying cardinalities, relationship labels, cross-links and standalone entity blocks. |
| Gantt / `gantt` | Title, sections, YYYY-MM-DD dates, end dates/day durations, task IDs, `after` dependencies, done/active/crit/milestone markers; dated bars and ticks. |
| Pie / `pie [showData] [title ...]` | Named numeric slices, title and values. MendCode draws a round pie, one theme colour per slice, clockwise from twelve o'clock, and a legend of label, value and share beside it (below it in a narrow chat). Where the terminal draws pictures (Kitty, Ghostty, iTerm2, sixel; `transcriptImages` on) the pie is painted as a smooth image at the pixels of its cells; elsewhere it is a disc of dots, one per cell in its slice's colour. |
| Mindmap / `mindmap` | Indentation, bracket node labels, descriptions via `##`, class/icon metadata; connected boxes at hierarchy depths. |
| Git / `gitGraph` | Commits and IDs, branch, checkout/switch, merge; separate branch lanes, commit labels and merge connectors. |
| Quadrant / `quadrantChart` | Title, axis endpoints, quadrant titles, named [x,y] points; divided plot with collision-checked annotations. |
| Requirement / `requirementDiagram` | Requirement subtypes and elements, id/text/risk/verifyMethod/type/docRef, contains/copies/derives/satisfies/verifies/refines/traces links, reverse relations. |
| Kanban / `kanban` | Indented named or bracket-only columns/cards, `@{...}` metadata; column borders, wrapped card labels and metadata. |
| Swimlane / `swimlane-beta [LR\|TD]` | Subgraph lanes, labeled nodes and links, cross-lane relationships; lane headers and routed node boxes. |
| ZenUML / `zenuml` | Arrow messages with labels, dashed/async variants, `if`/`else`, loop and opt braces converted to sequence fragments; v1 symbolic object-call notation retained. |
| Event modeling / `eventmodeling` | tf/timeframe, rf/resetframe, typed frames, explicit connections, embedded or referenced data blocks; connected frame boxes. |
| Venn / `venn-beta` | Title, set/union/text definitions, labels, numeric sizes and memberships; overlapping outlines and annotations. |
| Ishikawa / `ishikawa-beta` | Indented effect, categories and causes; fishbone branches and effect box. |
| Wardley / `wardley-beta` | Title, anchors/components, visibility/evolution coordinates, dependencies, evolve targets and notes; spatial map. |
| Cynefin / `cynefin-beta` | Title, complex/complicated/clear/chaotic/confusion domains, quoted items and labeled domain transitions; domain regions. |
| TreeView / `treeView-beta` | Indentation or tree-drawing prefixes, labels/descriptions, metadata; connected hierarchy boxes. |

Traditional flow shapes include rectangles, rounded/stadium, circle/double-circle,
diamond, cylinder, subroutine, parallelogram, trapezoid, hexagon and asymmetric nodes.
The v1 extended shape alias/marker vocabulary is carried in `legacy-shared.ts`, including
cloud, bang, hourglass, bolt, braces, lean/trap variants, datastore/delay/cylinder variants,
document/framed/lined/divided rectangles, flag, triangle and text/icon/image forms.
These terminal markers preserve v1 semantics without relying on a browser renderer.

## Bounded layout and fallback

Inputs are limited to 16,000 characters, 256 lines, 2,048 characters per source line
and 1,500 structural delimiters. Graph families also bound nodes/edges; hierarchy depth
is capped at 16. Cell grids are capped **before allocation** at 1,600 columns, 600 rows
and 160,000 cells; path enumeration and annotation searches are bounded. Packet fields
must be ordered, non-overlapping and within 4,096 bits. Invalid dates, missing dependency
IDs, unknown references, malformed numeric values and unclosed blocks fail safely.

The renderer returns rows within the requested cell width or a one-line reason with the
original code fence. Labels wrap where a family supports reflow. Diagrams that need more
space render at up to 1,600 columns in `/diagram`, with horizontal/vertical panning.
Oversized or unsupported constructs retain source rather than dropping nodes/fields.
As in v1, CSS/click directives, C4 layout/update hints, and chart display hints do not
control terminal styling. Gantt supports the v1 date/day subset; browser-only calendars
and alternative date formats fall back rather than guessing dates.

## Evidence

`apps/cli/test/fixtures/mermaid-ui9.json` contains two distinct fixtures per family,
including v1 matrix/regression sources. `ui-9.test.ts` checks structure, labels,
relationships, cell width, malformed inputs, Unicode, budgets and the fake app harness.
The existing renderer/viewer/lazy/footprint tests remain active.

`bun scripts/render-ui9-frames.ts .agents/runs/frames/ui-9` writes
`<kind>-<n>-100.txt` (100×30) and `-180.txt` (180×50) through the app harness.
Matching `.canvas.txt` files contain the full diagram, including content reached by
panning. All data/project directories are temporary; no real provider or user data is used.
