import type { ScrollBoxRenderable } from "@opentui/core"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import { routeReturnTarget, useRoute } from "@tui/context/route"
import { useDialog } from "@tui/ui/dialog"
import { DialogPrompt } from "@tui/ui/dialog-prompt"
import { useTheme } from "@tui/context/theme"
import { useToast } from "@tui/ui/toast"
import { createEffect, createMemo, createResource, createSignal, Show } from "solid-js"
import { useProject } from "@tui/context/project"
import { loadWorkspaceDiff, type LoadedWorkspaceDiff } from "./load-diff"
import { addReviewComment } from "./review-comments"
import { reviewReload, setActiveReviewState } from "./review-actions"
import { ChangesFileNav, ChangesHeader, ChangesKeybindBar, ChangesReviewStream } from "./renderer-adapter"
import { fileNavScrollOffset } from "./file-nav"
import {
  activeReviewFile,
  activeReviewBlock,
  activeReviewLine,
  reviewLayoutForDimensions,
  selectableLineCount,
  selectedReviewLineOrdinal,
  selectFileLineByOrdinal,
  selectLineByNumber,
  selectLineByOffset,
  selectNextFile,
  selectNextBlock,
  selectNextLine,
  shouldChangesRouteHandleKey,
  type ReviewFile,
  type ReviewState,
} from "./review-state"

export function Changes() {
  const route = useRoute()
  const project = useProject()
  const dialog = useDialog()
  const toast = useToast()
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  let scroll: ScrollBoxRenderable | undefined
  let fileScroll: ScrollBoxRenderable | undefined
  let previousFileIndex: number | undefined
  const root = () => project.instance.path().worktree || project.instance.path().directory || process.cwd()
  const [reloadToken, setReloadToken] = createSignal(0)
  const [state, setState] = createSignal<ReviewState>()
  const [loaded] = createResource(
    () => `${root()}:${reloadToken()}`,
    () => Promise.resolve(loadWorkspaceDiff(root())),
  )
  const layout = createMemo(() => reviewLayoutForDimensions(dimensions()))
  const contentWidth = createMemo(() => Math.max(40, dimensions().width - 4))
  const note = createMemo(() => {
    const data = loaded()
    if (data?.error) return data.error
    if (data?.skipped.length)
      return `Working tree diff review - skipped ${data.skipped.length} large/binary files`
    return "Working tree diff review"
  })

  createEffect(() => {
    const data = loaded()
    if (!data) return
    setState(reviewReload(root(), data.diff))
  })

  createEffect(() => {
    const current = state()
    const filePath = current?.selection.filePath
    if (!current || !filePath) return
    const index = current.files.findIndex((file) => file.path === filePath)
    if (index < 0) return
    const direction = previousFileIndex === undefined ? 1 : index >= previousFileIndex ? 1 : -1
    previousFileIndex = index
    fileScroll?.scrollTo(fileNavScrollOffset(index, direction, dimensions().height))
  })

  function updateSelection(next: Partial<ReviewState["selection"]>, scrollMode?: "top" | "line") {
    const current = state()
    if (!current) return
    const updated = setActiveReviewState({ ...current, selection: { ...current.selection, ...next } })
    setState(updated)
    if (scrollMode === "top") scroll?.scrollTo(0)
    if (scrollMode === "line") scrollToSelectedLine(updated)
  }

  function scrollToSelectedLine(current: ReviewState) {
    scroll?.scrollTo(Math.max(0, selectedReviewLineOrdinal(current) - 3))
  }

  function pageLineOffset() {
    return Math.max(6, dimensions().height - 12)
  }

  async function jumpToLine() {
    const current = state()
    if (!current) return
    const value = await DialogPrompt.show(dialog, "Jump to line", {
      placeholder: "new or old line number",
    })
    dialog.clear()
    const target = Number.parseInt(value?.trim() ?? "", 10)
    if (!Number.isFinite(target) || target < 1) return
    updateSelection(selectLineByNumber(current, target), "line")
  }

  function reload() {
    setReloadToken((value) => value + 1)
    toast.show({ variant: "info", message: "Reloading changes.", duration: 1500 })
  }

  async function addComment() {
    const current = state()
    const file = current ? activeReviewFile(current) : undefined
    const block = current ? activeReviewBlock(current) : undefined
    const line = current ? activeReviewLine(current) : undefined
    if (!current || !file || !block) return
    const value = await DialogPrompt.show(dialog, "Review comment", {
      placeholder: `${file.path} ${line?.newLine ?? line?.oldLine ?? `block ${block.index + 1}`}`,
    })
    dialog.clear()
    if (!value?.trim()) return
    setState((latest) => {
      if (!latest) return latest
      return setActiveReviewState(
        addReviewComment(latest, {
          author: "user",
          filePath: file.path,
          blockIndex: block.index,
          side: line?.kind === "removed" ? "old" : line?.kind === "added" ? "new" : "both",
          line: line?.newLine ?? line?.oldLine,
          body: value,
        }),
      )
    })
  }

  useKeyboard((evt) => {
    if (!shouldChangesRouteHandleKey({ dialogOpen: dialog.stack.length > 0, defaultPrevented: evt.defaultPrevented }))
      return
    const current = state()
    if (evt.name === "escape" || evt.name === "q") {
      evt.preventDefault()
      route.navigate(routeReturnTarget(route.data))
      return
    }
    if (!current) return
    if (evt.name === "r") {
      evt.preventDefault()
      reload()
      return
    }
    if (evt.name === "n" || evt.name === "right") {
      evt.preventDefault()
      updateSelection(selectNextFile(current, 1), "top")
      return
    }
    if (evt.name === "p" || evt.name === "left") {
      evt.preventDefault()
      updateSelection(selectNextFile(current, -1), "top")
      return
    }
    if (evt.name === "]" || evt.name === "}") {
      evt.preventDefault()
      updateSelection(selectNextBlock(current, 1), "line")
      return
    }
    if (evt.name === "[" || evt.name === "{") {
      evt.preventDefault()
      updateSelection(selectNextBlock(current, -1), "line")
      return
    }
    if (evt.name === "j" || evt.name === "down") {
      evt.preventDefault()
      updateSelection(selectNextLine(current, 1), "line")
      return
    }
    if (evt.name === "k" || evt.name === "up") {
      evt.preventDefault()
      updateSelection(selectNextLine(current, -1), "line")
      return
    }
    if (evt.name === "pagedown" || (evt.name === "d" && evt.ctrl)) {
      evt.preventDefault()
      updateSelection(selectLineByOffset(current, pageLineOffset()), "line")
      return
    }
    if (evt.name === "pageup" || (evt.name === "u" && evt.ctrl)) {
      evt.preventDefault()
      updateSelection(selectLineByOffset(current, -pageLineOffset()), "line")
      return
    }
    if (evt.name === "g") {
      evt.preventDefault()
      updateSelection(selectFileLineByOrdinal(current, evt.shift ? selectableLineCount(current) - 1 : 0), "line")
      return
    }
    if (evt.name === "l") {
      evt.preventDefault()
      void jumpToLine().catch((err) => toast.error(err))
      return
    }
    if (evt.name === "c") {
      evt.preventDefault()
      void addComment().catch((err) => toast.error(err))
      return
    }
  })

  return (
    <box
      flexDirection="column"
      width="100%"
      height="100%"
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
      gap={1}
    >
      <Show when={state()} fallback={<LoadingChanges loaded={loaded()} />}>
        {(current) => (
          <>
            <ChangesHeader state={current()} width={contentWidth()} loading={loaded.loading} note={note()} />
            <Show
              when={layout().wide}
              fallback={
                <StackedChanges
                  state={current()}
                  width={contentWidth()}
                  scrollRef={(value) => (scroll = value)}
                  onSelect={updateSelection}
                />
              }
            >
              <box flexDirection="row" minHeight={0} flexGrow={1} gap={1}>
                <box
                  width={layout().sidebarWidth}
                  minHeight={0}
                  borderStyle="single"
                  borderColor={theme.border}
                  paddingLeft={1}
                  paddingRight={1}
                >
                  <scrollbox
                    ref={(value: ScrollBoxRenderable) => (fileScroll = value)}
                    flexGrow={1}
                    minHeight={0}
                    horizontalScrollbarOptions={{ visible: false }}
                    verticalScrollbarOptions={{
                      visible: true,
                      trackOptions: { backgroundColor: theme.backgroundPanel, foregroundColor: theme.border },
                    }}
                  >
                    <ChangesFileNav
                      state={current()}
                      width={layout().sidebarWidth - 5}
                      onSelect={(file) => updateSelection(selectionForFile(file), "top")}
                    />
                  </scrollbox>
                </box>
                <scrollbox
                  ref={(value: ScrollBoxRenderable) => (scroll = value)}
                  flexGrow={1}
                  minHeight={0}
                  horizontalScrollbarOptions={{ visible: false }}
                  verticalScrollbarOptions={{
                    visible: true,
                    trackOptions: { backgroundColor: theme.backgroundPanel, foregroundColor: theme.border },
                  }}
                >
                  <ChangesReviewStream state={current()} width={contentWidth() - layout().sidebarWidth - 3} />
                </scrollbox>
              </box>
            </Show>
            <ChangesKeybindBar root={root()} comments={current().comments.length} width={contentWidth()} />
          </>
        )}
      </Show>
    </box>
  )
}

function StackedChanges(props: {
  state: ReviewState
  width: number
  scrollRef: (value: ScrollBoxRenderable) => void
  onSelect: (next: Partial<ReviewState["selection"]>) => void
}) {
  const { theme } = useTheme()
  return (
    <scrollbox
      ref={props.scrollRef}
      flexGrow={1}
      minHeight={0}
      horizontalScrollbarOptions={{ visible: false }}
      verticalScrollbarOptions={{
        visible: true,
        trackOptions: { backgroundColor: theme.backgroundPanel, foregroundColor: theme.border },
      }}
    >
      <box flexDirection="column" gap={1} minHeight={0}>
        <box borderStyle="single" borderColor={theme.border} paddingLeft={1} paddingRight={1}>
          <ChangesFileNav
            state={props.state}
            width={props.width - 4}
            onSelect={(file: ReviewFile) => props.onSelect(selectionForFile(file))}
          />
        </box>
        <ChangesReviewStream state={props.state} width={props.width - 2} />
      </box>
    </scrollbox>
  )
}

function selectionForFile(file: ReviewFile): Partial<ReviewState["selection"]> {
  const block = file.blocks[0]
  return {
    filePath: file.path,
    blockIndex: block?.index,
    lineID: block?.lines.find((line) => line.kind !== "meta")?.id,
  }
}

function LoadingChanges(props: { loaded?: LoadedWorkspaceDiff }) {
  const { theme } = useTheme()
  return (
    <box flexDirection="column" width="100%" height="100%" alignItems="center" justifyContent="center" gap={1}>
      <text fg={theme.primary}>Loading changes...</text>
      <Show when={props.loaded?.error}>{(error) => <text fg={theme.error}>{error()}</text>}</Show>
    </box>
  )
}
