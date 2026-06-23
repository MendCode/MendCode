import { For, Show } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { useTheme } from "@tui/context/theme"
import { Locale } from "@/util/locale"
import { commentsForBlock, commentsForLine } from "./review-comments"
import type { ReviewFile, ReviewBlock, ReviewLine, ReviewState } from "./review-state"
import { activeReviewFile, activeReviewBlock, reviewStats } from "./review-state"
import { changesKeybindLabel } from "./keybinds"

export function ChangesHeader(props: { state: ReviewState; width: number; loading?: boolean; note?: string }) {
  const { theme } = useTheme()
  const stats = () => reviewStats(props.state.files)
  const note = () => props.note || props.state.summary || "Working tree diff review"
  return (
    <box flexDirection="row" justifyContent="space-between" height={2} overflow="hidden">
      <box flexDirection="column" overflow="hidden">
        <text attributes={TextAttributes.BOLD} fg={theme.primary} wrapMode="none">
          {Locale.truncate("Changes", Math.max(8, Math.floor(props.width * 0.35)))}
        </text>
        <text fg={theme.textMuted} wrapMode="none">
          {Locale.truncate(note(), Math.max(12, props.width - 2))}
        </text>
      </box>
      <box flexDirection="column" alignItems="flex-end" overflow="hidden">
        <text fg={theme.text} wrapMode="none">
          {props.loading ? "loading" : `${stats().files} files`}
        </text>
        <StatsText additions={stats().additions} deletions={stats().deletions} />
      </box>
    </box>
  )
}

function StatsText(props: { additions: number; deletions: number }) {
  const { theme } = useTheme()
  return (
    <box flexDirection="row" justifyContent="flex-end" gap={1} overflow="hidden">
      <text fg={theme.diffHighlightAdded} wrapMode="none">
        {`+${props.additions}`}
      </text>
      <text fg={theme.diffHighlightRemoved} wrapMode="none">
        {`-${props.deletions}`}
      </text>
    </box>
  )
}

export function ChangesKeybindBar(props: { root: string; comments: number; width: number }) {
  const { theme } = useTheme()
  const label = () => changesKeybindLabel(props.width)
  const status = () => `${props.root}  ${props.comments} comments`
  return (
    <box flexDirection="row" justifyContent="space-between" height={1} overflow="hidden">
      <text fg={theme.textMuted} wrapMode="none">
        {Locale.truncate(status(), Math.max(10, Math.floor(props.width * 0.48)))}
      </text>
      <text fg={theme.textMuted} wrapMode="none">
        {Locale.truncate(label(), Math.max(10, Math.floor(props.width * 0.5)))}
      </text>
    </box>
  )
}

export function ChangesFileNav(props: { state: ReviewState; width: number; onSelect: (file: ReviewFile) => void }) {
  const { theme } = useTheme()
  const selected = () => activeReviewFile(props.state)?.path
  return (
    <box flexDirection="column" gap={1} overflow="hidden">
      <text fg={theme.textMuted} wrapMode="none">
        Files
      </text>
      <Show when={props.state.files.length} fallback={<text fg={theme.textMuted}>No changes</text>}>
        <For each={props.state.files}>
          {(file) => {
            const active = () => selected() === file.path
            const label = () => `${active() ? ">" : " "} ${statusGlyph(file.changeType)} ${file.path}`
            return (
              <box height={1} overflow="hidden" onMouseUp={() => props.onSelect(file)}>
                <text fg={active() ? theme.primary : theme.text} wrapMode="none">
                  {Locale.truncate(label(), props.width)}
                </text>
              </box>
            )
          }}
        </For>
      </Show>
    </box>
  )
}

export function ChangesReviewStream(props: { state: ReviewState; width: number }) {
  const file = () => activeReviewFile(props.state)
  return (
    <box flexDirection="column" gap={1} overflow="hidden">
      <Show when={file()} fallback={<EmptyChanges />}>
        {(current) => (
          <>
            <FileHeader file={current()} width={props.width} />
            <For each={current().blocks}>
              {(block) => (
                <BlockView
                  state={props.state}
                  file={current()}
                  block={block}
                  selected={activeReviewBlock(props.state)?.id === block.id}
                  width={props.width}
                />
              )}
            </For>
          </>
        )}
      </Show>
    </box>
  )
}

function EmptyChanges() {
  const { theme } = useTheme()
  return (
    <box flexDirection="column" justifyContent="center" alignItems="center" minHeight={8} gap={1}>
      <text fg={theme.text}>Working tree is clean.</text>
      <text fg={theme.textMuted}>No tracked diff was found for this workspace.</text>
    </box>
  )
}

function FileHeader(props: { file: ReviewFile; width: number }) {
  const { theme } = useTheme()
  const renamed = () => props.file.previousPath && props.file.previousPath !== props.file.path
  return (
    <box
      flexDirection="column"
      borderStyle="single"
      borderColor={theme.border}
      paddingLeft={1}
      paddingRight={1}
      gap={0}
    >
      <text attributes={TextAttributes.BOLD} fg={theme.text} wrapMode="none">
        {Locale.truncate(props.file.path, Math.max(16, props.width - 4))}
      </text>
      <box flexDirection="row" gap={1} overflow="hidden">
        <text fg={theme.textMuted} wrapMode="none">
          {Locale.truncate(props.file.changeType, Math.max(3, Math.floor(props.width * 0.32)))}
        </text>
        <text fg={theme.diffHighlightAdded} wrapMode="none">
          {`+${props.file.additions}`}
        </text>
        <text fg={theme.diffHighlightRemoved} wrapMode="none">
          {`-${props.file.deletions}`}
        </text>
        <Show when={renamed()}>
          <text fg={theme.textMuted} wrapMode="none">
            {Locale.truncate(`from ${props.file.previousPath}`, Math.max(8, props.width - 18))}
          </text>
        </Show>
      </box>
    </box>
  )
}

function BlockView(props: {
  state: ReviewState
  file: ReviewFile
  block: ReviewBlock
  selected: boolean
  width: number
}) {
  const { theme } = useTheme()
  const comments = () => commentsForBlock(props.state, props.file.path, props.block.index)
  return (
    <box
      flexDirection="column"
      borderStyle="single"
      borderColor={props.selected ? theme.primary : theme.border}
      paddingLeft={1}
      paddingRight={1}
      overflow="hidden"
    >
      <box height={1} overflow="hidden">
        <text fg={props.selected ? theme.primary : theme.textMuted} wrapMode="none">
          {Locale.truncate(props.block.header, Math.max(12, props.width - 4))}
        </text>
      </box>
      <For each={props.block.lines}>
        {(line) => (
          <>
            <DiffLine line={line} width={props.width - 4} selected={props.state.selection.lineID === line.id} />
            <For
              each={commentsForLine(
                props.state,
                props.file.path,
                props.block.index,
                line.newLine ?? line.oldLine,
                line.kind === "removed" ? "old" : line.kind === "added" ? "new" : "both",
              )}
            >
              {(comment) => (
                <box flexDirection="row" overflow="hidden" paddingLeft={12}>
                  <text fg={comment.author === "user" ? theme.accent : theme.primary} wrapMode="none">
                    {Locale.truncate(`* ${comment.author}: ${comment.body}`, Math.max(12, props.width - 16))}
                  </text>
                </box>
              )}
            </For>
          </>
        )}
      </For>
      <For each={comments()}>
        {(comment) => (
          <box flexDirection="row" overflow="hidden" paddingLeft={2}>
            <text fg={comment.author === "user" ? theme.accent : theme.primary} wrapMode="none">
              {Locale.truncate(`* ${comment.author}: ${comment.body}`, Math.max(12, props.width - 6))}
            </text>
          </box>
        )}
      </For>
      <Show
        when={props.state.comments.some(
          (comment) =>
            comment.filePath === props.file.path && comment.blockIndex === props.block.index && comment.stale,
        )}
      >
        <text fg={theme.warning} wrapMode="none">
          stale comments hidden after reload
        </text>
      </Show>
    </box>
  )
}

function DiffLine(props: { line: ReviewLine; width: number; selected?: boolean }) {
  const { theme } = useTheme()
  const marker = () =>
    props.line.kind === "added" ? "+" : props.line.kind === "removed" ? "-" : props.line.kind === "meta" ? "\\" : " "
  const bg = () =>
    props.selected
      ? theme.backgroundElement
      : props.line.kind === "added"
        ? theme.diffAddedBg
        : props.line.kind === "removed"
          ? theme.diffRemovedBg
          : undefined
  const fg = () =>
    props.line.kind === "added"
      ? theme.diffHighlightAdded
      : props.line.kind === "removed"
        ? theme.diffHighlightRemoved
        : props.line.kind === "meta"
          ? theme.textMuted
          : theme.text
  const oldLine = () => (props.line.oldLine === undefined ? " " : String(props.line.oldLine))
  const newLine = () => (props.line.newLine === undefined ? " " : String(props.line.newLine))
  return (
    <box flexDirection="row" width="100%" backgroundColor={bg()} overflow="hidden">
      <box width={10} flexShrink={0} backgroundColor={bg()} overflow="hidden">
        <text fg={theme.diffLineNumber} wrapMode="none">
          {`${oldLine().padStart(4, " ")} ${newLine().padStart(4, " ")}`}
        </text>
      </box>
      <box width={2} flexShrink={0} backgroundColor={bg()}>
        <text fg={fg()} wrapMode="none">
          {props.selected ? ">" : marker()}
        </text>
      </box>
      <box flexGrow={1} minWidth={0} backgroundColor={bg()} overflow="hidden">
        <text fg={fg()} wrapMode="none">
          {Locale.truncate(props.line.text || " ", Math.max(1, props.width - 12))}
        </text>
      </box>
    </box>
  )
}

function statusGlyph(type: ReviewFile["changeType"]) {
  if (type === "new") return "+"
  if (type === "deleted") return "-"
  if (type === "rename-changed" || type === "rename-pure") return ">"
  return "~"
}
