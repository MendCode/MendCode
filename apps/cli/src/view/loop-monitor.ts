import type { LoopSnapshot } from "@mendcode/protocol"
import type { Line } from "../ui/theme"
import { panelGrid, type GridPanel } from "./deck"
import { pickerFrame } from "./picker-frame"
import { wrap } from "./wrap"

/** v1's loop snapshot content in the native cell grid; no donor UI imports. */
export function renderLoopMonitor(snapshot: LoopSnapshot, width: number, height: number): Line[] {
  const { loop, events, children, scheduler } = snapshot
  const compact = width < 70
  const room = Math.max(0, height - 2)
  const lines = (text: string, w: number): Line[] => wrap(text, Math.max(1, w)).map((text) => [{ text, fg: "text" }])
  const status = [
    `State: ${loop.draft ? "draft" : loop.state} · ${loop.runs} ${loop.runs === 1 ? "run" : "runs"}`,
    `Scheduler: ${scheduler.kind}${scheduler.overdue ? " · overdue" : ""}`,
    `Next: ${loop.nextWakeAt === undefined ? "none" : new Date(loop.nextWakeAt).toISOString()}`,
    `Budget: ${loop.budget.mode}${"maxRuns" in loop.budget && loop.budget.maxRuns ? ` ≤${loop.budget.maxRuns}` : ""}`,
    ...(loop.reason ? [loop.reason] : []),
  ].join("\n")
  const objective = `${loop.objective}${loop.criteria ? `\n\nDone when: ${loop.criteria}` : ""}`
  const runs = loop.history.map((run) => `#${run.run} ${run.outcome ?? "running"}${run.checkpoint ? ` · ${run.checkpoint.summary}` : ""}`)
  const journal = (w: number) => (events.length ? events : []).flatMap((event) => lines(`${new Date(event.at).toISOString().slice(11, 19)} ${event.type} · ${event.title}`, w))
  const topHeight = compact ? Math.max(6, Math.floor((room - 1) * 0.65)) : Math.max(8, Math.floor((room - 1) * 0.45))
  const bottomHeight = Math.max(3, room - topHeight - 1)
  const journalTail = (w: number) => {
    const capacity = Math.max(0, bottomHeight - 4)
    return capacity ? journal(w).slice(-capacity) : []
  }
  const top: GridPanel[] = compact ? [{ title: "Loop", body: (w) => lines(`${status}\n\n${objective}`, w), active: true }] : [
    { title: "Objective", body: (w) => lines(objective, w), weight: 3, active: true },
    { title: "Scheduler", body: (w) => lines(`${status}\n\n${loop.sessionId}`, w), weight: 2 },
  ]
  const bottom: GridPanel[] = compact ? [{ title: "Journal", body: journalTail }] : [
    { title: "Journal", body: journalTail, weight: 3 },
    { title: "Runs / Children", body: (w) => lines([...runs, ...children.map((child) => `${child.state} · ${child.title}`)].join("\n") || "0 runs · 0 children", w), weight: 2 },
  ]
  const grid = panelGrid({ rows: [top, bottom], width, heights: [topHeight, bottomHeight], compact: false, maxColumns: compact ? 1 : 2, padding: true })
  return pickerFrame("Loop monitor", "ctrl-c stop", width, height, grid, loop.name)
}
