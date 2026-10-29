import type { ComputerCaptureMetadata, ComputerKeyReport } from "@mendcode/protocol/wire"
import type { Line } from "../ui/theme"
import { panelGrid } from "./deck"
import { wrapSpans } from "./markdown"
import { computerSessionCard } from "./computer-session-card"

export function computerCard(input: { name: string; text: string; width: number; expanded: boolean; failed: boolean }): Line[] | undefined {
  const semantic = computerSessionCard(input)
  if (semantic) return semantic
  const title = input.name === "computer_capture" ? "Computer capture" : input.name === "computer_key" ? "Computer key" : undefined
  if (!title) return
  const panel = (body: (width: number) => Line[]) => panelGrid({ width: input.width, padding: true, maxColumns: 1, rows: [[{ title, body }]] })
  if (input.failed) return panel((width) => wrapSpans([{ text: input.text, fg: "error" }], width))
  let data: ComputerCaptureMetadata | ComputerKeyReport
  try { data = JSON.parse(input.text) }
  catch { return }
  if (!data || typeof data !== "object" || typeof data.captureID !== "string") return
  const row = (label: string, value: string, width: number) => wrapSpans([{ text: `${label} `, fg: "primary" }, { text: value, fg: "text" }], width)
  if (input.name === "computer_key") {
    if (!("pressed" in data) || data.pressed !== true || typeof data.key !== "string") return
    const key = data
    return panel((width) => [
      ...row("Pressed", key.key, width),
      ...row("Capture", key.captureID, width),
      ...wrapSpans([{ text: "Capture again before the next key", fg: "muted" }], width),
    ])
  }
  if (!("width" in data) || !Number.isSafeInteger(data.width) || data.width < 1 || data.width > 1600 || !Number.isSafeInteger(data.height) || data.height < 1 || data.height > 1600 || typeof data.filePath !== "string" || typeof data.sha256 !== "string" || typeof data.keyboardControlAvailable !== "boolean" || !Number.isSafeInteger(data.capturedAt) || typeof data.coordinates !== "string") return
  const capture = data
  return panel((width) => [
    ...row("PNG", `${capture.width}×${capture.height}${capture.resized ? " · resized" : ""}`, width),
    ...row("Capture", capture.captureID, width),
    ...row("Keyboard", capture.keyboardControlAvailable ? "30s lease · one navigation key" : "unavailable for this capture", width),
    ...(capture.computerSessionBootstrapAvailable ? row("Session", "30s bootstrap · exact foreground app", width) : []),
    ...(capture.unchangedFrom ? row("Unchanged from", capture.unchangedFrom, width) : []),
    ...row("File", capture.filePath, width),
    ...(input.expanded ? [...row("SHA-256", capture.sha256, width), ...row("Captured", new Date(capture.capturedAt).toISOString(), width), ...wrapSpans([{ text: capture.coordinates, fg: "muted" }], width)] : []),
  ])
}
