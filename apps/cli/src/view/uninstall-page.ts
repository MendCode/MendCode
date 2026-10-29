import type { UninstallPlan } from "@mendcode/upgrade/uninstall"
import type { Line } from "../ui/theme"
import { fit, panelGrid, spread } from "./deck"
import { wrap } from "./wrap"
import path from "node:path"

const clean = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ")

/** The local uninstall review uses the same grid as daemon-backed pages, with no daemon connection. */
export function uninstallFrame(input: { plan: UninstallPlan; width: number; height: number; scroll?: number; dryRun?: boolean }): { rows: Line[]; maxScroll: number } {
  const { plan, width, height } = input
  const rows = (lines: string[], inner: number): Line[] => lines.flatMap((line) => line.split("\n").flatMap((paragraph) => wrap(clean(paragraph), inner).map((text) => [{ text, fg: "text" as const }])))
  const targets = plan.targets.map((target) => {
    const relative = path.relative(plan.dataDir, target.path)
    const display = !relative.startsWith("..") && !path.isAbsolute(relative) ? `./${relative}` : target.path
    return `${target.action} · ${target.kind} · ${target.bytes} B · ${display}${target.reason ? `\n${target.reason}` : ""}`
  })
  const compact = width < 70
  const inner = compact ? width : Math.max(1, width - 4)
  const installation = rows([plan.dataDir, `Ownership: ${plan.owned ? "database verified" : "unverified"}`, `Daemon: ${plan.daemon}${plan.pid ? ` (pid ${plan.pid})` : ""}`], inner)
  const topHeight = Math.min(height - 7, installation.length + (compact ? 2 : 4))
  const targetHeight = Math.max(3, height - topHeight - 3)
  const targetRows = rows([...(targets.length ? targets : ["No installed targets found"]), ...plan.blockers.map((message) => `Blocked: ${message}`)], inner)
  const maxScroll = Math.max(0, targetRows.length - targetHeight + (compact ? 2 : 4))
  const offset = Math.max(0, Math.min(input.scroll ?? 0, maxScroll))
  const body = panelGrid({ width, padding: true, compact, heights: [topHeight, targetHeight], rows: [
    [{ title: "Installation", body: installation }],
    [{ title: plan.blockers.length ? "Targets · blockers" : "Targets", body: targetRows, scroll: offset }],
  ] })
  const hints = input.dryRun || plan.fatal ? "↑↓ scroll · esc close" : "↑↓ scroll · y confirm · esc cancel"
  const header = spread([{ text: input.dryRun ? "Uninstall · dry run" : "Uninstall MendCode", fg: "primary", bold: true }], [{ text: hints, fg: "muted" }], width)
  const frame = [header, [], ...body]
  while (frame.length < height) frame.push([])
  return { rows: frame.slice(0, height).map((line) => fit(line, width)), maxScroll }
}
