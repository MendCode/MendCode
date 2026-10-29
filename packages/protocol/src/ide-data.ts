/** IDE context is private project content, available only to a local authenticated client. */
export type IdePosition = { line: number; character: number }
export type IdeEditorName = "zed" | "vscode"
export type IdeSelection = {
  filePath: string
  source: IdeEditorName
  ranges: Array<{ text: string; selection: { start: IdePosition; end: IdePosition } }>
}
export type IdeReport = {
  editor: IdeEditorName
  enabled: boolean
  status: "off" | "connected" | "empty" | "unavailable"
  selection?: IdeSelection
  message?: string
}
export type IdeOpenReport = { opened: boolean; message?: string }

export function ideSelectionKey(selection: IdeSelection | undefined) {
  return selection ? JSON.stringify(selection) : ""
}

export function ideContext(selection: IdeSelection) {
  const selected = selection.ranges.filter(({ selection: { start, end } }) => start.line !== end.line || start.character !== end.character)
  if (!selected.length) return `Note: The user opened the file ${JSON.stringify(selection.filePath)}. This may or may not be relevant to the current task.\n\n`
  return selected.map((range, index) => {
    const { start, end } = range.selection
    const label = start.line === end.line ? `#${start.line}` : `#${start.line}-${end.line}`
    // A selected code fence must not close the surrounding context fence.
    const fence = "`".repeat(Math.max(3, ...[...range.text.matchAll(/`+/g)].map((match) => match[0].length + 1)))
    return `Note: The user selected ${selected.length > 1 ? `range ${index + 1} ` : ""}${label} from ${JSON.stringify(selection.filePath)}.\n${fence}\n${range.text}\n${fence}\n\n`
  }).join("")
}
