import { TextAttributes } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { For, Show, createEffect, createMemo, createResource, createSignal, onCleanup, onMount } from "solid-js"
import type { OpencodeClient } from "@mendcode/sdk/v2"
import { routeReturnTarget, useRoute, useRouteData } from "@tui/context/route"
import { useSDK } from "@tui/context/sdk"
import { useTheme } from "@tui/context/theme"
import { useToast } from "@tui/ui/toast"
import { useDialog } from "@tui/ui/dialog"
import { DialogConfirm } from "@tui/ui/dialog-confirm"
import { CommandDeck, CommandDeckContext } from "@tui/component/command-deck"
import {
  workflowMonitorFooter,
  workflowMonitorLayout,
  workflowMonitorRows,
  workflowMonitorSessionID,
  workflowMonitorTaskRows,
} from "@tui/util/workflow-view"
import {
  workflowReceiptStateIsAnimated,
  workflowReceiptStateIsTerminal,
  workflowReceiptStateLabel,
  workflowReceiptStateMarker,
  type WorkflowReceiptSnapshot,
} from "@tui/util/workflow-receipt"

type WorkflowSnapshot = NonNullable<Awaited<ReturnType<OpencodeClient["workflow"]["show"]>>["data"]>

function errorText(error: unknown) {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error) return error
  return "Workflow request failed."
}

function short(value: string, width: number) {
  if (value.length <= width) return value
  return width <= 3 ? value.slice(0, width) : `${value.slice(0, width - 3)}...`
}

function numeric(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function optionalNumeric(value: unknown) {
  return value === undefined ? undefined : numeric(value)
}

function receipt(snapshot: WorkflowSnapshot): WorkflowReceiptSnapshot {
  return {
    definition: {
      name: snapshot.definition.name,
      description: snapshot.definition.description,
    },
    revision: {
      plan: {
        objective: snapshot.revision.plan.objective,
        model: snapshot.revision.plan.model,
      },
    },
    run: {
      id: snapshot.run.id,
      state: snapshot.run.state,
      originSessionID: snapshot.run.originSessionID,
      rootSessionID: snapshot.run.rootSessionID,
      createdAt: numeric(snapshot.run.createdAt),
      updatedAt: numeric(snapshot.run.updatedAt),
    },
    phases: snapshot.phases.map((phase) => ({
      id: phase.id,
      name: phase.name,
      taskIDs: snapshot.revision.plan.phases.find((item) => item.id === phase.id)?.taskIDs,
      state: phase.state,
      counts: phase.counts,
    })),
    tasks: snapshot.tasks.map((task) => ({
      id: task.id,
      name: task.name,
      phaseID: task.phaseID,
      state: task.state,
      blocker: task.blocker,
      attempt: task.attempt,
      sessionID: task.sessionID,
      startedAt: optionalNumeric(task.startedAt),
      completedAt: optionalNumeric(task.completedAt),
    })),
    events: snapshot.events.map((event) => ({ type: event.type, summary: event.summary, createdAt: numeric(event.createdAt) })),
    usage: snapshot.usage
      ? {
          inputTokens: numeric(snapshot.usage.inputTokens),
          outputTokens: numeric(snapshot.usage.outputTokens),
          cost: numeric(snapshot.usage.cost),
        }
      : undefined,
  }
}

function stateColor(state: string, theme: ReturnType<typeof useTheme>["theme"]) {
  if (state === "completed") return theme.success
  if (state === "failed" || state === "blocked") return theme.error
  if (state === "needs_input" || state === "awaiting_approval" || state === "paused") return theme.warning
  if (state === "working") return theme.secondary
  return theme.textMuted
}

export function Workflows() {
  const data = useRouteData("workflows")
  const route = useRoute()
  const sdk = useSDK()
  const toast = useToast()
  const dialog = useDialog()
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()
  const [refresh, setRefresh] = createSignal(0)
  const [activityFrame, setActivityFrame] = createSignal(0)
  const activityNow = () => {
    activityFrame()
    return Date.now()
  }
  const [selectedID, setSelectedID] = createSignal(data.selectedID)

  const [runs] = createResource(refresh, async () => {
    const response = await sdk.client.workflow.list({ limit: 100 })
    if (response.error) throw new Error(errorText(response.error))
    return response.data ?? []
  })

  const items = createMemo(() => runs.latest ?? runs() ?? [])
  const selected = createMemo(() => items().find((item) => item.run.id === selectedID()) ?? items()[0])
  const detailKey = createMemo(() => {
    const item = selected()
    return item ? `${item.run.id}:${numeric(item.run.updatedAt)}` : undefined
  })
  const [detail] = createResource(detailKey, async (key) => {
    const response = await sdk.client.workflow.show({ runID: key.split(":", 1)[0] })
    if (response.error) throw new Error(errorText(response.error))
    return response.data
  })
  const current = createMemo(() => {
    const item = selected()
    const loaded = detail.latest ?? detail()
    return loaded?.run.id === item?.run.id ? loaded : item
  })
  const currentReceipt = createMemo(() => {
    const item = current()
    return item ? receipt(item) : undefined
  })
  const layout = createMemo(() => workflowMonitorLayout(dimensions()))
  const monitorRows = createMemo(() => workflowMonitorRows(currentReceipt()))
  const taskRows = createMemo(() => {
    const item = current()
    return item ? workflowMonitorTaskRows(receipt(item)) : []
  })
  const selectedTask = createMemo(() => taskRows().find((task) => task.state === "failed" || task.state === "blocked" || task.state === "needs_input") ?? taskRows()[0])
  const selectedPhase = createMemo(() => current()?.phases.find((phase) => phase.state === "failed" || phase.state === "blocked" || phase.state === "needs_input") ?? current()?.phases[0])
  const summary = createMemo(() => {
    const snapshot = currentReceipt()
    if (!snapshot) return "no runs"
    const taskCount = snapshot.tasks.length
    const completed = snapshot.tasks.filter((task) => task.state === "completed").length
    return `${completed}/${taskCount} tasks · ${snapshot.phases.length} phases`
  })
  const railScrollbarVisible = createMemo(
    () => items().length * 4 > Math.max(4, dimensions().height - 10),
  )

  createEffect(() => {
    const requested = data.selectedID
    if (requested && items().some((item) => item.run.id === requested)) setSelectedID(requested)
  })

  onMount(() => {
    const timer = setInterval(() => setRefresh((value) => value + 1), 5_000)
    const animation = setInterval(() => {
      if (items().some((item) => workflowReceiptStateIsAnimated(item.run.state))) {
        setActivityFrame((value) => value + 1)
      }
    }, 180)
    const unsubscribe = sdk.event.on("event", (event) => {
      const type = event.payload?.type as string | undefined
      if (type?.startsWith("workflow.")) setRefresh((value) => value + 1)
    })
    onCleanup(() => {
      clearInterval(timer)
      clearInterval(animation)
      unsubscribe()
    })
  })

  async function control(action: "pause" | "resume" | "stop") {
    const item = current()
    if (!item) return
    if (action === "stop") {
      const confirmed = await DialogConfirm.show(dialog, "Stop workflow", `Stop ${item.definition.name || item.run.id}?`)
      dialog.clear()
      if (!confirmed) return
    }
    const response =
      action === "pause"
        ? await sdk.client.workflow.pause({ runID: item.run.id, reason: "TUI pause" })
        : action === "resume"
          ? await sdk.client.workflow.resume({ runID: item.run.id, reason: "TUI resume" })
          : await sdk.client.workflow.stop({ runID: item.run.id, reason: "TUI stop" })
    if (response.error) throw new Error(errorText(response.error))
    setRefresh((value) => value + 1)
    toast.show({ variant: "success", message: `Workflow ${action} requested.`, duration: 2500 })
  }

  async function retryTask() {
    const item = current()
    const task = selectedTask()
    if (!item || !task) return
    const response = await sdk.client.workflow.retryTask({ runID: item.run.id, taskID: task.id, reason: "TUI task retry" })
    if (response.error) throw new Error(errorText(response.error))
    setRefresh((value) => value + 1)
    toast.show({ variant: "success", message: `Task ${task.name} queued for retry.`, duration: 2500 })
  }

  async function retryPhase() {
    const item = current()
    const phase = selectedPhase()
    if (!item || !phase) return
    const response = await sdk.client.workflow.retryPhase({ runID: item.run.id, phaseID: phase.id, reason: "TUI phase retry" })
    if (response.error) throw new Error(errorText(response.error))
    setRefresh((value) => value + 1)
    toast.show({ variant: "success", message: `Phase ${phase.name} queued for retry.`, duration: 2500 })
  }

  async function deleteRun() {
    const item = current()
    if (!item) return
    if (!workflowReceiptStateIsTerminal(item.run.state)) {
      toast.show({ variant: "warning", message: "Stop the workflow before deleting it.", duration: 3000 })
      return
    }
    const confirmed = await DialogConfirm.show(
      dialog,
      "Delete workflow",
      `Permanently delete ${item.definition.name || item.run.id}?`,
    )
    dialog.clear()
    if (!confirmed) return
    const response = await sdk.client.workflow.delete({ runID: item.run.id })
    if (response.error) throw new Error(errorText(response.error))
    setSelectedID(undefined)
    setRefresh((value) => value + 1)
    toast.show({ variant: "success", message: "Workflow deleted.", duration: 2500 })
  }

  async function openSession() {
    const sessionID = workflowMonitorSessionID(currentReceipt())
    if (!sessionID) {
      toast.show({ variant: "info", message: "This workflow has no task transcript yet.", duration: 2500 })
      return
    }
    const result = await sdk.client.session.get({ sessionID }).catch(() => undefined)
    if (result?.data) return route.navigate({ type: "session", sessionID })
    toast.show({ variant: "warning", message: "The workflow task transcript was not found.", duration: 3500 })
  }

  async function openCreatorSession() {
    const sessionID = current()?.run.originSessionID
    if (!sessionID) {
      toast.show({ variant: "info", message: "This workflow has no creator chat.", duration: 2500 })
      return
    }
    const result = await sdk.client.session.get({ sessionID }).catch(() => undefined)
    if (result?.data) return route.navigate({ type: "session", sessionID })
    toast.show({ variant: "warning", message: "The workflow creator chat was not found.", duration: 3500 })
  }

  function selectOffset(offset: number) {
    const list = items()
    if (!list.length) return
    const index = Math.max(0, list.findIndex((item) => item.run.id === selected()?.run.id))
    const next = (index + offset + list.length) % list.length
    setSelectedID(list[next]?.run.id)
  }

  useKeyboard((event) => {
    if (dialog.stack.length > 0 || event.defaultPrevented) return
    const consume = () => {
      event.preventDefault()
      event.stopPropagation()
    }
    if (event.name === "escape" || event.name === "q") {
      consume()
      route.navigate(routeReturnTarget(route.data))
      return
    }
    if (event.name === "j" || event.name === "down") {
      consume()
      selectOffset(1)
      return
    }
    if (event.name === "k" || event.name === "up") {
      consume()
      selectOffset(-1)
      return
    }
    if (event.name === "r") {
      consume()
      setRefresh((value) => value + 1)
      return
    }
    if (event.name === "p" || event.name === "u" || event.name === "x") {
      consume()
      void control(event.name === "p" ? "pause" : event.name === "u" ? "resume" : "stop").catch((error) => toast.error(error))
      return
    }
    if (event.name === "t") {
      consume()
      void retryTask().catch((error) => toast.error(error))
      return
    }
    if (event.name === "f") {
      consume()
      void retryPhase().catch((error) => toast.error(error))
      return
    }
    if (event.name === "d") {
      consume()
      void deleteRun().catch((error) => toast.error(error))
      return
    }
    if (event.name === "return" || event.name === "enter" || event.name === "o") {
      consume()
      void openSession().catch((error) => toast.error(error))
      return
    }
    if (event.name === "c") {
      consume()
      void openCreatorSession().catch((error) => toast.error(error))
    }
  })

  return (
    <CommandDeck
      page="workflows"
      subtitle="durable one-shot execution · canonical snapshots"
      status={() => {
        if (runs.error) return "ERROR"
        if (runs.loading) return "SYNCING"
        const state = current()?.run.state
        return state ? `${workflowReceiptStateMarker(state, activityFrame())} ${workflowReceiptStateLabel(state).toUpperCase()}` : "READY"
      }}
      summary={summary}
      footer={() => workflowMonitorFooter(layout().compact)}
      rail={
        <box flexDirection="column" gap={1} minHeight={0}>
          <text fg={theme.primary} attributes={TextAttributes.BOLD} wrapMode="none">RUNS</text>
          <Show when={items().length > 0} fallback={<text fg={theme.textMuted} wrapMode="word">No workflow runs found.</text>}>
            <scrollbox
              flexGrow={1}
              minHeight={0}
              viewportOptions={{ paddingRight: railScrollbarVisible() ? 1 : 0 }}
              verticalScrollbarOptions={{
                paddingLeft: 1,
                visible: railScrollbarVisible(),
                trackOptions: { backgroundColor: theme.backgroundPanel, foregroundColor: theme.border },
              }}
            >
              <box flexDirection="column" gap={1}>
                <For each={items()}>
                  {(item) => {
                    const active = () => item.run.id === selected()?.run.id
                    return (
                      <box flexDirection="column" backgroundColor={active() ? theme.backgroundPanel : undefined} paddingLeft={1} paddingRight={1}>
                        <text fg={active() ? theme.secondary : theme.text} attributes={active() ? TextAttributes.BOLD : undefined} wrapMode="none">
                          {short(item.definition.name || item.run.id, 24)}
                        </text>
                        <text fg={stateColor(item.run.state, theme)} wrapMode="none">
                          {workflowReceiptStateMarker(item.run.state, activityFrame())} {item.run.state}
                        </text>
                        <text fg={theme.textMuted} wrapMode="none">{item.run.id.slice(0, 12)}</text>
                      </box>
                    )
                  }}
                </For>
              </box>
            </scrollbox>
          </Show>
        </box>
      }
      context={
        <CommandDeckContext title="WORKFLOW" rows={monitorRows()}>
          <Show when={current()}>
            {(item) => (
              <box flexDirection="column" gap={1} minHeight={0}>
                <text fg={theme.textMuted} wrapMode="word">{short(item().revision.plan.objective, 120)}</text>
                <text fg={theme.textMuted} wrapMode="none">{item().run.rootSessionID ? `root ${item().run.rootSessionID}` : "root session pending"}</text>
              </box>
            )}
          </Show>
        </CommandDeckContext>
      }
    >
      <box flexDirection={layout().stacked ? "column" : "row"} gap={1} flexGrow={1} minHeight={0}>
        <Show when={layout().stacked}>
          <box
            width="100%"
            height={8}
            borderStyle="single"
            borderColor={theme.border}
            paddingLeft={1}
            paddingRight={1}
            minHeight={0}
          >
            <scrollbox
              flexGrow={1}
              minHeight={0}
              viewportOptions={{ paddingRight: items().length > 3 ? 1 : 0 }}
              verticalScrollbarOptions={{
                paddingLeft: 1,
                visible: items().length > 3,
                trackOptions: { backgroundColor: theme.backgroundPanel, foregroundColor: theme.border },
              }}
            >
              <box flexDirection="column" gap={1}>
                <text fg={theme.primary} attributes={TextAttributes.BOLD} wrapMode="none">WORKFLOW RUNS</text>
                <For each={items()}>
                  {(item) => {
                    const active = () => item.run.id === selected()?.run.id
                    return (
                      <box flexDirection="row" height={1} overflow="hidden">
                        <text fg={active() ? theme.secondary : theme.textMuted} width={2} wrapMode="none">{active() ? "›" : " "}</text>
                        <text fg={active() ? theme.text : theme.textMuted} wrapMode="none">
                          {short(`${workflowReceiptStateMarker(item.run.state, activityFrame())} ${item.definition.name} · ${item.run.state}`, Math.max(16, layout().detailWidth - 4))}
                        </text>
                      </box>
                    )
                  }}
                </For>
                <Show when={!runs.loading && items().length === 0}>
                  <text fg={theme.textMuted} wrapMode="none">No runs in this project.</text>
                </Show>
              </box>
            </scrollbox>
          </box>
        </Show>
        <box flexGrow={1} minWidth={0} minHeight={0} borderStyle="single" borderColor={theme.border} paddingLeft={1} paddingRight={1}>
          <Show when={current()} fallback={<text fg={theme.textMuted} wrapMode="none">Select a workflow run.</text>}>
            {(item) => (
              <scrollbox
                flexGrow={1}
                minHeight={0}
                viewportOptions={{ paddingRight: 1 }}
                verticalScrollbarOptions={{
                  paddingLeft: 1,
                  visible: true,
                  trackOptions: { backgroundColor: theme.backgroundPanel, foregroundColor: theme.border },
                }}
              >
                <box flexDirection="column" gap={1} overflow="hidden">
                  <text fg={theme.secondary} attributes={TextAttributes.BOLD} wrapMode="none">{short(item().definition.name, Math.max(20, layout().detailWidth - 4))}</text>
                  <Show when={runs.error}>
                    <text fg={theme.warning} wrapMode="none">{errorText(runs.error)}</text>
                  </Show>
                  <Show when={detail.error && !runs.error}>
                    <text fg={theme.warning} wrapMode="none">Latest detail unavailable; showing the list snapshot.</text>
                  </Show>
                  <text fg={theme.textMuted} wrapMode="word">{item().definition.description || item().revision.plan.objective}</text>
                  <text fg={stateColor(item().run.state, theme)} wrapMode="none">
                    {workflowReceiptStateMarker(item().run.state, activityFrame())} {summary()}
                  </text>
                  <box borderStyle="single" borderColor={theme.border} paddingLeft={1} paddingRight={1} flexDirection="column">
                    <text fg={theme.primary} attributes={TextAttributes.BOLD} wrapMode="none">PHASES</text>
                    <For each={item().phases.slice(0, 24)}>
                      {(phase) => (
                        <box flexDirection="row" height={1} overflow="hidden">
                          <text fg={stateColor(phase.state, theme)} width={17} wrapMode="none">
                            {workflowReceiptStateMarker(phase.state, activityFrame())} {short(phase.state, 12)}
                          </text>
                          <text fg={theme.text} wrapMode="none">{short(`${phase.name} · ${phase.counts.completed}/${phase.counts.total}`, Math.max(16, layout().detailWidth - 24))}</text>
                        </box>
                      )}
                    </For>
                  </box>
                  <box borderStyle="single" borderColor={theme.border} paddingLeft={1} paddingRight={1} flexDirection="column">
                    <text fg={theme.primary} attributes={TextAttributes.BOLD} wrapMode="none">TASKS</text>
                    <For each={item().tasks.slice(0, 40)}>
                      {(task) => (
                        <box flexDirection="row" height={1} overflow="hidden">
                          <text fg={stateColor(task.state, theme)} width={17} wrapMode="none">
                            {workflowReceiptStateMarker(task.state, activityFrame())} {short(task.state, 12)}
                          </text>
                          <text fg={theme.text} wrapMode="none">
                            {short(
                              `${task.name}${task.attempt ? ` · try ${task.attempt}` : ""}${task.state === "working" && task.startedAt ? ` · ${Math.max(0, Math.round((activityNow() - numeric(task.startedAt)) / 1000))}s` : ""}${task.blocker ? ` · ${task.blocker}` : ""}`,
                              Math.max(16, layout().detailWidth - 24),
                            )}
                          </text>
                        </box>
                      )}
                    </For>
                  </box>
                  <box borderStyle="single" borderColor={theme.border} paddingLeft={1} paddingRight={1} flexDirection="column">
                    <text fg={theme.primary} attributes={TextAttributes.BOLD} wrapMode="none">LATEST EVENTS</text>
                    <For each={item().events.slice(-12).reverse()}>
                      {(event) => <text fg={event.level === "error" ? theme.error : theme.textMuted} wrapMode="word">{short(`${event.title}: ${event.summary}`, Math.max(24, layout().detailWidth - 4))}</text>}
                    </For>
                  </box>
                </box>
              </scrollbox>
            )}
          </Show>
        </box>
      </box>
    </CommandDeck>
  )
}
