import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { For, Show, createEffect, createMemo, createResource, createSignal, onCleanup } from "solid-js"
import type { Part } from "@mendcode/sdk/v2"
import { routeReturnTarget, useRoute, useRouteData } from "@tui/context/route"
import { useSDK } from "@tui/context/sdk"
import { useTheme } from "@tui/context/theme"
import { useTuiConfig } from "@tui/context/tui-config"
import { useKeybind } from "@tui/context/keybind"
import { useDialog } from "@tui/ui/dialog"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { useToast } from "@tui/ui/toast"
import { getScrollAcceleration } from "@tui/util/scroll"
import { Locale } from "@/util/locale"
import {
  resolveSessionHistorySettings,
  nextSessionHistoryView,
  sessionHistoryLayout,
  sessionHistoryRows,
  sessionHistorySelectionOffset,
  sessionHistoryTurnItems,
  type SessionHistoryItem,
  type SessionHistoryResolvedView,
  type SessionHistoryRow,
  type SessionHistoryView,
} from "@tui/util/session-history"

type PageDirection = "latest" | "older" | "newer"

type HistoryPageRequest = {
  direction: PageDirection
  cursor?: string
  page: number
  revision: number
}

type HistoryPage = {
  items: SessionHistoryItem[]
  olderCursor?: string
  newerCursor?: string
  page: number
  direction: PageDirection
  error?: string
}

const HISTORY_VIEWS: SessionHistoryResolvedView[] = ["timeline", "tree", "pages"]
const HISTORY_STATE_LIMIT = 32

type RememberedHistoryState = {
  request: HistoryPageRequest
  selectedID?: string
  viewOverride?: SessionHistoryView
  splitOverride?: boolean
  query: string
  collapsed: string[]
}

const rememberedHistory = new Map<string, RememberedHistoryState>()

function rememberHistoryState(sessionID: string, value: RememberedHistoryState) {
  rememberedHistory.delete(sessionID)
  rememberedHistory.set(sessionID, value)
  const oldest = rememberedHistory.keys().next().value
  if (rememberedHistory.size > HISTORY_STATE_LIMIT && oldest) rememberedHistory.delete(oldest)
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function partText(parts: readonly Part[]) {
  return parts
    .flatMap((part) => (part.type === "text" && !part.synthetic && !part.ignored ? [part.text] : []))
    .join("\n\n")
    .trim()
}

function toolState(part: Extract<Part, { type: "tool" }>) {
  if (part.state.status === "completed") return "done"
  if (part.state.status === "error") return "error"
  return part.state.status
}

function toolTitle(part: Extract<Part, { type: "tool" }>) {
  if (part.state.status === "completed") return part.state.title || part.tool
  if (part.state.status === "running") return part.state.title || part.tool
  return part.tool
}

function HistoryMessage(props: {
  item: SessionHistoryItem
  showTools: "hidden" | "count" | "tree"
  showSubagents: boolean
}) {
  const { theme, syntax } = useTheme()
  const textParts = createMemo(() =>
    props.item.parts.filter(
      (part): part is Extract<Part, { type: "text" }> =>
        part.type === "text" && !part.synthetic && !part.ignored && part.text.trim().length > 0,
    ),
  )
  const tools = createMemo(() =>
    props.item.parts.filter((part): part is Extract<Part, { type: "tool" }> => part.type === "tool"),
  )
  const subtasks = createMemo(() =>
    props.item.parts.filter((part): part is Extract<Part, { type: "subtask" }> => part.type === "subtask"),
  )
  const files = createMemo(() =>
    props.item.parts.filter((part): part is Extract<Part, { type: "file" }> => part.type === "file"),
  )
  const role = createMemo(() => (props.item.info.role === "user" ? "You" : "Assistant"))

  return (
    <box
      width="100%"
      flexDirection="column"
      flexShrink={0}
      marginBottom={1}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
      backgroundColor={props.item.info.role === "user" ? theme.backgroundPanel : theme.background}
    >
      <box flexDirection="row" justifyContent="space-between" width="100%">
        <text attributes={TextAttributes.BOLD} fg={props.item.info.role === "user" ? theme.accent : theme.text}>
          {props.item.info.role === "user" ? "●" : "◆"} {role()}
        </text>
        <text fg={theme.textMuted}>{Locale.datetime(props.item.info.time.created)}</text>
      </box>
      <For each={textParts()}>
        {(part) => (
          <box width="100%" paddingTop={1}>
            <markdown
              syntaxStyle={syntax()}
              streaming={false}
              content={part.text}
              conceal={true}
              fg={theme.markdownText}
              bg={props.item.info.role === "user" ? theme.backgroundPanel : theme.background}
            />
          </box>
        )}
      </For>
      <Show when={files().length > 0}>
        <box flexDirection="column" paddingTop={1}>
          <For each={files()}>{(file) => <text fg={theme.textMuted}> file {file.filename ?? file.url}</text>}</For>
        </box>
      </Show>
      <Show when={props.showSubagents && subtasks().length > 0}>
        <box flexDirection="column" paddingTop={1}>
          <For each={subtasks()}>
            {(part) => <text fg={theme.info}> subagent {part.description || part.agent}</text>}
          </For>
        </box>
      </Show>
      <Show when={props.showTools === "count" && tools().length > 0}>
        <text fg={theme.textMuted}>
          {" "}
          ▸ {tools().length} tool call{tools().length === 1 ? "" : "s"}
        </text>
      </Show>
      <Show when={props.showTools === "tree" && tools().length > 0}>
        <box flexDirection="column" paddingTop={1}>
          <For each={tools()}>
            {(part) => (
              <text fg={part.state.status === "error" ? theme.error : theme.textMuted}>
                {"  ├─ "}
                {part.tool} · {toolTitle(part)} · {toolState(part)}
              </text>
            )}
          </For>
        </box>
      </Show>
      <Show when={props.item.partsMore}>
        <text fg={theme.warning}>
          {" "}
          This message has additional tool details; reopen it from the live session to load them.
        </text>
      </Show>
    </box>
  )
}

function HistoryPreview(props: {
  row?: SessionHistoryRow
  showTools: "hidden" | "count" | "tree"
  showSubagents: boolean
}) {
  const { theme } = useTheme()
  const turnItems = createMemo(() => props.row?.turnItems ?? [])
  const user = createMemo(() => turnItems().find((item) => item.info.role === "user"))
  const response = createMemo(() =>
    turnItems()
      .filter((item) => item.info.role === "assistant" && partText(item.parts).length > 0)
      .at(-1),
  )
  const tools = createMemo(() => turnItems().flatMap((item) => item.parts.filter((part) => part.type === "tool")))
  const subtasks = createMemo(() => turnItems().flatMap((item) => item.parts.filter((part) => part.type === "subtask")))
  return (
    <box width="100%" height="100%" flexDirection="column" paddingLeft={2} paddingRight={2} overflow="hidden">
      <Show when={props.row} fallback={<text fg={theme.textMuted}>Select a conversation turn to preview it.</text>}>
        {(row) => (
          <>
            <box flexDirection="row" justifyContent="space-between" width="100%" flexShrink={0}>
              <text attributes={TextAttributes.BOLD} fg={theme.text}>
                Conversation turn
              </text>
              <text fg={theme.textMuted}>{Locale.datetime(row().created)}</text>
            </box>
            <scrollbox
              flexGrow={1}
              minHeight={0}
              width="100%"
              horizontalScrollbarOptions={{ visible: false }}
              verticalScrollbarOptions={{
                visible: true,
                trackOptions: { backgroundColor: theme.backgroundPanel, foregroundColor: theme.border },
              }}
            >
              <box paddingTop={1} paddingRight={1} flexDirection="column">
                <text attributes={TextAttributes.BOLD} fg={theme.accent}>
                  ● You
                </text>
                <text fg={theme.text}>{user() ? partText(user()!.parts) : "Prompt is on the previous page."}</text>
              </box>
              <box paddingTop={1} paddingRight={1} flexDirection="column">
                <text attributes={TextAttributes.BOLD} fg={theme.text}>
                  ◆ Assistant
                </text>
                <text fg={theme.text}>{response() ? partText(response()!.parts) : row().preview}</text>
              </box>
              <Show when={props.showSubagents && subtasks().length > 0}>
                <box paddingTop={1} flexDirection="column">
                  <For each={subtasks()}>
                    {(part) => <text fg={theme.info}>subagent {part.type === "subtask" ? part.description : ""}</text>}
                  </For>
                </box>
              </Show>
              <Show when={props.showTools !== "hidden" && tools().length > 0}>
                <box paddingTop={1} flexDirection="column">
                  <text fg={theme.textMuted}>
                    {tools().length} tool call{tools().length === 1 ? "" : "s"}
                  </text>
                  <Show when={props.showTools === "tree"}>
                    <For each={tools()}>
                      {(part) => <text fg={theme.textMuted}> ├─ {part.type === "tool" ? part.tool : "tool"}</text>}
                    </For>
                  </Show>
                </box>
              </Show>
            </scrollbox>
          </>
        )}
      </Show>
    </box>
  )
}

export function SessionHistory() {
  const data = useRouteData("session-history")
  const route = useRoute()
  const sdk = useSDK()
  const tuiConfig = useTuiConfig()
  const keybind = useKeybind()
  const dialog = useDialog()
  const toast = useToast()
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))
  const remembered =
    tuiConfig.session_history?.remember_position === false ? undefined : rememberedHistory.get(data.sessionID)
  const [request, setRequest] = createSignal<HistoryPageRequest>(
    remembered?.request ?? { direction: "latest", page: 0, revision: 0 },
  )
  const [viewOverride, setViewOverride] = createSignal<SessionHistoryView | undefined>(remembered?.viewOverride)
  const [splitOverride, setSplitOverride] = createSignal<boolean | undefined>(remembered?.splitOverride)
  const [selectedID, setSelectedID] = createSignal(data.selectedMessageID ?? remembered?.selectedID)
  const [query, setQuery] = createSignal(remembered?.query ?? "")
  const [reader, setReader] = createSignal(false)
  const [jumpTarget, setJumpTarget] = createSignal<string>()
  const [collapsed, setCollapsed] = createSignal<ReadonlySet<string>>(new Set(remembered?.collapsed))
  let listScroll: ScrollBoxRenderable | undefined
  let revealTimer: ReturnType<typeof setTimeout> | undefined

  const settings = createMemo(() =>
    resolveSessionHistorySettings(tuiConfig.session_history, dimensions().width, viewOverride(), splitOverride()),
  )
  const layout = createMemo(() =>
    sessionHistoryLayout({
      terminalWidth: dimensions().width,
      split: settings().split,
      previewWidth: settings().previewWidth,
    }),
  )

  onCleanup(() => {
    if (revealTimer) clearTimeout(revealTimer)
    if (!settings().rememberPosition) {
      rememberedHistory.delete(data.sessionID)
      return
    }
    rememberHistoryState(data.sessionID, {
      request: request(),
      selectedID: selectedID(),
      viewOverride: viewOverride(),
      splitOverride: splitOverride(),
      query: query(),
      collapsed: [...collapsed()],
    })
  })

  async function fetchPage(source: HistoryPageRequest): Promise<HistoryPage> {
    try {
      const url = new URL(`/session/${encodeURIComponent(data.sessionID)}/message`, sdk.url)
      url.searchParams.set("limit", String(settings().pageSize))
      url.searchParams.set("view", "history")
      url.searchParams.set("unit", "turn")
      if (source.direction === "older" && source.cursor) url.searchParams.set("before", source.cursor)
      if (source.direction === "newer" && source.cursor) url.searchParams.set("after", source.cursor)
      if (sdk.directory) url.searchParams.set("directory", sdk.directory)
      const response = await sdk.fetch(url.toString(), { headers: sdk.headers })
      if (!response.ok) throw new Error(`History request failed: ${response.status} ${response.statusText}`)
      const items = (await response.json()) as SessionHistoryItem[]
      const hydratedItems = items.sort(
        (a, b) => a.info.time.created - b.info.time.created || a.info.id.localeCompare(b.info.id),
      )
      return {
        items: hydratedItems,
        olderCursor: response.headers.get("X-Older-Cursor") ?? undefined,
        newerCursor: response.headers.get("X-Newer-Cursor") ?? undefined,
        page: source.page,
        direction: source.direction,
      }
    } catch (error) {
      return { items: [], page: source.page, direction: source.direction, error: errorMessage(error) }
    }
  }

  const [page] = createResource(request, fetchPage)
  const currentPage = createMemo(() => page() ?? page.latest)
  const rows = createMemo(() =>
    sessionHistoryRows({
      items: currentPage()?.items ?? [],
      view: settings().view,
      groupBy: settings().groupBy,
      query: query(),
      collapsed: collapsed(),
    }),
  )
  const selectedRow = createMemo(() => rows().find((row) => row.id === selectedID()) ?? rows().at(0))

  function revealSelection(attempt = 0) {
    if (revealTimer) clearTimeout(revealTimer)
    revealTimer = setTimeout(
      () => {
        if (!listScroll || listScroll.isDestroyed) return
        const child = listScroll.getChildren().find((item) => item.id === `history-${selectedID()}`)
        if (!child) {
          if (attempt < 2) revealSelection(attempt + 1)
          return
        }
        const top = listScroll.y
        const bottom = top + listScroll.viewport.height - 1
        if (child.y < top) listScroll.scrollBy(child.y - top)
        else if (child.y >= bottom) listScroll.scrollBy(child.y - bottom)
      },
      attempt === 0 ? 0 : 16,
    )
  }

  createEffect(() => {
    const list = rows()
    if (!list.length) {
      setSelectedID(undefined)
      return
    }
    const target = jumpTarget()
    if (target && list.some((row) => row.id === target)) {
      setSelectedID(target)
      setJumpTarget(undefined)
      revealSelection()
      return
    }
    if (list.some((row) => row.id === selectedID())) {
      revealSelection()
      return
    }
    const direction = currentPage()?.direction
    const selected = direction === "newer" || settings().openAt === "oldest" ? list.at(0) : list.at(-1)
    setSelectedID(selected?.id)
    revealSelection()
  })

  function moveSelection(offset: number) {
    const list = rows()
    if (!list.length) return
    const index = Math.max(
      0,
      list.findIndex((row) => row.id === selectedID()),
    )
    setSelectedID(list[Math.min(list.length - 1, Math.max(0, index + offset))]?.id)
    revealSelection()
  }

  function navigatePage(direction: "older" | "newer") {
    const current = currentPage()
    const cursor = direction === "older" ? current?.olderCursor : current?.newerCursor
    if (!cursor || page.loading) return
    setReader(false)
    setRequest((value) => ({
      direction,
      cursor,
      page: Math.max(0, value.page + (direction === "older" ? 1 : -1)),
      revision: value.revision + 1,
    }))
  }

  function returnToLive() {
    route.navigate(routeReturnTarget(data))
  }

  async function searchHistory() {
    if (!settings().search) return
    const value = await DialogPrompt.show(dialog, "Quick Jump to history", {
      value: query(),
      placeholder: "prompt, response, tool, or subagent",
      description: () => (
        <text fg={theme.textMuted}>Searches backward through complete turn pages and opens the first match.</text>
      ),
    })
    dialog.clear()
    if (value === null) return
    const nextQuery = value.trim()
    setQuery(nextQuery)
    if (!nextQuery) return

    let probe: HistoryPageRequest = { direction: "latest", page: 0, revision: request().revision + 1 }
    for (let index = 0; index < settings().searchPageLimit; index++) {
      const result = await fetchPage(probe)
      if (result.error) {
        toast.show({ variant: "warning", message: result.error, duration: 3500 })
        return
      }
      const match = sessionHistoryRows({
        items: result.items,
        view: "timeline",
        groupBy: "none",
        query: nextQuery,
      }).at(0)
      if (match) {
        setJumpTarget(match.id)
        setRequest(probe)
        return
      }
      if (!result.olderCursor) break
      probe = {
        direction: "older",
        cursor: result.olderCursor,
        page: probe.page + 1,
        revision: probe.revision + 1,
      }
    }
    toast.show({ variant: "info", message: `No history match for “${nextQuery}”.`, duration: 3000 })
  }

  function cycleView() {
    let candidate = nextSessionHistoryView(settings().view)
    for (let index = 0; index < HISTORY_VIEWS.length; index++) {
      const resolved = resolveSessionHistorySettings(tuiConfig.session_history, dimensions().width, candidate).view
      if (resolved !== settings().view) {
        setViewOverride(candidate)
        return
      }
      candidate = nextSessionHistoryView(candidate)
    }
  }

  function toggleSplit() {
    setSplitOverride(!settings().split)
  }

  function toggleCollapsed(row: SessionHistoryRow | undefined, collapsedState: boolean) {
    if (!row) return
    const next = new Set(collapsed())
    if (collapsedState) next.add(row.turnID)
    else next.delete(row.turnID)
    setCollapsed(next)
    if (collapsedState && row.kind === "response") setSelectedID(`turn:${row.turnID}`)
  }

  const readerSource = createMemo(() => {
    if (!reader()) return undefined
    const selected = selectedRow()
    if (!selected) return undefined
    return { selectedID: selected.messageID, ids: selected.turnItems.map((item) => item.info.id) }
  })
  const [readerPage] = createResource(readerSource, async (source) => {
    try {
      const items = await Promise.all(
        source.ids.map(async (messageID) => {
          const result = await sdk.client.session.message(
            { sessionID: data.sessionID, messageID },
            { throwOnError: true },
          )
          return result.data as SessionHistoryItem
        }),
      )
      return items.sort((a, b) => a.info.time.created - b.info.time.created || a.info.id.localeCompare(b.info.id))
    } catch (error) {
      toast.show({
        variant: "warning",
        message: `Full history turn unavailable: ${errorMessage(error)}`,
        duration: 3500,
      })
      return selectedRow()?.turnItems ?? sessionHistoryTurnItems(currentPage()?.items ?? [], source.selectedID)
    }
  })
  const readerItems = createMemo(() => readerPage() ?? selectedRow()?.turnItems ?? [])

  useKeyboard((event) => {
    if (dialog.stack.length > 0 || event.defaultPrevented) return
    const consume = () => {
      event.preventDefault()
      event.stopPropagation()
    }
    if (keybind.match("session_history_back", event) || event.name === "q") {
      consume()
      if (reader()) setReader(false)
      else if (query()) setQuery("")
      else returnToLive()
      return
    }
    if (keybind.match("session_history_live", event)) {
      consume()
      returnToLive()
      return
    }
    if (keybind.match("session_history_search", event) && settings().search) {
      consume()
      void searchHistory()
      return
    }
    if (keybind.match("session_history_view", event) && !reader()) {
      consume()
      cycleView()
      return
    }
    if (keybind.match("session_history_split", event) && !reader()) {
      consume()
      toggleSplit()
      return
    }
    if (keybind.match("session_history_open", event)) {
      consume()
      const selected = selectedRow()
      if (selected) setReader(true)
      return
    }
    if (reader()) return
    if (event.name === "pageup") {
      consume()
      navigatePage("older")
      return
    }
    if (event.name === "pagedown") {
      consume()
      navigatePage("newer")
      return
    }
    if (event.name === "home") {
      consume()
      setSelectedID(rows().at(0)?.id)
      revealSelection()
      return
    }
    if (event.name === "end") {
      consume()
      setSelectedID(rows().at(-1)?.id)
      revealSelection()
      return
    }
    if (event.name === "left") {
      consume()
      toggleCollapsed(selectedRow(), true)
      return
    }
    if (event.name === "right") {
      consume()
      toggleCollapsed(selectedRow(), false)
      return
    }
    if (event.name === "space") {
      consume()
      const selected = selectedRow()
      toggleCollapsed(selected, selected ? !collapsed().has(selected.turnID) : false)
      return
    }
    const offset = sessionHistorySelectionOffset(event.name)
    if (offset) {
      consume()
      moveSelection(offset)
    }
  })

  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      flexDirection="column"
      paddingLeft={layout().paddingX}
      paddingRight={layout().paddingX}
      backgroundColor={theme.background}
    >
      <box flexDirection="row" justifyContent="space-between" width="100%" height={1} flexShrink={0}>
        <text fg={theme.text} wrapMode="none">
          ‹ Live session / History{reader() ? " / Turn" : ""}
        </text>
        <text fg={theme.textMuted} wrapMode="none">
          Page {request().page + 1} · {settings().view}
          {settings().split ? " + split" : ""} ·{" "}
          {sessionHistoryRows({ items: currentPage()?.items ?? [], view: "timeline", groupBy: "none" }).length} turns
          {page.loading ? " · loading…" : ""}
        </text>
      </box>
      <box flexDirection="row" width="100%" height={1} flexShrink={0} gap={1}>
        <text fg={theme.textMuted}>View:</text>
        <For each={HISTORY_VIEWS}>
          {(view) => (
            <text
              fg={settings().view === view ? theme.accent : theme.textMuted}
              attributes={settings().view === view ? TextAttributes.BOLD : undefined}
              onMouseUp={() => setViewOverride(view)}
            >
              {settings().view === view ? `[${view}]` : view}
            </text>
          )}
        </For>
        <text fg={theme.textMuted}>· v cycles</text>
        <text fg={theme.textMuted}>· Preview:</text>
        <text
          fg={settings().split ? theme.accent : theme.textMuted}
          attributes={settings().split ? TextAttributes.BOLD : undefined}
          onMouseUp={toggleSplit}
        >
          {settings().split ? "[on]" : "off"}
        </text>
        <text fg={theme.textMuted}>· {keybind.print("session_history_split")} toggles</text>
      </box>
      <Show when={query()}>
        <box flexDirection="row" width="100%" height={1} flexShrink={0}>
          <text fg={theme.accent}>/ {query()}</text>
          <text fg={theme.textMuted}> · {rows().length} matches on this page</text>
        </box>
      </Show>
      <Show when={currentPage()?.error}>
        {(error) => (
          <box width="100%" paddingTop={1} paddingBottom={1}>
            <text fg={theme.error}>{error()}</text>
            <text fg={theme.textMuted}>Press PageUp/PageDown to retry another page or Esc to return.</text>
          </box>
        )}
      </Show>
      <Show
        when={reader()}
        fallback={
          <box flexGrow={1} minHeight={0} width="100%" flexDirection="row" paddingTop={1} overflow="hidden" gap={1}>
            <box width={layout().listWidth} height="100%" minHeight={0} flexDirection="column" flexShrink={0}>
              <scrollbox
                ref={(value) => (listScroll = value)}
                flexGrow={1}
                minHeight={0}
                width="100%"
                scrollAcceleration={scrollAcceleration()}
                horizontalScrollbarOptions={{ visible: false }}
                verticalScrollbarOptions={{
                  visible: true,
                  trackOptions: { backgroundColor: theme.backgroundPanel, foregroundColor: theme.border },
                }}
              >
                <Show
                  when={rows().length > 0}
                  fallback={
                    <box paddingLeft={2} paddingTop={1}>
                      <text fg={theme.textMuted}>
                        {page.loading
                          ? "Loading history…"
                          : query()
                            ? "No matches on this page. PageUp searches older history."
                            : "No messages on this page."}
                      </text>
                    </box>
                  }
                >
                  <For each={rows()}>
                    {(row, index) => {
                      const selected = createMemo(() => selectedRow()?.id === row.id)
                      const childCount = createMemo(
                        () =>
                          row.turnItems.filter((item) => item.info.role === "assistant" && partText(item.parts)).length,
                      )
                      const tools = createMemo(() =>
                        row.turnItems.flatMap((item) => item.parts.filter((part) => part.type === "tool")),
                      )
                      const subtasks = createMemo(() =>
                        row.turnItems.flatMap((item) => item.parts.filter((part) => part.type === "subtask")),
                      )
                      const expandable = createMemo(
                        () => row.kind === "turn" && settings().view === "tree" && childCount() > 0,
                      )
                      return (
                        <>
                          <Show when={row.groupLabel}>
                            <box height={1} paddingLeft={1} marginTop={1}>
                              <text attributes={TextAttributes.BOLD} fg={theme.textMuted}>
                                {row.groupLabel}
                              </text>
                            </box>
                          </Show>
                          <box
                            id={`history-${row.id}`}
                            width="100%"
                            flexDirection="column"
                            paddingLeft={1 + row.depth * 2}
                            paddingRight={1}
                            backgroundColor={selected() ? theme.backgroundElement : theme.background}
                            onMouseUp={() => setSelectedID(row.id)}
                          >
                            <box flexDirection="row" width="100%" gap={1}>
                              <text fg={row.role === "user" ? theme.accent : theme.textMuted} flexShrink={0}>
                                {settings().view === "pages" && row.kind === "turn"
                                  ? String(index() + 1).padStart(3, "0")
                                  : expandable()
                                    ? collapsed().has(row.turnID)
                                      ? "▸"
                                      : "▾"
                                    : row.role === "user"
                                      ? "●"
                                      : "◆"}
                              </text>
                              <text
                                fg={selected() ? theme.text : row.role === "user" ? theme.text : theme.textMuted}
                                wrapMode="none"
                                flexGrow={1}
                              >
                                {Locale.truncate(row.title, Math.max(18, layout().listWidth - 18 - row.depth * 2))}
                              </text>
                              <text fg={theme.textMuted} wrapMode="none" flexShrink={0}>
                                {Locale.time(row.created)}
                              </text>
                            </box>
                            <Show when={row.kind === "turn" && settings().view !== "pages"}>
                              <text fg={theme.textMuted} wrapMode="none">
                                {`  ${row.preview}${
                                  settings().showTools !== "hidden" && row.toolCount > 0
                                    ? ` · ${row.toolCount} tool${row.toolCount === 1 ? "" : "s"}`
                                    : ""
                                }`}
                              </text>
                            </Show>
                            <Show when={settings().showSubagents && row.subagentCount > 0}>
                              <text fg={theme.info} wrapMode="none">
                                {" "}
                                {row.subagentCount} subagent{row.subagentCount === 1 ? "" : "s"}
                              </text>
                            </Show>
                            <Show when={settings().showTools === "tree" && row.kind === "turn"}>
                              <For each={tools()}>
                                {(part) => (
                                  <text fg={theme.textMuted} wrapMode="none">
                                    {" "}
                                    ├─ {part.type === "tool" ? part.tool : "tool"}
                                  </text>
                                )}
                              </For>
                            </Show>
                            <Show when={settings().showSubagents && settings().view !== "timeline"}>
                              <For each={subtasks()}>
                                {(part) => (
                                  <text fg={theme.info} wrapMode="none">
                                    {" "}
                                    └─ {part.type === "subtask" ? part.description : "subagent"}
                                  </text>
                                )}
                              </For>
                            </Show>
                          </box>
                        </>
                      )
                    }}
                  </For>
                </Show>
              </scrollbox>
            </box>
            <Show when={settings().split}>
              <box width={layout().previewWidth} height="100%" minHeight={0} flexShrink={0}>
                <HistoryPreview
                  row={selectedRow()}
                  showTools={settings().showTools}
                  showSubagents={settings().showSubagents}
                />
              </box>
            </Show>
          </box>
        }
      >
        <scrollbox
          flexGrow={1}
          minHeight={0}
          width="100%"
          paddingTop={1}
          scrollAcceleration={scrollAcceleration()}
          horizontalScrollbarOptions={{ visible: false }}
          verticalScrollbarOptions={{
            visible: true,
            trackOptions: { backgroundColor: theme.backgroundPanel, foregroundColor: theme.border },
          }}
        >
          <Show when={readerPage.loading}>
            <text fg={theme.textMuted}>Loading complete turn…</text>
          </Show>
          <For each={readerItems()}>
            {(item) => (
              <HistoryMessage item={item} showTools={settings().showTools} showSubagents={settings().showSubagents} />
            )}
          </For>
        </scrollbox>
      </Show>
      <box flexDirection="row" justifyContent="space-between" width="100%" height={1} flexShrink={0}>
        <text fg={theme.textMuted} wrapMode="none">
          {reader()
            ? `${keybind.print("session_history_back")} back · ${keybind.print("session_history_live")} live`
            : settings().view === "pages"
              ? `↑↓ select · enter open · PgDn newer · PgUp older · page ${request().page + 1}`
              : `↑↓ select · enter open · PgUp older · PgDn newer`}
        </text>
        <text fg={theme.textMuted} wrapMode="none">
          {settings().search ? `${keybind.print("session_history_search")} search · ` : ""}
          {keybind.print("session_history_view")} view · {keybind.print("session_history_split")} preview ·{" "}
          {keybind.print("session_history_live")} live
        </text>
      </box>
    </box>
  )
}
