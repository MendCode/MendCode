import type { Line } from "../ui/theme"
import { markCopy, markGutter, type CopyRegion } from "./line-meta"
import { formatBytes } from "./tool-data"

const GAP = "  "
const KINDS: Readonly<Record<string, string>> = { "image/png": "PNG", "image/jpeg": "JPEG", "image/webp": "WebP", "image/gif": "GIF" }

/**
 * Where a finished image tool saved its picture: `image_gen`'s `path`, else the absolute path on the last line of its text
 * (the native hosted tool prints the stored blob there, a Codex session the file Codex saved).
 */
export function generatedImagePath(input: { meta?: Record<string, unknown>; text: string }): string | undefined {
  if (typeof input.meta?.path === "string" && input.meta.path.startsWith("/")) return input.meta.path
  const last = input.text.trimEnd().split("\n").at(-1)?.trim() ?? ""
  return last.startsWith("/") && !/\s/.test(last) ? last : undefined
}

/**
 * The row under a generated picture, as v1's card had it: what the file is (`PNG · 1.2 MB`), then `open` (the system's viewer),
 * `folder` (the file shown in its folder) and `copy path`. The buttons are copy regions: `open` and `folder` carry their action,
 * `copy path` the path. The whole row is chrome, so a selection skips it.
 */
export function imageActionRow(input: { path: string; mime: string; bytes?: number; col: number; width: number }): Line {
  const facts = [KINDS[input.mime] ?? input.mime.replace(/^image\//, "").toUpperCase(), ...(input.bytes !== undefined ? [formatBytes(input.bytes)] : [])].join(" · ")
  const buttons: Array<{ text: string; region: Omit<CopyRegion, "from" | "to"> }> = [
    { text: "open", region: { text: input.path, label: "image", open: "image" } },
    { text: "folder", region: { text: input.path, label: "folder", open: "folder" } },
    { text: "copy path", region: { text: input.path, label: "image path" } },
  ]
  const row: Line = [{ text: " ".repeat(input.col) }, { text: facts, fg: "muted" }]
  const regions: CopyRegion[] = []
  let col = input.col + facts.length
  for (const button of buttons) {
    if (col + GAP.length + button.text.length > input.width) break
    row.push({ text: GAP }, { text: button.text, fg: "primary" })
    col += GAP.length
    regions.push({ from: col, to: col + button.text.length, ...button.region })
    col += button.text.length
  }
  markGutter(row, 1000)
  markCopy(row, regions)
  return row
}
