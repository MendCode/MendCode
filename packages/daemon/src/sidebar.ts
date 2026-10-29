import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { SidebarAction, SidebarSpec, type SidebarWidget } from "@mendcode/protocol"
import { defineTool, fail } from "@mendcode/tools"

function read(file: string): Record<string, unknown> {
  try {
    const value = JSON.parse(readFileSync(file, "utf8"))
    return value && typeof value === "object" && !Array.isArray(value) ? value : {}
  } catch { return {} }
}
export function sidebarFile(dir: string, directory?: string) {
  return directory ? path.join(directory, ".mendcode", "tui", "profile.json") : path.join(dir, "tui", "profile.json")
}
export function sidebarScope(dir: string, directory: string): "user" | "project" {
  return read(sidebarFile(dir, directory)).sidebarWidgets === undefined ? "user" : "project"
}
export function readSidebar(dir: string, directory: string): SidebarWidget[] {
  const local = read(sidebarFile(dir, directory)).sidebarWidgets
  const raw = local === undefined ? read(sidebarFile(dir)).sidebarWidgets : local
  const parsed = SidebarSpec.safeParse(raw ?? [])
  return parsed.success ? parsed.data : []
}
export function updateSidebar(dir: string, directory: string, raw: unknown): SidebarWidget[] {
  const action = SidebarAction.parse(raw)
  const user = SidebarSpec.safeParse(read(sidebarFile(dir)).sidebarWidgets ?? [])
  const widgets = action.scope === "project" ? readSidebar(dir, directory) : user.success ? user.data : []
  if (action.action === "get") return widgets
  let next = [...widgets]
  if (action.action === "set") next = action.widgets
  else if (action.action === "clear") next = []
  else if (action.action === "add") {
    const at = action.index ?? next.length
    if (at > next.length) throw new Error("widget index is out of range")
    next.splice(at, 0, action.widget)
  } else {
    if (action.index >= next.length) throw new Error("widget index is out of range")
    if (action.action === "remove") next.splice(action.index, 1)
    else {
      if (action.to >= next.length) throw new Error("destination is out of range")
      next.splice(action.to, 0, next.splice(action.index, 1)[0]!)
    }
  }
  next = SidebarSpec.parse(next)
  const file = sidebarFile(dir, action.scope === "project" ? directory : undefined)
  mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify({ ...read(file), sidebarWidgets: next, rightSidebar: next.length > 0 }, null, 2) + "\n")
  renameSync(temp, file)
  return readSidebar(dir, directory)
}
export function createSidebarTool(dir: string, changed: (directory: string | undefined, widgets: SidebarWidget[]) => void) {
  return defineTool({
    name: "sidebar",
    permission: "write",
    description: "Build the user's right terminal sidebar. Actions: get, set (widgets), add (widget, optional index), remove (index), move (index, to), clear. Zero-based indices; scope user (default) or project. Widgets: context, usage, todos, changes, jobs, loops, workflows, agents, mcp, git, session, clock, text, sidechat, agent, activity, workspace, tokens, tools, alerts, extension:<id>. Each is {type,title?,options:{maxRows?,text?,priority?}}; text is only for text widgets; priority (high|normal|low) decides which cards survive when the bar is shorter than its content; wrap ASCII in a fenced code block to preserve spacing. Combine real built-ins; never invent types. For custom content write a terminal extension registering sidebar:<id> (see docs/extensions-tui.md), then add extension:<id>. This only changes terminal UI; get reads it.",
    args: SidebarAction,
    async execute(action, ctx) {
      try {
        const widgets = updateSidebar(dir, ctx.cwd, action)
        if (action.action !== "get") changed(action.scope === "project" ? ctx.cwd : undefined, widgets)
        const text = widgets.length ? `Right sidebar: ${widgets.map((widget) => widget.title ?? widget.type).join(", ")}` : "Right sidebar empty. Ask the agent to build it, or /sidebar edit."
        return { output: text, title: "Right sidebar", truncated: false, isError: false }
      } catch (error) { return fail({ title: "sidebar", message: String(error) }) }
    },
  })
}
