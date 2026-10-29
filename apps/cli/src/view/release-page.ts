import { RELEASE_CHANNELS, type ReleaseReport } from "@mendcode/protocol/wire"
import type { Line } from "../ui/theme"
import { panelGrid } from "./deck"
import { kvList, page } from "./page"
import { wrap } from "./wrap"
import { PROGRAM_NAME } from "@mendcode/program"

export function renderReleasePage(input: { width: number; height: number; report?: ReleaseReport; selected?: number; error?: string; loading?: boolean; scroll?: number; readOnly?: boolean }): Line[] {
  const { width, height, report } = input
  const facts = (rows: string[][], inner: number) => kvList(rows.map(([label, value]) => ({ label: label!, value: value! })), inner)
  const compact = width < 70
  const room = Math.max(0, height - 5)
  const errorRows = input.error ? wrap(input.error, Math.max(1, Math.floor((width - 3) / 2) - 4)).length : 0
  const top = Math.max(11, Math.floor((room - 1) * 0.42), errorRows ? 10 + errorRows : 0)
  const policy = report?.autoupdate === true ? "Stable patches" : report?.autoupdate === "notify" ? "Notify" : "Off"
  const hints = input.readOnly ? "PgUp/PgDn scroll · esc back" : compact ? "↑↓ · enter · c · a · Pg↓ · esc" : "↑↓ select · enter save · c check · a auto · esc back"
  const grid = panelGrid({ width: Math.max(1, width - 2), compact: false, maxColumns: compact ? 1 : 2, padding: true,
    ...(!compact ? { heights: [top, Math.max(9, room - 1 - top)] } : {}), rows: [
      [{ title: "Release channel", body: (inner) => RELEASE_CHANNELS.map((channel, index): Line => [{ text: `${index === (input.selected ?? 0) ? "›" : " "} ${channel}${channel === report?.channel ? " · saved" : ""}`.padEnd(inner), fg: index === (input.selected ?? 0) ? "primary" : "text", bold: index === (input.selected ?? 0) }]) },
        { title: "Update", body: (inner) => [
          ...facts([["Running", report?.current ?? "unavailable"], ["Latest", report?.latest ?? "Not checked"], ["Status", input.loading ? "Checking…" : report?.status ?? "unchecked"], ["Automatic", policy], ["Checked", report?.lastCheckAt ? new Date(report.lastCheckAt).toISOString().replace("T", " ").slice(0, 16) : "Never"]], inner),
          ...(input.error ? [[], ...wrap(input.error, inner).map((text): Line => [{ text, fg: "error" }])] : []),
        ] }],
      [{ title: "Recovery", body: (inner) => [
        ...facts([["Installed", report?.recovery?.current ?? "No verified history"], ["Previous", report?.recovery?.previous ?? "Unavailable"]], inner), [],
        ...wrap(`${PROGRAM_NAME} upgrade --inspect`, inner).map((text): Line => [{ text, fg: "muted" }]),
        ...(report?.recovery?.previous ? wrap(`${PROGRAM_NAME} upgrade --rollback`, inner).map((text): Line => [{ text }]) : []),
      ] }, { title: "Verification", body: (inner) => [
        ...wrap("Install requires SHA256, attested release index and binary, and a valid Darwin signature on macOS.", inner).map((text): Line => [{ text }]), [],
        ...wrap(`${PROGRAM_NAME} upgrade --channel ${report?.channel ?? "stable"}`, inner).map((text): Line => [{ text, fg: "primary" }]),
      ] }],
    ] })
  return page({ title: "Release channel", summary: hints, hints: [], back: false, body: grid, width, height, scroll: Math.min(input.scroll ?? 0, Math.max(0, grid.length - room)) })
}
