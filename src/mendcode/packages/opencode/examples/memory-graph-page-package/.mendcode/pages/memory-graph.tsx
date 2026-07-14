/** @jsxImportSource @opentui/solid */

import { BoxRenderable, MouseButton, MouseEvent } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { For, Show, createEffect, createMemo, createResource, createSignal } from "solid-js"
import {
  asciiGraphCellToWorld,
  asciiGraphNearestNode,
  asciiGraphRuns,
  asciiGraphWithNodePosition,
  layoutAsciiGraph,
  renderAsciiGraph,
  type AsciiGraphCell,
  type AsciiGraphFrame,
  type AsciiGraphPoint,
  type TuiMemoryGraphCategory,
  type TuiPluginApi,
} from "@mendcode/plugin/tui"

function compact(value: string | undefined, width: number) {
  const text = (value ?? "").replace(/\s+/g, " ").trim()
  if (text.length <= width) return text
  return width <= 1 ? text.slice(0, width) : `${text.slice(0, width - 1)}…`
}

function GraphRows(props: {
  api: TuiPluginApi
  cells: AsciiGraphCell[][]
  categories: TuiMemoryGraphCategory[]
}) {
  const categoryIndex = createMemo(() => new Map(props.categories.map((category, index) => [category.id, index])))
  const color = (cell: Omit<AsciiGraphCell, "char">) => {
    const theme = props.api.theme.current
    if (cell.kind === "selected") return theme.success
    if (cell.kind === "conflict") return theme.warning
    if (cell.kind === "edge") return theme.borderActive
    if (cell.kind === "label") return theme.text
    const palette = [theme.primary, theme.secondary, theme.accent, theme.success, theme.info, theme.warning]
    if (cell.kind === "node") return palette[(categoryIndex().get(cell.group ?? "") ?? 0) % palette.length] ?? theme.primary
    return theme.textMuted
  }
  return (
    <For each={props.cells}>
      {(row) => (
        <text wrapMode="none" selectable={false}>
          <For each={asciiGraphRuns(row)}>
            {(run) => <span style={{ fg: color(run) }}>{run.text}</span>}
          </For>
        </text>
      )}
    </For>
  )
}

function MemoryGraphPage(props: { api: TuiPluginApi }) {
  const dimensions = useTerminalDimensions()
  const [refresh, setRefresh] = createSignal(0)
  const [snapshot] = createResource(refresh, () => props.api.memory.graph())
  const [selectedID, setSelectedID] = createSignal<string>()
  const [viewport, setViewport] = createSignal({ x: undefined as number | undefined, y: undefined as number | undefined, zoom: 1 })
  const [positions, setPositions] = createSignal<Record<string, AsciiGraphPoint>>({})
  const [query, setQuery] = createSignal("")
  const [searching, setSearching] = createSignal(false)
  const [showLegend, setShowLegend] = createSignal(true)
  const [showMinimap, setShowMinimap] = createSignal(true)
  const [drag, setDrag] = createSignal<
    | { kind: "node"; id: string }
    | { kind: "pan"; x: number; y: number; viewport: ReturnType<typeof viewport> }
  >()
  let canvasBox: BoxRenderable | undefined

  const materializedFacts = createMemo(() => snapshot()?.facts.filter((fact) => fact.materialized) ?? [])
  const baseScene = createMemo(() => layoutAsciiGraph({
    nodes: materializedFacts().map((fact) => ({
      id: fact.id,
      label: compact(fact.text, 28),
      group: fact.categoryIDs[0] ?? "uncategorized",
      weight: Math.max(0, 10 - (fact.retrievalPriority ?? 10)),
    })),
    edges: snapshot()?.links ?? [],
    maxNodes: 64,
    selectedID: selectedID(),
    iterations: 180,
  }))
  const scene = createMemo(() => Object.entries(positions()).reduce(
    (current, [id, point]) => asciiGraphWithNodePosition(current, id, point),
    baseScene(),
  ))
  const wide = createMemo(() => dimensions().width >= 92 && dimensions().height >= 22)
  const inspectorWidth = createMemo(() => wide() ? 34 : 0)
  const canvasWidth = createMemo(() => Math.max(24, dimensions().width - inspectorWidth() - 4))
  const canvasHeight = createMemo(() => Math.max(8, dimensions().height - (wide() ? 5 : 11)))
  const frame = createMemo(() => renderAsciiGraph(scene(), {
    width: canvasWidth(),
    height: canvasHeight(),
    marker: "braille",
    viewport: viewport(),
    selectedID: selectedID(),
    labelMode: "neighbors",
    labelMaxLength: wide() ? 24 : 16,
  }))
  const minimap = createMemo(() => renderAsciiGraph(scene(), {
    width: Math.min(24, Math.max(14, Math.floor(canvasWidth() * 0.3))),
    height: Math.min(7, Math.max(4, Math.floor(canvasHeight() * 0.32))),
    marker: "braille",
    selectedID: selectedID(),
    labelMode: "none",
  }))
  const selectedFact = createMemo(() => snapshot()?.facts.find((fact) => fact.id === selectedID()))
  const selectedLinks = createMemo(() => (snapshot()?.links ?? []).filter((link) => link.from === selectedID() || link.to === selectedID()))
  const searchMatches = createMemo(() => {
    const needle = query().trim().toLowerCase()
    if (!needle) return []
    return materializedFacts()
      .filter((fact) => `${fact.text} ${fact.id} ${fact.categoryIDs.join(" ")}`.toLowerCase().includes(needle))
      .slice(0, 6)
  })

  createEffect(() => {
    const nodes = scene().nodes
    if (!nodes.length) {
      setSelectedID(undefined)
      return
    }
    if (nodes.some((node) => node.id === selectedID())) return
    setSelectedID(nodes.toSorted((a, b) => b.degree - a.degree || a.id.localeCompare(b.id))[0]?.id)
  })

  function consume(event: { preventDefault(): void; stopPropagation(): void }) {
    event.preventDefault()
    event.stopPropagation()
  }

  function resetView() {
    setViewport({ x: undefined, y: undefined, zoom: 1 })
  }

  function zoom(factor: number) {
    setViewport((current) => ({ ...current, zoom: Math.max(0.2, Math.min(12, current.zoom * factor)) }))
  }

  function move(direction: AsciiGraphPoint) {
    setSelectedID(asciiGraphNearestNode(scene(), selectedID(), direction))
  }

  function acceptSearch() {
    const match = searchMatches()[0]
    if (match) setSelectedID(match.id)
    setSearching(false)
  }

  useKeyboard((event) => {
    if (searching()) {
      if (event.name === "escape") {
        setSearching(false)
        consume(event)
        return
      }
      if (event.name === "return") {
        acceptSearch()
        consume(event)
        return
      }
      if (event.name === "backspace") {
        setQuery((value) => value.slice(0, -1))
        consume(event)
        return
      }
      if (!event.ctrl && !event.meta && (event.name.length === 1 || event.name === "space")) {
        setQuery((value) => `${value}${event.name === "space" ? " " : event.name}`)
        consume(event)
      }
      return
    }
    if (event.name === "escape" || event.name === "q") {
      props.api.route.navigate("home")
      consume(event)
      return
    }
    if (event.name === "f") {
      setSearching(true)
      setQuery("")
      consume(event)
      return
    }
    if (event.name === "r") {
      setRefresh((value) => value + 1)
      consume(event)
      return
    }
    if (event.name === "a") {
      resetView()
      consume(event)
      return
    }
    if (event.name === "m" && event.shift) {
      setShowMinimap((value) => !value)
      consume(event)
      return
    }
    if (event.name === "l" && event.shift) {
      setShowLegend((value) => !value)
      consume(event)
      return
    }
    if (event.name === "+" || event.name === "=") {
      zoom(1.2)
      consume(event)
      return
    }
    if (event.name === "-") {
      zoom(1 / 1.2)
      consume(event)
      return
    }
    if (event.name === "left" || event.name === "h") move({ x: -1, y: 0 })
    else if (event.name === "right" || event.name === "l") move({ x: 1, y: 0 })
    else if (event.name === "up" || event.name === "k") move({ x: 0, y: -1 })
    else if (event.name === "down" || event.name === "j") move({ x: 0, y: 1 })
    else return
    consume(event)
  })

  function mouse(event: MouseEvent) {
    if (!canvasBox || event.button !== MouseButton.LEFT) return
    const x = event.x - canvasBox.x
    const y = event.y - canvasBox.y
    if (event.type === "down") {
      const hit = Object.entries(frame().nodeCells)
        .map(([id, point]) => ({ id, distance: Math.hypot(point.x - x, point.y - y) }))
        .filter((item) => item.distance <= 2)
        .toSorted((a, b) => a.distance - b.distance)[0]
      if (hit) {
        setSelectedID(hit.id)
        setDrag({ kind: "node", id: hit.id })
      } else {
        setDrag({ kind: "pan", x, y, viewport: viewport() })
      }
      consume(event)
      return
    }
    if (event.type === "drag") {
      const state = drag()
      if (!state) return
      if (state.kind === "node") {
        setPositions((current) => ({ ...current, [state.id]: asciiGraphCellToWorld(frame(), x, y) }))
      } else {
        const transform = frame().transform
        const centerX = state.viewport.x ?? transform.centerX
        const centerY = state.viewport.y ?? transform.centerY
        setViewport({
          x: centerX - ((x - state.x) * transform.dotsX) / transform.scaleX,
          y: centerY - ((y - state.y) * transform.dotsY) / transform.scaleY,
          zoom: state.viewport.zoom,
        })
      }
      consume(event)
      return
    }
    if (event.type === "up") setDrag(undefined)
  }

  const healthLine = createMemo(() => {
    const data = snapshot()
    if (!data) return "loading persisted graph"
    return `${data.health.graphHealth} · ${data.health.connectedFacts}/${data.facts.length} connected · ${data.health.isolatedFacts} isolated · ${data.health.orphanLinks} orphan`
  })

  return (
    <box flexDirection="column" width="100%" height="100%" paddingLeft={1} paddingRight={1} overflow="hidden">
      <box flexDirection="row" height={2} flexShrink={0} justifyContent="space-between" overflow="hidden">
        <box flexDirection="column" overflow="hidden">
          <text fg={props.api.theme.current.text} wrapMode="none">Memory Graph</text>
          <text fg={props.api.theme.current.textMuted} wrapMode="none">{compact(healthLine(), Math.max(24, dimensions().width - 36))}</text>
        </box>
        <box flexDirection="column" alignItems="flex-end" overflow="hidden">
          <text fg={props.api.theme.current.textMuted} wrapMode="none">{compact(snapshot()?.root, 32)}</text>
          <text fg={props.api.theme.current.textMuted} wrapMode="none">{scene().nodes.length}/{scene().totalNodes} visible · zoom {viewport().zoom.toFixed(2)}x</text>
        </box>
      </box>

      <Show when={searching()}>
        <box height={1} flexShrink={0} overflow="hidden">
          <text fg={props.api.theme.current.success} wrapMode="none">find: {query() || "▎"}</text>
          <text fg={props.api.theme.current.textMuted} wrapMode="none"> · {searchMatches().length} matches · enter select · esc close</text>
        </box>
      </Show>

      <Show when={!snapshot.loading} fallback={<box flexGrow={1} justifyContent="center" alignItems="center"><text fg={props.api.theme.current.textMuted}>Loading memory graph…</text></box>}>
        <Show when={!snapshot.error} fallback={<box flexGrow={1} justifyContent="center" alignItems="center"><text fg={props.api.theme.current.error}>Could not read the persisted memory graph.</text></box>}>
          <Show
            when={scene().nodes.length > 0}
            fallback={
              <box flexGrow={1} justifyContent="center" alignItems="center" flexDirection="column" gap={1}>
                <text fg={props.api.theme.current.text}>No materialized graph facts yet.</text>
                <text fg={props.api.theme.current.textMuted}>Use memory_graph upsert_fact and link, then press r.</text>
              </box>
            }
          >
            <box flexDirection={wide() ? "row" : "column"} minHeight={0} flexGrow={1} gap={1} overflow="hidden">
              <box
                ref={(value: BoxRenderable) => (canvasBox = value)}
                position="relative"
                flexDirection="column"
                width={wide() ? canvasWidth() + 2 : "100%"}
                height={canvasHeight() + 2}
                minWidth={0}
                flexShrink={0}
                borderStyle="rounded"
                borderColor={props.api.theme.current.border}
                overflow="hidden"
                onMouse={mouse}
              >
                <GraphRows api={props.api} cells={frame().cells} categories={snapshot()?.categories ?? []} />
                <Show when={showMinimap()}>
                  <box
                    position="absolute"
                    right={1}
                    bottom={1}
                    zIndex={2}
                    flexDirection="column"
                    borderStyle="single"
                    borderColor={props.api.theme.current.border}
                    backgroundColor={props.api.theme.current.backgroundPanel}
                    paddingLeft={1}
                    paddingRight={1}
                  >
                    <GraphRows api={props.api} cells={minimap().cells} categories={snapshot()?.categories ?? []} />
                  </box>
                </Show>
              </box>

              <box
                flexDirection="column"
                width={wide() ? inspectorWidth() : "100%"}
                height={wide() ? "100%" : 7}
                minWidth={0}
                minHeight={0}
                paddingLeft={wide() ? 1 : 0}
                border={wide() ? ["left"] : ["top"]}
                borderColor={props.api.theme.current.border}
                overflow="hidden"
              >
                <Show when={selectedFact()} fallback={<text fg={props.api.theme.current.textMuted}>Select a node.</text>}>
                  {(fact) => (
                    <>
                      <text fg={props.api.theme.current.success} wrapMode="none">● selected · {fact().scope}</text>
                      <text fg={props.api.theme.current.text} wrapMode="word">{compact(fact().text, wide() ? 96 : dimensions().width - 4)}</text>
                      <text fg={props.api.theme.current.textMuted} wrapMode="none">{fact().categoryIDs.join(", ") || "uncategorized"}</text>
                      <For each={selectedLinks().slice(0, wide() ? 6 : 2)}>
                        {(link) => <text fg={link.kind === "conflicts" ? props.api.theme.current.warning : props.api.theme.current.textMuted} wrapMode="none">{compact(`${link.from === fact().id ? "→" : "←"} ${link.kind} ${link.from === fact().id ? link.to : link.from}`, wide() ? 31 : dimensions().width - 4)}</text>}
                      </For>
                    </>
                  )}
                </Show>
                <Show when={searching() && searchMatches().length > 0}>
                  <text fg={props.api.theme.current.textMuted} wrapMode="none">matches</text>
                  <For each={searchMatches()}>
                    {(fact, index) => <text fg={index() === 0 ? props.api.theme.current.success : props.api.theme.current.textMuted} wrapMode="none">{compact(`${index() === 0 ? "›" : " "} ${fact.text}`, wide() ? 31 : dimensions().width - 4)}</text>}
                  </For>
                </Show>
                <Show when={showLegend() && !searching()}>
                  <text fg={props.api.theme.current.textMuted} wrapMode="none">categories</text>
                  <For each={(snapshot()?.categories ?? []).filter((category) => category.count > 0).slice(0, wide() ? 6 : 2)}>
                    {(category, index) => {
                      const palette = [props.api.theme.current.primary, props.api.theme.current.secondary, props.api.theme.current.accent, props.api.theme.current.success, props.api.theme.current.info, props.api.theme.current.warning]
                      return <text fg={palette[index() % palette.length]} wrapMode="none">● {compact(category.label, wide() ? 22 : dimensions().width - 12)} · {category.count}</text>
                    }}
                  </For>
                </Show>
              </box>
            </box>
          </Show>
        </Show>
      </Show>

      <box height={1} flexShrink={0} overflow="hidden">
        <text fg={props.api.theme.current.textMuted} wrapMode="none">arrows/hjkl select · +/- zoom · drag pan/node · f find · a fit · M minimap · L legend · r refresh · q back</text>
      </box>
    </box>
  )
}

export default {
  id: "memory-graph-page-example.page",
  async tui(api: TuiPluginApi) {
    api.route.register([
      {
        name: "example-memory-graph",
        render() {
          return <MemoryGraphPage api={api} />
        },
      },
    ])

    api.command.register(() => [
      {
        title: "Memory Graph",
        value: "example.memory.graph",
        slash: { name: "memory-graph", aliases: ["graph"] },
        description: "Explore the current project's persisted memory graph.",
        category: "Memory",
        onSelect() {
          api.route.navigate("example-memory-graph")
        },
      },
    ])
  },
}
