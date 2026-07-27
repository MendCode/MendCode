import type { RGBA, SyntaxStyle } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { useTheme } from "@tui/context/theme"
import { createMemo, createSignal, For, Show } from "solid-js"
import {
  parseTimelineDiffRows,
  timelineDiffFileStatus,
  timelineDiffHasPreviewMarker,
  timelineDiffIsTruncationRow,
  type TimelineDiffFileStatus,
  type TimelineDiffRow,
  type TimelineDiffRowKind,
} from "./diff-parse"

export type TimelineDiffViewMode = "split" | "unified"
export type TimelineDiffWrapMode = "word" | "none"

const MAX_RENDER_CODE_CHARS = 2_000_000
const MAX_RENDER_CODE_ROWS = 20_000
const LEGACY_CODE_PREVIEW_CHARS = 2 * 1024
const CODE_PREVIEW_MARKER = " preview truncated:"

function TimelineDiffRows(props: {
  rows: TimelineDiffRow[]
  fileStatus: TimelineDiffFileStatus
  wrapMode: TimelineDiffWrapMode
}) {
  const { theme } = useTheme()
  const lineNumber = (row: TimelineDiffRow) => {
    const value = row.kind === "removed" ? row.oldLine : row.newLine ?? row.oldLine
    return value === undefined ? "" : String(value)
  }
  const bg = (kind: TimelineDiffRowKind) => {
    if (kind === "added") return theme.diffAddedBg
    if (kind === "removed") return theme.diffRemovedBg
    if (props.fileStatus === "added") return theme.diffAddedBg
    if (props.fileStatus === "removed") return theme.diffRemovedBg
    return undefined
  }
  const fg = (kind: TimelineDiffRowKind) => {
    if (kind === "added") return theme.diffHighlightAdded
    if (kind === "removed") return theme.diffHighlightRemoved
    if (kind === "file" || kind === "meta" || kind === "context") return theme.textMuted
    return theme.text
  }
  const lineFg = (kind: TimelineDiffRowKind) => {
    if (kind === "added") return theme.diffHighlightAdded
    if (kind === "removed") return theme.diffHighlightRemoved
    return theme.diffLineNumber
  }
  return (
    <box flexDirection="column" width="100%">
      <For each={props.rows}>
        {(row) => (
          <box width="100%" flexDirection="row" backgroundColor={bg(row.kind)}>
            <box width={6} backgroundColor={bg(row.kind)}>
              <text fg={lineFg(row.kind)} wrapMode="none">
                {lineNumber(row).padStart(4, " ")} {"  "}
              </text>
            </box>
            <box flexGrow={1} backgroundColor={bg(row.kind)}>
              <text fg={fg(row.kind)} wrapMode={props.wrapMode}>
                {row.text || " "}
              </text>
            </box>
          </box>
        )}
      </For>
    </box>
  )
}

export function TimelineDiff(props: {
  diff: string
  filetype: string
  syntaxStyle: SyntaxStyle
  view?: TimelineDiffViewMode
  wrapMode?: TimelineDiffWrapMode
  showFileRows?: boolean
  loadFull?: () => Promise<string | undefined>
}) {
  const { theme } = useTheme()
  const renderer = useRenderer()
  const [fullDiff, setFullDiff] = createSignal<string>()
  const [loading, setLoading] = createSignal(false)
  const [loadError, setLoadError] = createSignal<string>()
  const source = createMemo(() => fullDiff() ?? props.diff)
  const parsedRows = createMemo(() => parseTimelineDiffRows(source()))
  const rows = createMemo(() =>
    parsedRows()
      .filter((row) => props.showFileRows || row.kind !== "file")
      .filter((row) => !timelineDiffIsTruncationRow(row)),
  )
  const fileStatus = createMemo(() => timelineDiffFileStatus(source()))
  const renderTruncated = createMemo(() => parsedRows().some(timelineDiffIsTruncationRow))
  const needsMore = createMemo(
    () => fullDiff() === undefined && (timelineDiffHasPreviewMarker(props.diff) || renderTruncated()),
  )
  const wrapMode = createMemo(() => props.wrapMode ?? "word")
  const showMoreLabel = createMemo(() => {
    if (loading()) return "Loading full diff..."
    if (loadError()) return "Full diff unavailable · retry"
    if (fullDiff() !== undefined) return "Showing the safe render limit (20,000 rows)"
    if (props.loadFull) return "Show more · load full diff"
    return "Diff preview limited"
  })

  function loadFull() {
    if (!props.loadFull || fullDiff() !== undefined || loading()) return
    setLoading(true)
    setLoadError(undefined)
    void props
      .loadFull()
      .then((value) => {
        if (value === undefined) {
          setLoadError("Full diff was not returned")
          return
        }
        setFullDiff(value)
      })
      .catch((error) => setLoadError(error instanceof Error ? error.message : String(error)))
      .finally(() => setLoading(false))
  }

  function handleShowMore() {
    if (renderer.getSelection()?.getSelectedText()) return
    loadFull()
  }

  return (
    <box flexDirection="column" width="100%">
      <TimelineDiffRows rows={rows()} fileStatus={fileStatus()} wrapMode={wrapMode()} />
      <Show when={needsMore() || renderTruncated() || loadError()}>
        <text
          fg={loadError() ? theme.error : props.loadFull && fullDiff() === undefined ? theme.primary : theme.textMuted}
          wrapMode="none"
          onMouseUp={props.loadFull && fullDiff() === undefined ? handleShowMore : undefined}
        >
          {showMoreLabel()}
        </text>
      </Show>
    </box>
  )
}

export function TimelineCode(props: {
  content: string
  filetype: string
  syntaxStyle: SyntaxStyle
  foregroundColor: RGBA
  lineNumberColor: RGBA
  backgroundColor?: RGBA
  loadFull?: () => Promise<string | undefined>
}) {
  const { theme } = useTheme()
  const renderer = useRenderer()
  const [fullContent, setFullContent] = createSignal<string>()
  const [loading, setLoading] = createSignal(false)
  const [loadError, setLoadError] = createSignal<string>()
  const source = createMemo(() => fullContent() ?? props.content)
  const rendered = createMemo(() => {
    let content = source()
    let capped = false
    if (content.length > MAX_RENDER_CODE_CHARS) {
      content = content.slice(0, MAX_RENDER_CODE_CHARS)
      capped = true
    }

    const lines = content.split(/\r?\n/)
    if (lines.length > MAX_RENDER_CODE_ROWS) {
      content = lines.slice(0, MAX_RENDER_CODE_ROWS).join("\n")
      capped = true
    }

    return {
      content: capped
        ? `${content}\n[Code preview truncated: render limit is ${MAX_RENDER_CODE_ROWS.toLocaleString()} lines.]`
        : content,
      capped,
    }
  })
  const previewTruncated = createMemo(
    () =>
      fullContent() === undefined &&
      (props.content.includes(CODE_PREVIEW_MARKER) || props.content.length >= LEGACY_CODE_PREVIEW_CHARS),
  )
  const needsMore = createMemo(() => fullContent() === undefined && (previewTruncated() || rendered().capped))
  const showMoreLabel = createMemo(() => {
    if (loading()) return "Loading full file..."
    if (loadError()) return "Full file unavailable · retry"
    if (fullContent() !== undefined && rendered().capped) return "Showing the safe render limit (20,000 lines)"
    if (props.loadFull) return "Show more · load full file"
    return "Code preview limited"
  })

  function loadFull() {
    if (!props.loadFull || fullContent() !== undefined || loading()) return
    setLoading(true)
    setLoadError(undefined)
    void props
      .loadFull()
      .then((value) => {
        if (value === undefined) {
          setLoadError("Full file was not returned")
          return
        }
        setFullContent(value.length > MAX_RENDER_CODE_CHARS ? value.slice(0, MAX_RENDER_CODE_CHARS + 1) : value)
      })
      .catch((error) => setLoadError(error instanceof Error ? error.message : String(error)))
      .finally(() => setLoading(false))
  }

  function handleShowMore() {
    if (renderer.getSelection()?.getSelectedText()) return
    loadFull()
  }

  const code = () => (
    <box width="100%" backgroundColor={props.backgroundColor}>
      <line_number fg={props.lineNumberColor} minWidth={3} paddingRight={1}>
        <code
          conceal={false}
          fg={props.foregroundColor}
          filetype={props.filetype}
          syntaxStyle={props.syntaxStyle}
          content={rendered().content}
        />
      </line_number>
    </box>
  )

  return (
    <box flexDirection="column" width="100%">
      {code()}
      <Show when={needsMore() || rendered().capped || loadError()}>
        <text
          fg={loadError() ? theme.error : props.loadFull && fullContent() === undefined ? theme.primary : theme.textMuted}
          wrapMode="none"
          onMouseUp={props.loadFull && fullContent() === undefined ? handleShowMore : undefined}
        >
          {showMoreLabel()}
        </text>
      </Show>
    </box>
  )
}
