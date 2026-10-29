import type { PageModel } from "@mendcode/extension-api/views"
import type { Line } from "../ui/theme"

/** What each full-screen page is called in the `page` slot (docs/views.md). A page missing here is named by its id. */
export const PAGE_TITLES: Readonly<Record<string, string>> = {
  file: "File", tasks: "Tasks", stash: "Stash", drafts: "Drafts", queue: "Queue", history: "Prompt history", skills: "Skills", variants: "Variants",
  "model-picker": "Models", sessions: "Sessions", usage: "Usage", help: "Help", changes: "Changes", memory: "Memory", context: "Context",
  mcps: "MCP servers", acp: "ACP agents", tools: "Tools", packages: "Packages", loops: "Loops", storage: "Storage", setup: "Setup",
  model: "Model", agent: "Agent", theme: "Themes", agents: "Agent View", pet: "Pet", workflows: "Workflows", extension: "Extension",
  customize: "Customize", settings: "Settings", status: "Status", extensions: "Extensions", hooks: "Hooks", connect: "Connect",
  providers: "Providers", secrets: "Secrets", env: "Environment", tree: "Session tree", text: "Document", permissions: "Permissions",
  diagram: "Diagram", sidebar: "Sidebar", "memory-assistant": "Memory assistant", messages: "Messages", export: "Export",
  "plan-review": "Plan review", "prompt-mode": "Prompt mode", compaction: "Compaction", "agent-commands": "Agent commands",
  diagnostics: "Diagnostics", worktrees: "Worktrees", warp: "Warp", compound: "Compound", marketplace: "Marketplace", intro: "Welcome",
  "ai-config": "AI config", "release-channel": "Release channel", tsm: "Sessions manager", ide: "IDE", mflow: "Flow", console: "Console",
  "git-commit": "Commit", "git-pr": "Pull request", "git-init": "Initialize repository", share: "Share", keymap: "Keymap", "terminal-setup": "Terminal setup", tutorial: "Tutorial",
}

const text = (line: Line) => line.map((span) => span.text).join("")

/**
 * The page model of a page the terminal just drew: its id and title, the highlighted row (the first one painted with the
 * `element` background, which every list page uses for its selection) and the hint line (the last row that names `esc`).
 * Selection and scroll stay with the page's own state; this only reads what was drawn.
 */
export function pageModel({ page, body, status, scroll }: { page: string; body: Line[]; status: Line[]; scroll?: number }): Omit<PageModel, "body"> {
  const selected = body.findIndex((line) => line.some((span) => span.bg === "element"))
  const hint = body.findLast((line) => /\besc\b/i.test(text(line)))
  return {
    page,
    title: PAGE_TITLES[page] ?? page,
    ...(hint ? { hints: text(hint).trim() } : {}),
    ...(selected >= 0 ? { selected } : {}),
    ...(scroll !== undefined ? { scroll } : {}),
    status: status.map((line) => line.map((span) => ({ ...span }))),
  } as Omit<PageModel, "body">
}
