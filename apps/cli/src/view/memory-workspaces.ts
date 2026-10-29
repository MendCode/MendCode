import type { MemoryWorkspace, MemoryWorkspacesReport } from "@mendcode/protocol"
import type { Line } from "../ui/theme"
import { panelGrid } from "./deck"
import { shortenMiddle } from "./session-list"
import { wrap } from "./wrap"

export type WorkspaceSelection = { view: "project" | "user" | "all"; root?: string; picking?: number }
export function workspaceOptions(report: MemoryWorkspacesReport | undefined, current?: string): Array<{ label: string; view: WorkspaceSelection["view"]; root?: string; workspace?: MemoryWorkspace | undefined }> {
  return [
    { label: "Current project", view: "project" as const, ...(current ? { root: current } : {}), workspace: report?.workspaces.find((item) => item.root === current) },
    { label: "User memories", view: "user" as const },
    { label: "All projects", view: "all" as const },
    ...(report?.workspaces ?? []).filter((item) => item.root !== current).map((item) => ({ label: item.label, view: "project" as const, root: item.root, workspace: item })),
  ]
}

export function renderWorkspacePicker(selection: WorkspaceSelection, report: MemoryWorkspacesReport | undefined, current: string | undefined, width: number, height: number): Line[] {
  const options = workspaceOptions(report, current)
  const index = Math.max(0, Math.min(selection.picking ?? 0, options.length - 1))
  const selected = options[index]!
  const row = (text: string, fg: "text" | "muted" | "primary" = "text"): Line => [{ text, fg }]
  const list = (w: number): Line[] => options.flatMap((option, i) => [row(`${i === index ? "›" : " "} ${shortenMiddle(option.label, Math.max(1, w - 2))}`, i === index ? "primary" : "text"), ...(option.root ? [row(`  ${shortenMiddle(option.root, Math.max(1, w - 2))}`, "muted")] : [])])
  const details = (w: number): Line[] => {
    const item = selected.workspace
    return item ? [row(item.label, "primary"), ...wrap(item.root, w).map((text) => row(text, "muted")), [], row(`Profile ${item.profile}`), row(`Origin ${item.source}`), row(`${item.pending} pending · ${item.saved} saved · ${item.archived} archived`), row(`${item.user} manual · ${item.agent} agent`), row(`${item.sessions} sessions`), [], ...wrap(`Group ${item.group}`, w).map((text) => row(text, "muted"))]
      : [row(selected.label, "primary"), row(selected.view === "all" ? `${report?.workspaces.length ?? 0} projects in this profile` : selected.view === "user" ? "Profile memories" : "No project history", "muted")]
  }
  return panelGrid({ width, compact: false, padding: true, maxColumns: width >= 70 ? 2 : 1, heights: [height], rows: [[
    { title: "Projects", body: (w) => width < 70 ? [...options.slice(Math.max(0, index - 1), index + 2).map((option) => row(`${option === selected ? "›" : " "} ${shortenMiddle(option.label, w - 2)}`, option === selected ? "primary" : "text")), [], ...details(w)] : list(w), active: true, scroll: width < 70 ? 0 : Math.max(0, index * 2 - height + 7), weight: 2 },
    ...(width >= 70 ? [{ title: "Origin", body: details, weight: 3 }] : []),
  ]] })
}
