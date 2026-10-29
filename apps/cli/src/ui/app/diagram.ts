import { createDiagramView, layoutDiagram, transcriptDiagrams } from "../lazy-pages"
import type { DiagramLayout } from "../../view/mermaid-viewer"
import { ensureMermaid } from "../../view/mermaid-lazy"
import type { AppContext } from "./context"

export function createDiagram(ctx: AppContext) {
  const { input, state, say } = ctx

  /** The diagram laid out for the page's size and zoom; undefined while the renderer loads or there is no diagram. Kept until one of them changes. */
  function diagramLayout(): DiagramLayout | undefined {
    const render = ensureMermaid()
    const source = state.diagramSources[Math.min(state.diagramView.index, state.diagramSources.length - 1)]
    if (!render || !source) return undefined
    const key = `${source.itemId}:${source.source.length}:${state.diagramView.zoom}:${state.diagramView.index}`
    if (state.diagramMemo?.key !== key) state.diagramMemo = { key, layout: layoutDiagram({ source: source.source, zoom: state.diagramView.zoom, render }) }
    return state.diagramMemo.layout
  }

  /** `/diagram [n]`: the session's last diagram (or the nth, counting from 1) full screen. */
  function openDiagram(args: string) {
    const sources = transcriptDiagrams(state.transcript.blocks())
    if (sources.length === 0) {
      say("no diagram in this session yet (a ```mermaid block in an answer)")
      return
    }
    const nth = /^[1-9]\d*$/.test(args.trim()) ? Number(args.trim()) : undefined
    if (args.trim() !== "" && (nth === undefined || nth > sources.length)) {
      say(`usage: /diagram [n] (1-${sources.length}; the last one by default)`)
      return
    }
    state.diagramSources = sources
    state.diagramView = createDiagramView(nth ? nth - 1 : sources.length - 1)
    state.diagramMemo = undefined
    ensureMermaid()
    state.page = "diagram"
  }

  return { diagramLayout, openDiagram }
}
