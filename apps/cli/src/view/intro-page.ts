import type { Line } from "../ui/theme"
import { appearancePage } from "./appearance-layout"
import { panelGrid, fit, lineWidth } from "./deck"
import { defaultHomeMascot, defaultActivityMascotStates } from "./mascot"
import { logoRowsFor } from "./logo-fonts"
import type { TuiProfile } from "./tui-profile"

export function renderIntroPage(input: { profile: TuiProfile; elapsedMs: number; width: number; height: number }): Line[] {
  const { elapsedMs: elapsed, width, height, profile } = input
  const phase = elapsed >= 1780 ? "handoff" : elapsed >= 1450 ? "identity" : elapsed >= 650 ? "mend" : elapsed >= 220 ? "mascot" : "signal"
  const inner = Math.max(1, width - 8)
  const full = width >= 70 && height >= 20
  const art = phase === "mend" ? defaultActivityMascotStates.patching! : defaultHomeMascot
  const artRows = art.trimEnd().split("\n")
  const artWidth = Math.max(...artRows.map((text) => lineWidth([{ text }])))
  const wordmark: Line[] = logoRowsFor(profile.logoText, profile.logoFont).map((text) => [{ text, fg: "primary" }])
  const progress = Math.max(0, Math.min(1, (elapsed - 640) / 810))
  const reveal = progress * progress * (3 - 2 * progress)
  const name: Line[] = full && wordmark.every((row) => lineWidth(row) <= inner) ? wordmark : [[{ text: "MendCode", fg: "primary" }]]
  const body: Line[] = phase === "signal" ? [[{ text: "·  ·  >", fg: "muted" }]] : phase === "handoff" ? [[{ text: "MendCode", fg: "primary", bold: true }]] : [
    ...artRows.map((text): Line => fit([{ text, fg: "text" }], artWidth)),
    [],
    ...(phase === "mascot" ? [] : name.map((row) => row.map((span) => ({ ...span, fg: "primary" as const, text: phase === "mend" ? Array.from(span.text).map((char, index) => char === " " || index < Math.ceil(lineWidth(row) * reveal) ? char : "·").join("") : span.text })))),
  ]
  const centered = body.map((row) => fit([{ text: " ".repeat(Math.max(0, Math.floor((inner - lineWidth(row)) / 2))) }, ...row], inner))
  const room = Math.max(1, height - 2)
  const padding = Array.from({ length: Math.max(0, Math.floor((room - centered.length - 4) / 2)) }, (): Line => [])
  return appearancePage({ title: "MendCode", hints: "enter skip · esc back", width, height, body: panelGrid({ rows: [[{ title: "Intro", body: [...padding, ...centered] }]], width: width - 4, heights: [room], compact: false, padding: true, maxColumns: 1 }) })
}
