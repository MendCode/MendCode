import { TextAttributes } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { For, Show, createEffect, createMemo, createResource, createSignal, onCleanup, onMount } from "solid-js"
import { routeReturnTarget, useRoute, useRouteData } from "@tui/context/route"
import { useProject } from "@tui/context/project"
import { useSDK } from "@tui/context/sdk"
import { useSync } from "@tui/context/sync"
import { useTheme } from "@tui/context/theme"
import { useToast } from "@tui/ui/toast"
import { useDialog } from "@tui/ui/dialog"
import { DialogConfirm } from "@tui/ui/dialog-confirm"
import { Locale } from "@/util/locale"
import { formatDuration } from "@/util/format"
import * as Model from "../../util/model"

type LoopWorkflow = {
  id: string
  name?: string
  objective?: string
  ownerSessionID?: string
  rootSessionID?: string
  state: string
  phase?: string
  nextWakeup?: number
  spec?: {
    trigger?: { mode?: string; intervalMs?: number }
    model?: { providerID?: string; modelID?: string; variant?: string }
  }
  policy?: { maxTurns?: number }
  metrics?: { turns?: number; failures?: number }
  time?: { created?: number; updated?: number; activated?: number }
}

type LoopRun = {
  id: string
  state: string
  trigger?: string
  phase?: string
  nextWakeup?: number
  evaluatorReason?: string
  time?: { created?: number; started?: number; ended?: number; updated?: number }
}

type LoopEvent = {
  id: string
  type: string
  title: string
  summary: string
  level?: string
  sequence?: number
  sessionID?: string
  runID?: string
  time?: { created?: number; updated?: number }
}

type LoopSnapshot = {
  workflow: LoopWorkflow
  runs?: LoopRun[]
  events?: LoopEvent[]
  rootSession?: {
    id: string
    title: string
    model?: {
      providerID: string
      modelID: string
      variant?: string
    }
  }
}

type LoopView = "active" | "history"

const ACTIVE_STATES = new Set(["active", "sleeping", "working", "needs_input", "blocked", "paused"])
const TERMINAL_STATES = new Set(["completed", "failed", "stopped"])
const LOOP_EVENT_LIMIT = 200

function stateLabel(workflow: Pick<LoopWorkflow, "state" | "phase">) {
  return workflow.phase && workflow.phase !== "ready" ? `${workflow.state}: ${workflow.phase}` : workflow.state
}

function progressLabel(workflow: LoopWorkflow) {
  const turns = workflow.metrics?.turns ?? 0
  const state = workflow.state.toLowerCase()
  const phase = workflow.phase?.toLowerCase()
  const running = state === "working" || phase === "executing"
  const visible = running ? turns + 1 : turns
  const maxTurns = workflow.policy?.maxTurns
  const current = typeof maxTurns === "number" ? Math.min(visible, maxTurns) : visible
  return typeof maxTurns === "number" ? `${current}/${maxTurns}` : `${current}/open`
}

function relativeWakeup(workflow: LoopWorkflow) {
  if (TERMINAL_STATES.has(workflow.state)) return "ended"
  if (!workflow.nextWakeup) return "manual"
  const seconds = Math.max(0, Math.round((workflow.nextWakeup - Date.now()) / 1000))
  const rel = formatDuration(seconds)
  return `${rel || "now"} (${new Date(workflow.nextWakeup).toLocaleTimeString()})`
}

function cadenceLabel(workflow: LoopWorkflow) {
  const trigger = workflow.spec?.trigger
  if (!trigger?.mode) return "manual"
  if (trigger.mode !== "interval") return trigger.mode
  const ms = trigger.intervalMs
  return typeof ms === "number" ? `every ${formatDuration(Math.round(ms / 1000))}` : "interval"
}

function displayModel(providers: Parameters<typeof Model.name>[0], model: { providerID: string; modelID: string; variant?: string }) {
  const name = Model.name(providers, model.providerID, model.modelID)
  return model.variant ? `${name}/${model.variant}` : name
}

function optionalModelVariant(model: unknown) {
  if (!model || typeof model !== "object" || !("variant" in model)) return undefined
  return typeof model.variant === "string" ? model.variant : undefined
}

function modelLabel(
  providers: Parameters<typeof Model.name>[0],
  workflow: LoopWorkflow,
  rootSession?: LoopSnapshot["rootSession"],
) {
  const model = workflow.spec?.model
  if (model?.providerID && model.modelID) {
    return displayModel(providers, { providerID: model.providerID, modelID: model.modelID, variant: optionalModelVariant(model) })
  }
  if (rootSession?.model?.providerID && rootSession.model.modelID) {
    return `default: ${displayModel(providers, {
      providerID: rootSession.model.providerID,
      modelID: rootSession.model.modelID,
      variant: optionalModelVariant(rootSession.model),
    })}`
  }
  return "default: current session model"
}

function eventTimeLabel(event: LoopEvent) {
  if (!event.time?.created) return "event"
  return new Date(event.time.created).toLocaleTimeString()
}

function compact(value: string | undefined, width: number) {
  return Locale.truncateMiddle((value || "").replace(/\s+/g, " ").trim(), Math.max(4, width))
}

function fixedCell(value: string | undefined, width: number) {
  const text = compact(value, width)
  return text + " ".repeat(Math.max(0, width - Bun.stringWidth(text)))
}

function timestamp(workflow: LoopWorkflow) {
  return workflow.time?.updated ?? workflow.time?.activated ?? workflow.time?.created ?? 0
}

function timeLabel(value: number | undefined) {
  if (!value) return "unknown"
  const date = new Date(value)
  const now = new Date()
  const clock = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
  if (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  ) {
    return clock
  }
  return `${date.toLocaleDateString([], { month: "short", day: "numeric" })} ${clock}`
}

function folderName(value: string | undefined) {
  const clean = (value || "").replace(/[/\\]+$/, "")
  if (!clean) return "current project"
  return clean.split(/[/\\]/).filter(Boolean).at(-1) || clean
}

function isPrimaryLoop(workflow: LoopWorkflow) {
  return ACTIVE_STATES.has(workflow.state)
}

function sortActiveLoops(a: LoopWorkflow, b: LoopWorkflow) {
  const priority = (item: LoopWorkflow) => {
    if (item.state === "needs_input") return 0
    if (item.state === "working") return 1
    if (item.state === "sleeping") return 2
    if (item.state === "active") return 3
    if (item.state === "blocked") return 4
    if (item.state === "paused") return 5
    if (item.state === "failed") return 6
    if (item.state === "stopped") return 7
    if (item.state === "completed") return 8
    return 9
  }
  const p = priority(a) - priority(b)
  if (p) return p
  return timestamp(b) - timestamp(a)
}

function sortHistoryLoops(a: LoopWorkflow, b: LoopWorkflow) {
  return timestamp(b) - timestamp(a)
}

export function Loops() {
  const route = useRoute()
  const data = useRouteData("loops")
  const project = useProject()
  const sdk = useSDK()
  const sync = useSync()
  const { theme } = useTheme()
  const toast = useToast()
  const dialog = useDialog()
  const dimensions = useTerminalDimensions()

  const [refresh, setRefresh] = createSignal(0)
  const [view, setView] = createSignal<LoopView>("active")
  const [selectedID, setSelectedID] = createSignal(data.selectedID)
  const [now, setNow] = createSignal(Date.now())
  const [listError, setListError] = createSignal<string>()
  const [snapshotError, setSnapshotError] = createSignal<string>()

  async function fetchList() {
    const response = await sdk.fetch(`${sdk.url}/loop`, { headers: { accept: "application/json" } })
    if (!response.ok) {
      setListError(`Loop list failed: ${response.status}`)
      return []
    }
    const data = await response.json().catch(() => [])
    setListError(undefined)
    return Array.isArray(data) ? data as LoopWorkflow[] : []
  }

  async function fetchSnapshot(id: string) {
    const response = await sdk.fetch(`${sdk.url}/loop/${id}?limit=${LOOP_EVENT_LIMIT}`, { headers: { accept: "application/json" } })
    if (!response.ok) {
      setSnapshotError(`Loop snapshot failed: ${response.status}`)
      return undefined
    }
    setSnapshotError(undefined)
    return response.json() as Promise<LoopSnapshot>
  }

  const [loops] = createResource(refresh, fetchList)
  const allLoops = createMemo(() => loops.latest ?? [])
  const primaryLoops = createMemo(() => allLoops().filter(isPrimaryLoop).sort(sortActiveLoops))
  const historyLoops = createMemo(() => allLoops().filter((item) => !isPrimaryLoop(item)).sort(sortHistoryLoops))
  const visibleLoops = createMemo(() => view() === "active" ? primaryLoops() : historyLoops())
  const selected = createMemo(() => {
    const items = visibleLoops()
    if (!items.length) return undefined
    return items.find((item) => item.id === selectedID()) ?? items[0]
  })
  const [snapshot] = createResource(
    () => `${selected()?.id ?? ""}:${refresh()}`,
    (key) => {
      const id = key.split(":")[0]
      if (!id) {
        setSnapshotError(undefined)
        return undefined
      }
      return fetchSnapshot(id)
    },
  )
  const detail = createMemo(() => snapshot.latest?.workflow ?? selected())
  const width = createMemo(() => Math.max(50, dimensions().width - 4))
  const narrow = createMemo(() => dimensions().width < 118)
  const stacked = createMemo(() => dimensions().width < 96)
  const listWidth = createMemo(() => {
    if (stacked()) return width()
    return Math.max(38, Math.min(56, Math.floor(width() * 0.32)))
  })
  const detailWidth = createMemo(() => stacked() ? width() : Math.max(42, width() - listWidth() - 3))
  const activeCount = createMemo(() => primaryLoops().length)
  const historyCount = createMemo(() => historyLoops().length)
  const projectFolder = createMemo(() => folderName(project.instance.path().directory || project.instance.path().worktree))

  createEffect(() => {
    const requested = data.selectedID ? allLoops().find((item) => item.id === data.selectedID) : undefined
    if (requested && !isPrimaryLoop(requested)) setView("history")
  })

  createEffect(() => {
    const item = selected()
    if (item && item.id !== selectedID()) setSelectedID(item.id)
  })

  onMount(() => {
    const clock = setInterval(() => setNow(Date.now()), 1_000)
    const fallback = setInterval(() => setRefresh((value) => value + 1), 10_000)
    const unsubscribe = sdk.event.on("event", (event) => {
      const type = event.payload?.type as string | undefined
      if (!type?.startsWith("loop.")) return
      setRefresh((value) => value + 1)
    })
    onCleanup(() => {
      clearInterval(clock)
      clearInterval(fallback)
      unsubscribe()
    })
  })

  function switchView(next: LoopView) {
    if (view() === next) return
    setView(next)
    setSelectedID(undefined)
  }

  function selectOffset(offset: number) {
    const items = visibleLoops()
    if (!items.length) return
    const current = Math.max(0, items.findIndex((item) => item.id === selected()?.id))
    const next = (current + offset + items.length) % items.length
    setSelectedID(items[next]?.id)
  }

  async function workflowAction(action: "pause" | "resume" | "stop") {
    const item = selected()
    if (!item) return
    if (action === "stop") {
      const confirmed = await DialogConfirm.show(dialog, "Stop Loop", `Stop ${item.name || item.id}?`)
      dialog.clear()
      if (!confirmed) return
    }
    const headers = new Headers(sdk.headers)
    headers.set("content-type", "application/json")
    const response = await sdk.fetch(`${sdk.url}/loop/${item.id}/${action}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ reason: `TUI ${action}` }),
    })
    if (!response.ok) throw new Error(`${action} failed: ${response.status}`)
    setRefresh((value) => value + 1)
    toast.show({ variant: "success", message: `Loop ${action} requested.`, duration: 2500 })
  }

  function openChat() {
    const root = detail()?.rootSessionID
    if (!root) {
      toast.show({ variant: "info", message: "This loop has not created a chat session yet.", duration: 2500 })
      return
    }
    route.navigate({ type: "session", sessionID: root })
  }

  useKeyboard((evt) => {
    if (dialog.stack.length > 0 || evt.defaultPrevented) return
    const consume = () => {
      evt.preventDefault()
      evt.stopPropagation()
    }
    if (evt.name === "escape" || evt.name === "q") {
      consume()
      route.navigate(routeReturnTarget(route.data))
      return
    }
    if (evt.name === "r") {
      consume()
      setRefresh((value) => value + 1)
      return
    }
    if (evt.name === "a") {
      consume()
      switchView("active")
      return
    }
    if (evt.name === "h") {
      consume()
      switchView("history")
      return
    }
    if (evt.name === "j" || evt.name === "down") {
      consume()
      selectOffset(1)
      return
    }
    if (evt.name === "k" || evt.name === "up") {
      consume()
      selectOffset(-1)
      return
    }
    if (evt.name === "enter" || evt.name === "o") {
      consume()
      openChat()
      return
    }
    if (evt.name === "p") {
      consume()
      void workflowAction("pause").catch((error) => toast.error(error))
      return
    }
    if (evt.name === "u") {
      consume()
      void workflowAction("resume").catch((error) => toast.error(error))
      return
    }
    if (evt.name === "s") {
      consume()
      void workflowAction("stop").catch((error) => toast.error(error))
    }
  })

  const detailRows = createMemo(() => {
    const item = detail()
    if (!item) return []
    now()
    return [
      ["state", stateLabel(item)],
      ["iteration", progressLabel(item)],
      ["next", relativeWakeup(item)],
      ["cadence", cadenceLabel(item)],
      ["model", modelLabel(sync.data.provider, item, snapshot.latest?.rootSession)],
      ["chat", item.rootSessionID ?? "none yet"],
      ["updated", item.time?.updated ? new Date(item.time.updated).toLocaleTimeString() : "unknown"],
    ]
  })

  const events = createMemo(() => (snapshot.latest?.events ?? []).slice().reverse())
  const runs = createMemo(() => (snapshot.latest?.runs ?? []).slice(0, 6))

  return (
    <box flexDirection="column" width="100%" height="100%" paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1} gap={1}>
      <Header view={view()} activeCount={activeCount()} historyCount={historyCount()} width={width()} narrow={narrow()} />

      <Show
        when={allLoops().length}
        fallback={<EmptyState loading={loops.loading} error={listError()} activeCount={activeCount()} historyCount={historyCount()} view={view()} />}
      >
        <Show
          when={!stacked()}
          fallback={<StackedView view={view()} items={visibleLoops()} selected={selected()} select={setSelectedID} detail={detail()} detailRows={detailRows()} events={events()} runs={runs()} error={snapshotError()} width={width()} projectFolder={projectFolder()} />}
        >
          <box flexDirection="row" flexGrow={1} minHeight={0} gap={1}>
            <box width={listWidth()} minHeight={0} borderStyle="single" borderColor={theme.border} paddingLeft={1} paddingRight={1}>
              <LoopList view={view()} items={visibleLoops()} selected={selected()} select={setSelectedID} width={listWidth() - 4} projectFolder={projectFolder()} />
            </box>
            <box flexGrow={1} minHeight={0} borderStyle="single" borderColor={theme.border} paddingLeft={1} paddingRight={1}>
              <LoopDetail detail={detail()} rows={detailRows()} events={events()} runs={runs()} error={snapshotError()} width={detailWidth() - 4} />
            </box>
          </box>
        </Show>
      </Show>
    </box>
  )
}

function Header(props: { view: LoopView; activeCount: number; historyCount: number; width: number; narrow: boolean }) {
  const { theme } = useTheme()
  const summary = () => `active ${props.activeCount} · history ${props.historyCount} · ${props.view}`
  const keys = () => props.narrow ? "a active · h history · r refresh · o open · q back" : "a active · h history · r refresh · j/k select · o open chat · p pause · u resume · s stop · q back"
  return (
    <box flexDirection={props.narrow ? "column" : "row"} width="100%" gap={props.narrow ? 0 : 1}>
      <box flexDirection="row" width={props.narrow ? "100%" : Math.max(36, Math.floor(props.width * 0.42))}>
        <text fg={theme.secondary} attributes={TextAttributes.BOLD} wrapMode="none">Loop Workflows</text>
        <text fg={theme.textMuted} wrapMode="none"> · {Locale.truncate(summary(), Math.max(14, props.width - 18))}</text>
      </box>
      <Show when={!props.narrow}><box flexGrow={1} /></Show>
      <text fg={theme.textMuted} wrapMode="none">{Locale.truncate(keys(), Math.max(20, props.width - 2))}</text>
    </box>
  )
}

function LoopList(props: {
  view: LoopView
  items: LoopWorkflow[]
  selected?: LoopWorkflow
  select: (id: string) => void
  width: number
  projectFolder: string
}) {
  const { theme } = useTheme()
  const title = createMemo(() => props.view === "active" ? "active loops" : "history · newest first")
  return (
    <box flexDirection="column" minHeight={0}>
      <box flexDirection="row" height={1} overflow="hidden">
        <text fg={theme.textMuted} wrapMode="none">{compact(title(), Math.max(12, props.width - 4))}</text>
        <box flexGrow={1} />
        <text fg={theme.textMuted} wrapMode="none">{props.items.length}</text>
      </box>
      <box border={["top"]} borderColor={theme.border} marginTop={1} paddingTop={1} minHeight={0} flexGrow={1}>
        <scrollbox
          flexGrow={1}
          minHeight={0}
          horizontalScrollbarOptions={{ visible: false }}
          verticalScrollbarOptions={{
            visible: props.items.length > 8,
            trackOptions: { backgroundColor: theme.backgroundPanel, foregroundColor: theme.border },
          }}
        >
          <Show when={props.items.length} fallback={<text fg={theme.textMuted} wrapMode="none">{props.view === "active" ? "No active loops. Press h for history." : "No archived loops."}</text>}>
            <For each={props.items}>
              {(item, index) => (
                <LoopRow
                  item={item}
                  selected={props.selected?.id === item.id}
                  latest={props.view === "history" && index() === 0}
                  width={props.width}
                  projectFolder={props.projectFolder}
                  onSelect={() => props.select(item.id)}
                />
              )}
            </For>
          </Show>
        </scrollbox>
      </box>
    </box>
  )
}

function LoopRow(props: {
  item: LoopWorkflow
  selected: boolean
  latest: boolean
  width: number
  projectFolder: string
  onSelect: () => void
}) {
  const { theme } = useTheme()
  const color = createMemo(() =>
    props.item.state === "failed" ? theme.error :
      props.item.state === "stopped" || props.item.state === "paused" ? theme.warning :
        isPrimaryLoop(props.item) ? theme.secondary :
          theme.textMuted,
  )
  const titleWidth = createMemo(() => Math.max(10, props.width - 10))
  const detailWidth = createMemo(() => Math.max(10, props.width - 2))
  const detail = createMemo(() => {
    const when = timeLabel(timestamp(props.item))
    const status = isPrimaryLoop(props.item) ? `${stateLabel(props.item)} · next ${relativeWakeup(props.item)}` : stateLabel(props.item)
    const chat = props.item.rootSessionID ? "chat ready" : cadenceLabel(props.item)
    const lead = props.latest ? "latest · " : ""
    return `${lead}${when} · ${props.projectFolder} · ${status} · ${chat}`
  })
  return (
    <box flexDirection="column" height={3} overflow="hidden" marginBottom={1} onMouseUp={props.onSelect}>
      <box flexDirection="row" height={1} overflow="hidden">
        <text fg={props.selected ? theme.primary : color()} attributes={props.selected ? TextAttributes.BOLD : undefined} wrapMode="none">
          {props.selected ? "› " : "  "}{compact(props.item.name || props.item.objective || props.item.id, titleWidth())}
        </text>
        <box flexGrow={1} />
        <text fg={color()} wrapMode="none">{compact(progressLabel(props.item), 8)}</text>
      </box>
      <text fg={props.selected ? theme.text : theme.textMuted} wrapMode="none">  {compact(detail(), detailWidth())}</text>
    </box>
  )
}

function LoopDetail(props: {
  detail?: LoopWorkflow
  rows: string[][]
  events: LoopEvent[]
  runs: LoopRun[]
  error?: string
  width: number
}) {
  const { theme } = useTheme()
  const eventRows = createMemo(() => props.events.length * 3)
  const eventViewportHeight = createMemo(() => Math.min(18, Math.max(3, eventRows())))
  const eventScrollbarVisible = createMemo(() => eventRows() > eventViewportHeight())
  return (
    <box flexDirection="column" minHeight={0} flexGrow={1}>
      <Show when={props.detail} fallback={<text fg={theme.textMuted} wrapMode="none">Select a loop.</text>}>
        {(item) => (
          <scrollbox
            flexGrow={1}
            minHeight={0}
            horizontalScrollbarOptions={{ visible: false }}
            verticalScrollbarOptions={{ visible: false }}
          >
            <box flexDirection="column" gap={1}>
              <box flexDirection="column" gap={0}>
                <box flexDirection="row" height={1} overflow="hidden">
                  <text fg={theme.secondary} attributes={TextAttributes.BOLD} wrapMode="none" selectable={false}>
                    {compact(item().name || item().objective || item().id, Math.max(12, props.width - 18))}
                  </text>
                  <box flexGrow={1} />
                  <text fg={theme.textMuted} wrapMode="none" selectable={false}>{compact(item().id, 16)}</text>
                </box>
                <text fg={theme.textMuted} wrapMode="none" selectable={false}>{compact(item().objective, props.width)}</text>
              </box>

              <box border={["top"]} borderColor={theme.border} paddingTop={1} flexDirection="column">
                <Show when={props.error}>
                  {(error) => <text fg={theme.warning} wrapMode="none" selectable={false}>snapshot unavailable · {compact(error(), Math.max(12, props.width - 23))}</text>}
                </Show>
                <For each={props.rows}>
                  {(row) => <DetailRow label={row[0]} value={row[1]} width={props.width} emphasize={row[0] === "chat"} />}
                </For>
              </box>

              <box border={["top"]} borderColor={theme.border} paddingTop={1} flexDirection="column">
                <text fg={theme.textMuted} wrapMode="none" selectable={false}>recent runs</text>
                <Show when={props.runs.length} fallback={<text fg={theme.textMuted} wrapMode="none" selectable={false}>no runs yet</text>}>
                  <For each={props.runs}>
                    {(run) => (
                      <text fg={run.state === "failed" ? theme.error : theme.text} wrapMode="none" selectable={false}>
                        {compact(`${run.state} · ${run.trigger || "run"} · ${run.evaluatorReason || run.phase || ""}`, props.width)}
                      </text>
                    )}
                  </For>
                </Show>
              </box>

              <box border={["top"]} borderColor={theme.border} paddingTop={1} flexDirection="column">
                <box flexDirection="row" height={1} overflow="hidden">
                  <text fg={theme.textMuted} wrapMode="none" selectable={false}>events</text>
                  <box flexGrow={1} />
                  <Show when={props.events.length >= LOOP_EVENT_LIMIT}>
                    <text fg={theme.textMuted} wrapMode="none" selectable={false}>latest {LOOP_EVENT_LIMIT}</text>
                  </Show>
                </box>
                <Show when={props.events.length} fallback={<text fg={theme.textMuted} wrapMode="none" selectable={false}>no events yet</text>}>
                  <Show
                    when={eventScrollbarVisible()}
                    fallback={
                      <For each={props.events}>
                        {(event, index) => <TimelineEvent event={event} width={props.width} last={index() === props.events.length - 1} />}
                      </For>
                    }
                  >
                    <scrollbox
                      height={eventViewportHeight()}
                      horizontalScrollbarOptions={{ visible: false }}
                      verticalScrollbarOptions={{
                        visible: true,
                        trackOptions: { backgroundColor: theme.backgroundPanel, foregroundColor: theme.border },
                      }}
                    >
                      <For each={props.events}>
                        {(event, index) => <TimelineEvent event={event} width={props.width - 2} last={index() === props.events.length - 1} />}
                      </For>
                    </scrollbox>
                  </Show>
                </Show>
              </box>
            </box>
          </scrollbox>
        )}
      </Show>
    </box>
  )
}

function TimelineEvent(props: { event: LoopEvent; width: number; last: boolean }) {
  const { theme } = useTheme()
  const color = createMemo(() =>
    props.event.level === "error" || props.event.type === "failed" ? theme.error :
      props.event.type === "paused" || props.event.type === "stopped" ? theme.warning :
        props.event.type === "completed" || props.event.type === "resumed" ? theme.secondary :
          theme.textMuted,
  )
  const titleWidth = createMemo(() => Math.max(12, props.width - 8))
  const summaryWidth = createMemo(() => Math.max(12, props.width - 8))
  return (
    <box flexDirection="row" height={3} overflow="hidden">
      <box flexDirection="column" width={3} alignItems="center">
        <text fg={color()} wrapMode="none" selectable={false}>●</text>
        <text fg={props.last ? theme.textMuted : theme.border} wrapMode="none" selectable={false}>{props.last ? " " : "│"}</text>
      </box>
      <box flexDirection="column" flexGrow={1} minWidth={0}>
        <text fg={color()} wrapMode="none" selectable={false}>
          {compact(`${eventTimeLabel(props.event)} · ${props.event.type} · ${props.event.title}`, titleWidth())}
        </text>
        <text fg={theme.textMuted} wrapMode="none" selectable={false}>
          {compact(props.event.summary, summaryWidth())}
        </text>
      </box>
    </box>
  )
}

function DetailRow(props: { label: string; value: string; width: number; emphasize?: boolean }) {
  const { theme } = useTheme()
  const labelWidth = 10
  const valueWidth = createMemo(() => Math.max(8, props.width - labelWidth - 1))
  return (
    <box flexDirection="row" height={1} overflow="hidden">
      <text fg={theme.textMuted} width={labelWidth} wrapMode="none" selectable={false}>{fixedCell(props.label, labelWidth)}</text>
      <text fg={props.emphasize ? theme.secondary : theme.text} width={valueWidth()} wrapMode="none" selectable={false}>{fixedCell(props.value, valueWidth())}</text>
    </box>
  )
}

function StackedView(props: {
  view: LoopView
  items: LoopWorkflow[]
  selected?: LoopWorkflow
  select: (id: string) => void
  detail?: LoopWorkflow
  detailRows: string[][]
  events: LoopEvent[]
  runs: LoopRun[]
  error?: string
  width: number
  projectFolder: string
}) {
  const { theme } = useTheme()
  return (
    <scrollbox
      flexGrow={1}
      minHeight={0}
      horizontalScrollbarOptions={{ visible: false }}
      verticalScrollbarOptions={{
        visible: true,
        trackOptions: { backgroundColor: theme.backgroundPanel, foregroundColor: theme.border },
      }}
    >
      <box flexDirection="column" gap={1}>
        <box borderStyle="single" borderColor={theme.border} paddingLeft={1} paddingRight={1}>
          <LoopList
            view={props.view}
            items={props.items}
            selected={props.selected}
            select={props.select}
            width={props.width - 4}
            projectFolder={props.projectFolder}
          />
        </box>
        <box borderStyle="single" borderColor={theme.border} paddingLeft={1} paddingRight={1}>
          <LoopDetail detail={props.detail} rows={props.detailRows} events={props.events} runs={props.runs} error={props.error} width={props.width - 4} />
        </box>
      </box>
    </scrollbox>
  )
}

function EmptyState(props: { loading: boolean; error?: string; activeCount: number; historyCount: number; view: LoopView }) {
  const { theme } = useTheme()
  const empty = () =>
    props.view === "active" && props.historyCount > 0
      ? "No active loops. Press h to review history."
      : "No loop workflows for this project."
  return (
    <box flexDirection="column" width="100%" height="100%" alignItems="center" justifyContent="center" gap={1}>
      <text fg={props.error ? theme.warning : theme.secondary} wrapMode="none">
        {props.loading ? "Loading loop workflows..." : props.error ?? empty()}
      </text>
      <text fg={theme.textMuted} wrapMode="none">{props.error ? "Press r to retry." : "Use /loop from a session to create one."}</text>
    </box>
  )
}
