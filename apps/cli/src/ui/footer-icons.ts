import type { FooterIconMode } from "@mendcode/protocol/wire"

/**
 * The icon in front of a footer segment (`footerIcons` in the /customize profile), in ONE table. `glyph` is plain Unicode from the
 * geometric set the app already draws (safe in every terminal font); `nerd` is a Nerd Font v3 codepoint, always written as an escape so
 * the table reads the same in every editor: nf-fa-* are the long-stable Font Awesome ones, nf-md-* the Material Design ones. A segment
 * without an entry (the state, the permission, a free text line) has no icon: it already carries its own words. `quota:<provider>`
 * entries win over `quota`.
 */
const ICONS: Readonly<Record<string, { glyph: string; nerd: string }>> = {
  directory: { glyph: "▸", nerd: "\u{F07B}" }, // nf-fa-folder
  branch: { glyph: "◇", nerd: "\u{E0A0}" }, // powerline branch
  model: { glyph: "◆", nerd: "\u{F035B}" }, // nf-md-memory
  effort: { glyph: "◈", nerd: "\u{F09D1}" }, // nf-md-brain
  context: { glyph: "●", nerd: "\u{F01BC}" }, // nf-md-database
  ctx: { glyph: "●", nerd: "\u{F01BC}" },
  cache: { glyph: "↻", nerd: "\u{F0626}" }, // nf-md-code_json
  hit: { glyph: "↻", nerd: "\u{F0626}" },
  tokens: { glyph: "▪", nerd: "\u{F1B2}" }, // nf-fa-cube
  quota: { glyph: "◎", nerd: "\u{F0200}" }, // Material Design set; one mark for every account row
  // The code graph is a branching thing; U+2387 is plain Unicode, so both modes share it.
  codegraph: { glyph: "⎇", nerd: "⎇" },
  time: { glyph: "•", nerd: "\u{F017}" }, // nf-fa-clock_o
  warm: { glyph: "◷", nerd: "\u{F251}" }, // nf-fa-hourglass_start
  today: { glyph: "▪", nerd: "\u{F073}" }, // nf-fa-calendar
  cost: { glyph: "$", nerd: "\u{F155}" }, // nf-fa-dollar
  spend: { glyph: "$", nerd: "\u{F155}" },
  tps: { glyph: "↓", nerd: "\u{F0E7}" }, // nf-fa-bolt
  // Priority processing (`/fast`): the lightning of its mode; without icons the footer says `fast`.
  fast: { glyph: "⚡", nerd: "\u{F0E7}" },
  ttft: { glyph: "•", nerd: "\u{F252}" }, // nf-fa-hourglass_half
}

/** The icon for a segment entry (`quota:codex`, `model`), or undefined for none; `ascii` (accessible or ASCII chrome) never has one. */
export function footerIcon({ entry, mode, ascii }: { entry: string; mode: FooterIconMode; ascii?: boolean }): string | undefined {
  if (mode === "none" || ascii) return undefined
  const found = ICONS[entry] ?? ICONS[entry.split(":")[0]!]
  return found ? found[mode] : undefined
}
