import type { SyntaxStyle } from "@opentui/core"
import { useTheme } from "@tui/context/theme"
import { For } from "solid-js"
import { parseTimelineDiffRows, timelineDiffFileStatus, type TimelineDiffRow, type TimelineDiffRowKind } from "./diff-parse"

export type TimelineDiffViewMode = "split" | "unified"
export type TimelineDiffWrapMode = "word" | "none"

export function TimelineDiff(props: {
  diff: string
  filetype: string
  syntaxStyle: SyntaxStyle
  view?: TimelineDiffViewMode
  wrapMode?: TimelineDiffWrapMode
  showFileRows?: boolean
}) {
  const { theme } = useTheme()
  const rows = () => {
    const parsed = parseTimelineDiffRows(props.diff)
    return props.showFileRows ? parsed : parsed.filter((row) => row.kind !== "file")
  }
  const wrapMode = () => props.wrapMode ?? "word"
  const fileStatus = () => timelineDiffFileStatus(props.diff)
  const lineNumber = (row: TimelineDiffRow) => {
    const value = row.kind === "removed" ? row.oldLine : row.newLine ?? row.oldLine
    return value === undefined ? "" : String(value)
  }
  const bg = (kind: TimelineDiffRowKind) => {
    if (kind === "added") return theme.diffAddedBg
    if (kind === "removed") return theme.diffRemovedBg
    if (fileStatus() === "added") return theme.diffAddedBg
    if (fileStatus() === "removed") return theme.diffRemovedBg
    return undefined
  }
  const fg = (kind: TimelineDiffRowKind) => {
    if (kind === "added") return theme.diffHighlightAdded
    if (kind === "removed") return theme.diffHighlightRemoved
    if (kind === "file" || kind === "meta") return theme.textMuted
    return theme.text
  }
  const lineFg = (kind: TimelineDiffRowKind) => {
    if (kind === "added") return theme.diffHighlightAdded
    if (kind === "removed") return theme.diffHighlightRemoved
    return theme.diffLineNumber
  }
  return (
    <box flexDirection="column" width="100%">
      <For each={rows()}>
        {(row) => (
          <box width="100%" flexDirection="row" backgroundColor={bg(row.kind)}>
            <box width={6} backgroundColor={bg(row.kind)}>
              <text fg={lineFg(row.kind)} wrapMode="none">
                {lineNumber(row).padStart(4, " ")}{"  "}
              </text>
            </box>
            <box flexGrow={1} backgroundColor={bg(row.kind)}>
              <text fg={fg(row.kind)} wrapMode={wrapMode()}>
                {row.text || " "}
              </text>
            </box>
          </box>
        )}
      </For>
    </box>
  )
}
