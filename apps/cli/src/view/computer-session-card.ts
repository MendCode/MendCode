import type { ComputerSessionReport, ComputerObservation, ComputerCodeReport } from "@mendcode/protocol/wire"
import type { Line } from "../ui/theme"
import { panelGrid, type GridPanel } from "./deck"
import { wrapSpans } from "./markdown"

const titles: Record<string, string> = { computer_session: "MendCode Computer", computer_observe: "Computer observation", computer_code: "Computer code" }

export function computerSessionCard(input: { name: string; text: string; width: number; expanded: boolean; failed: boolean }): Line[] | undefined {
  const title = titles[input.name]
  if (!title) return
  const grid = (panels: GridPanel[]) => panelGrid({ width: input.width, padding: true, compact: input.width < 67, maxColumns: input.width < 106 ? 1 : 2, rows: [panels] })
  const row = (label: string, value: string, width: number) => wrapSpans([{ text: `${label} `, fg: "primary" }, { text: value, fg: "text" }], width)
  let data: ComputerSessionReport | ComputerObservation | ComputerCodeReport
  try { data = JSON.parse(input.text) } catch {
    return input.failed ? grid([{ title, body: (width) => wrapSpans([{ text: input.text, fg: "error" }], width) }]) : undefined
  }
  if (!data || typeof data !== "object") return
  if (input.name === "computer_session") {
    const session = data as ComputerSessionReport
    if (typeof session.computerSessionID !== "string" || typeof session.stopped !== "boolean") return
    if (Array.isArray(session.apps)) return grid([{ title: "Computer applications", body: (width) => session.apps!.slice(0, input.expanded ? 128 : 8).flatMap((app) => row(app.appName, `${app.bundleID}${app.pid ? ` · PID ${app.pid}` : ""}`, width)) }])
    if (session.stopped) return grid([{ title, body: (width) => row("Session", "stopped", width) }])
    if (!session.target || typeof session.target.appName !== "string" || !["observe", "control"].includes(session.mode ?? "") || !Number.isFinite(session.expiresAt)) return
    return grid([
      { title, body: (width) => [...row("Target", session.target!.appName, width), ...row("Mode", session.mode!, width), ...row("Bundle", session.target!.bundleID, width), ...row("PID", String(session.target!.pid), width)] },
      { title: "Session", body: (width) => [...row("ID", session.computerSessionID, width), ...row("Expires", new Date(session.expiresAt!).toISOString(), width), ...row("Idle", `${session.idleExpirySeconds}s`, width)] },
    ])
  }
  if (input.name === "computer_observe") {
    const observation = data as ComputerObservation
    if (!Number.isSafeInteger(observation.revision) || !observation.target || typeof observation.target.appName !== "string" || !Array.isArray(observation.nodes)) return
    const shown = observation.nodes.slice(0, input.expanded ? 12 : 5)
    if (shown.some((node) => !node || typeof node.id !== "string" || typeof node.role !== "string" || !Array.isArray(node.actions))) return
    return grid([
      { title, weight: 1, body: (width) => [...row("Target", observation.target.appName, width), ...row("Revision", String(observation.revision), width), ...row("Nodes", `${observation.nodes.length}${observation.truncated ? " · truncated" : ""}`, width), ...(input.expanded ? row("Observed", new Date(observation.observedAt).toISOString(), width) : []), ...(observation.screenshotFallback ? wrapSpans([{ text: observation.screenshotFallback, fg: "muted" }], width) : [])] },
      { title: "Accessibility", weight: 2, body: (width) => [...shown.flatMap((node) => row(node.id, `${node.role.replace(/^AX/, "")} · ${node.secure ? "redacted" : node.name || node.value || ""}${node.actions.length ? ` · ${node.actions.join(" / ")}` : ""}`, width)), ...(observation.nodes.length > shown.length ? row("More", String(observation.nodes.length - shown.length), width) : [])] },
    ])
  }
  const execution = data as ComputerCodeReport
  if (typeof execution.ok !== "boolean" || !Array.isArray(execution.toolCalls) || execution.toolCalls.some((call) => !call || typeof call.name !== "string")) return
  const value = execution.ok ? JSON.stringify(execution.value ?? null) : execution.error?.message
  if (typeof value !== "string") return
  return grid([{ title, body: (width) => [
    ...row("Result", execution.ok ? "completed" : execution.error?.kind ?? "failed", width),
    ...row("Operations", `${execution.toolCalls.length}/16${execution.toolCalls.length ? ` · ${execution.toolCalls.map((call) => call.name).join(" → ")}` : ""}`, width),
    ...wrapSpans([{ text: input.expanded ? value.slice(0, 2000) : value.slice(0, 240), fg: execution.ok ? "text" : "error" }], width),
    ...(input.expanded ? (execution.logs ?? []).slice(0, 5).flatMap((text) => row("Log", text, width)) : []),
  ] }])
}

/**
 * The one-row fact of a computer tool's result, for its card while it is closed: `Brave Browser · control`, `139 nodes`,
 * `completed · observe → press → observe`, `1600×1039`, `pressed enter`. Undefined when the result is not one of theirs.
 */
export function computerFact(name: string, text: string): string | undefined {
  let data: Record<string, any>
  try { data = JSON.parse(text) } catch { return }
  if (!data || typeof data !== "object") return
  if (name === "computer_session") {
    if (Array.isArray(data.apps)) return `${data.apps.length} app${data.apps.length === 1 ? "" : "s"}`
    if (data.stopped === true) return "stopped"
    return typeof data.target?.appName === "string" ? `${data.target.appName} · ${data.mode ?? "observe"}` : undefined
  }
  if (name === "computer_observe") return Array.isArray(data.nodes) ? `${data.target?.appName ? `${data.target.appName} · ` : ""}${data.nodes.length} nodes${data.truncated ? "+" : ""}` : undefined
  if (name === "computer_code") {
    if (typeof data.ok !== "boolean" || !Array.isArray(data.toolCalls)) return
    const steps = data.toolCalls.map((call: { name?: unknown }) => String(call?.name ?? "")).filter(Boolean)
    return `${data.ok ? "completed" : data.error?.kind ?? "failed"}${steps.length ? ` · ${steps.slice(0, 6).join(" → ")}${steps.length > 6 ? " …" : ""}` : ""}`
  }
  if (name === "computer_capture") return Number.isSafeInteger(data.width) ? `${data.width}×${data.height}${data.unchangedFrom ? " · unchanged" : ""}${data.keyboardControlAvailable === false ? " · no keyboard" : ""}` : undefined
  if (name === "computer_key") return typeof data.key === "string" ? `pressed ${data.key}` : undefined
  return
}

/** `tool_search`'s result as one fact: the tools it loaded (`3 tools · computer_key, computer_code, …`). */
export function toolSearchFact(text: string): string | undefined {
  let data: { tools?: Array<{ name?: unknown }> }
  try { data = JSON.parse(text) } catch { return }
  if (!Array.isArray(data?.tools)) return
  const names = data.tools.map((tool) => String(tool?.name ?? "")).filter(Boolean)
  if (!names.length) return "no tools"
  return `${names.length} tool${names.length === 1 ? "" : "s"} · ${names.slice(0, 3).join(", ")}${names.length > 3 ? ", …" : ""}`
}
