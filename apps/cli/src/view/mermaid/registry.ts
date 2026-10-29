import { renderStateDiagram } from "./state"
import { renderErDiagram } from "./er"
import { renderClassDiagram } from "./class"
import type { Line } from "../../ui/theme"
import { renderPieChart } from "./pie"
import { renderGanttChart } from "./gantt"
import { renderMindmapDiagram } from "./mindmap"
import { renderTimelineDiagram } from "./timeline"
import { renderJourneyDiagram } from "./journey"
import { renderKanbanDiagram } from "./kanban"
import { renderTreeViewDiagram } from "./treeview"
import { renderQuadrantChart } from "./quadrant"
import { renderGitGraph } from "./git"
import { renderRequirementDiagram } from "./requirement"
import { renderC4Diagram } from "./c4"
import { renderXyChart, type CellTint, type PlotPicture } from "./xychart"
import { renderSankeyDiagram } from "./sankey"
import { renderBlockDiagram } from "./block"
import { renderPacketDiagram } from "./packet"
import { renderArchitectureDiagram } from "./architecture"
import { renderSwimlaneDiagram } from "./swimlane"
import { renderZenUml } from "./zenuml"
import { renderRadarDiagram } from "./radar"
import { renderEventModelingDiagram } from "./eventmodeling"
import { renderVennDiagram } from "./venn"
import { renderIshikawaDiagram } from "./ishikawa"
import { renderWardleyDiagram } from "./wardley"
import { renderCynefinDiagram } from "./cynefin"
import { renderTreemapDiagram } from "./treemap"

/**
 * A family draws plain text, which the dispatch colours by glyph, or its own coloured lines (a chart whose colours carry the
 * data), or text with the cells a picture of its plot replaces where the terminal draws pictures.
 */
export const registry: Readonly<Record<string, (source: string, width: number) => string | { lines: Line[] } | { text: string; picture?: PlotPicture; tint?: CellTint[] } | undefined>> = {
  "statediagram": renderStateDiagram,
  "statediagram-v2": renderStateDiagram,
  "erdiagram": renderErDiagram,
  "classdiagram": renderClassDiagram,
  "classdiagram-v2": renderClassDiagram,
  "pie": renderPieChart,
  "gantt": renderGanttChart,
  "mindmap": renderMindmapDiagram,
  "timeline": renderTimelineDiagram,
  "journey": renderJourneyDiagram,
  "kanban": renderKanbanDiagram,
  "treeview-beta": renderTreeViewDiagram,
  "quadrantchart": renderQuadrantChart,
  "gitgraph": renderGitGraph,
  "requirementdiagram": renderRequirementDiagram,
  "c4context": renderC4Diagram,
  "c4container": renderC4Diagram,
  "c4component": renderC4Diagram,
  "c4dynamic": renderC4Diagram,
  "c4deployment": renderC4Diagram,
  "xychart": renderXyChart,
  "xychart-beta": renderXyChart,
  "sankey": renderSankeyDiagram,
  "sankey-beta": renderSankeyDiagram,
  "block": renderBlockDiagram,
  "block-beta": renderBlockDiagram,
  "packet": renderPacketDiagram,
  "packet-beta": renderPacketDiagram,
  "architecture-beta": renderArchitectureDiagram,
  "swimlane-beta": renderSwimlaneDiagram,
  "zenuml": renderZenUml,
  "radar-beta": renderRadarDiagram,
  "eventmodeling": renderEventModelingDiagram,
  "venn-beta": renderVennDiagram,
  "ishikawa-beta": renderIshikawaDiagram,
  "wardley-beta": renderWardleyDiagram,
  "cynefin-beta": renderCynefinDiagram,
  "treemap-beta": renderTreemapDiagram,
}
