import type { SyntaxStyle } from "@opentui/core"
import { useTheme } from "@tui/context/theme"
import { For } from "solid-js"
import { parseTimelineDiffRows, type TimelineDiffRow, type TimelineDiffRowKind } from "./diff-parse"

export type TimelineDiffViewMode = "split" | "unified"
export type TimelineDiffWrapMode = "word" | "none"

export function TimelineDiff(props: {
  diff: string
  filetype: string
  syntaxStyle: SyntaxStyle
  view?: TimelineDiffViewMode
  wrapMode?: TimelineDiffWrapMode
}) {
  const { theme } = useTheme()
  const rows = () => parseTimelineDiffRows(props.diff)
  const wrapMode = () => props.wrapMode ?? "word"
  const lineNumber = (row: TimelineDiffRow) => {
    const value = row.kind === "removed" ? row.oldLine : row.newLine ?? row.oldLine
    return value === undefined ? "" : String(value)
  }
  const bg = (kind: TimelineDiffRowKind) => {
    if (kind === "added") return theme.diffAddedBg
    if (kind === "removed") return theme.diffRemovedBg
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
    <box flexDirection="column" width="100%" paddingTop={1}>
      <For each={rows()}>
        {(row) => (
          <box width="100%" flexDirection="row">
            <text fg={lineFg(row.kind)} wrapMode="none" width={6}>
              {lineNumber(row).padStart(4, " ")}{"  "}
            </text>
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
