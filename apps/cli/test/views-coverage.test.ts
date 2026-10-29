import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { isViewSlot, VIEW_SLOT_NAMES, type ViewSlot } from "@mendcode/extension-api/views"
import { PAGE_TITLES } from "../src/view/page-views"

/**
 * The bypass guard (docs/views.md): every file in apps/cli/src/view that exports a draw entry point (`render*`, `*Row(s)`,
 * `*Line(s)`, `draw*`) is either registered as drawing through a view slot or listed with the concrete reason it is not
 * a slot of its own. New UI cannot add a draw function in a new file without this test failing until someone decides.
 */

type Entry = { slot: ViewSlot } | { allow: string }

const page = { slot: "page" } as const
const COVERAGE: Record<string, Entry> = {
  // Full-screen pages: all drawn through the `page` envelope in `pageRows`.
  ...Object.fromEntries([
    "acp-page", "agent-commands-page", "agent-picker", "agents-page", "ai-config-page", "automation-ledger-page", "changes-page", "changes-state",
    "compaction-page", "compound-page", "connect-page", "console-page", "context-page", "customize-page", "diagnostics-page", "dream-report",
    "dream-tab", "environment-page", "extensions-page", "help-page", "history-page", "hooks-page", "ide-page", "intro-page", "keymap-page", "loop-evidence",
    "loop-form", "loops-page", "marketplace-page", "mcps-catalog", "mcps-page", "memory-assistant-page", "memory-evolution",
    "memory-extraction-tab", "memory-graph-view", "onboarding-page", "onboarding-import", "onboarding-sample", "memory-page", "memory-policies", "memory-sharing-tab", "memory-workspaces", "mermaid-viewer",
    "mflow-page", "model-page", "model-picker", "packages-page", "permissions-page", "pet-picker", "pet-plan", "plan-review-page", "prompt-mode-page",
    "providers-page", "queue-page", "reasoning-page", "release-page", "secrets-page", "session-list", "settings-page", "setup-page",
    "sidebar-editor", "skills-page", "slash-menu-editor", "stash-page", "storage-page", "tasks-page", "terminal-setup-page", "text-page",
    "theme-picker", "session-tree", "session-tree-page", "tools-page", "transcript-actions-page", "tsm-page", "tutorial-page", "usage-clock",
    "usage-heatmap", "usage-page", "usage-widgets", "workflows-page", "worktrees-page", "git-commit-page", "git-pr-page", "git-page", "git-init-page", "git-publish-page",
  ].map((name) => [`${name}.ts`, page])),
  "status-page.ts": { slot: "page.status" },
  "file-viewer.ts": { slot: "file.viewer" },
  // Transcript blocks.
  "message-views.ts": { slot: "message.assistant" },
  "markdown.ts": { slot: "message.assistant" },
  "markdown-bidi.ts": { slot: "message.assistant" },
  "markdown-chrome.ts": { slot: "message.assistant" },
  "markdown-table.ts": { slot: "message.assistant" },
  "mermaid.ts": { slot: "message.assistant" },
  "chart-picture.ts": { slot: "message.assistant" },
  "tool-card.ts": { slot: "tool.card" },
  "tool-bodies.ts": { slot: "tool.card" },
  "tool-frame.ts": { slot: "tool.card" },
  "image-wait.ts": { slot: "tool.card" },
  "tool-kinds.ts": { slot: "tool.card" },
  "render-spec.ts": { slot: "tool.card" },
  "code-map.ts": { slot: "tool.card" },
  "graph-card.ts": { slot: "tool.card" },
  "ascii-graph.ts": { slot: "tool.card" },
  "transcript-views.ts": { slot: "turn.status" },
  "compaction-panel.ts": { slot: "compaction.card" },
  "chat-blocks.ts": { slot: "turn.status" },
  "goal.ts": { slot: "turn.status" },
  "usage-limit.ts": { slot: "notice" },
  // Chrome.
  "approval-diff.ts": { slot: "approval" },
  "request-panel.ts": { slot: "approval" },
  "question-batch.ts": { slot: "question" },
  "prompt-chrome.ts": { slot: "prompt.frame" },
  "topbar.ts": { slot: "topbar" },
  "sidebar.ts": { slot: "sessions.sidebar" },
  "sidebar-cards.ts": { slot: "panel.widget" },
  "panel-card.ts": { slot: "panel.widget" },
  "panel-orbit.ts": { slot: "panel.widget" },
  "panel-atom.ts": { slot: "panel.widget" },
  "backlog.ts": { slot: "panel.widget" },
  "toast.ts": { slot: "notice" },
  "queue-panel.ts": { slot: "notice" },
  "footer.ts": { slot: "footer" },
  "footer-rows.ts": { slot: "footer" },
  "home.ts": { slot: "home" },
  "home-tips.ts": { slot: "home" },
  "mascot.ts": { slot: "home" },
  "mend-sprite.ts": { slot: "home" },
  "slash-menu.ts": { slot: "slash.menu" },
  "popup.ts": { slot: "slash.menu" },
  "palette.ts": { slot: "overlay" },
  "aside-card.ts": { slot: "overlay" },
  "model-quick.ts": { slot: "overlay" },
  "fetch-card.ts": { slot: "overlay" },
  "rewind-card.ts": { slot: "overlay" },
  "shortcut-overlay.ts": { slot: "bar" },
  "working-row.ts": { slot: "bar" },
  "voice-row.ts": { slot: "bar" },
  "agents-strip.ts": { slot: "bar" },
  "background-row.ts": { slot: "bar" },
  // Not a slot of their own, each with its reason.
  "panel-box.ts": { allow: "box-drawing helper called by the built-in renderers of notice, approval, question and slash.menu; draws nothing on its own" },
  "deck.ts": { allow: "row layout helpers (tabs, hint and KPI rows) used inside page, widget and slot built-ins; draws nothing on its own" },
  "page.ts": { allow: "row layout helpers (hint, tab and KPI rows) used inside the page built-ins; the page itself draws through the page slot" },
  "reply-comments-sent.ts": { allow: "the sent set of comments inside the built-in `message.user` renderer (message-views.ts); a custom `message.user` view replaces it and receives the parts as `comments` with the layout and collapse settings" },
  "reply-comments-view.ts": { allow: "the comment chips, list and reply bar are drawn from geometry the terminal also measures (marks, click areas, the prompt rule); they are customized by the comment settings (placement, style, glyphs, wording, theme roles) and the `api.comments` hooks" },
  "image-actions.ts": { allow: "the generated picture's button row (open, folder, copy path) is click geometry the terminal measures, like a code block's copy header; the card itself draws through the tool-card slot" },
  "links.ts": { allow: "post-processes rows that were already drawn (adds hyperlinks); it has no pixels of its own" },
  "stat-parts.ts": { allow: "the registry of named session figures (labels, formatters, thresholds); the footer, the activity status, the top bar and the sidebar stats card draw them through their own slots" },
  "overlay.ts": { allow: "composites already drawn rows over each other; it has no content of its own" },
  "editor.ts": { allow: "the prompt's text editor: its cursor, selection and wrapping geometry are owned by the terminal; the chrome around it is prompt.frame" },
  "dock.ts": { allow: "the tasks and scratchpad dock holds editable text areas whose cursor and click geometry the terminal measures from the rows it draws" },
  "compaction-live.ts": { allow: "the live compaction panel hosts the scratchpad editor with its own cursor geometry and keyboard focus; the finished card is compaction.card" },
  "loop-monitor.ts": { allow: "headless /loop monitor output of the automation mode, printed to stdout; not part of the interactive terminal" },
  "commands.ts": { allow: "renderSuggestions is not called by the terminal any more (the slash menu draws through slash.menu); kept for the command catalogue helpers it ships with" },
  "mentions.ts": { allow: "renderMentionSuggestions is not called by the terminal any more (the @ popup draws through bar.mention); kept with the mention search helpers" },
}

const viewDir = path.join(import.meta.dir, "../src/view")
const ENTRY = /^export (?:async )?function (?:render\w*|\w*Rows?|\w*Lines?|draw\w*)\b|^export const (?:render|draw)\w* *=/m

const drawFiles = readdirSync(viewDir).filter((file) => file.endsWith(".ts") && ENTRY.test(readFileSync(path.join(viewDir, file), "utf8"))).sort()

describe("the view contract cannot be bypassed", () => {
  test("every file with a draw entry point is registered as a slot or allowlisted with a reason", () => {
    const unregistered = drawFiles.filter((file) => !(file in COVERAGE))
    expect(unregistered).toEqual([])
  })

  test("the scan finds the draw entry points (a broken pattern would pass vacuously)", () => {
    expect(drawFiles.length).toBeGreaterThan(100)
    expect(drawFiles).toContain("usage-page.ts")
    expect(drawFiles).toContain("transcript-views.ts")
  })

  test("the table has no stale entries", () => {
    expect(Object.keys(COVERAGE).filter((file) => !drawFiles.includes(file))).toEqual([])
  })

  test("a registered slot exists and an allowlist reason says something concrete", () => {
    for (const [file, entry] of Object.entries(COVERAGE)) {
      if ("slot" in entry) expect(isViewSlot(entry.slot), file).toBe(true)
      else expect(entry.allow.length, file).toBeGreaterThan(40)
    }
  })

  test("every slot has at least one file drawing through it, and none is unused", () => {
    const used = new Set(Object.values(COVERAGE).flatMap((entry) => ("slot" in entry ? [entry.slot] : [])))
    // `tool.row` and `bar.*` share files with their families: the transcript and chat-rows build them.
    const shared = new Set<ViewSlot>(["tool.row", "message.user", "message.reasoning"])
    expect(VIEW_SLOT_NAMES.filter((slot) => !used.has(slot) && !shared.has(slot))).toEqual([])
  })

  test("every page of the terminal has a title for the page slot", () => {
    const source = readFileSync(path.join(import.meta.dir, "../src/ui/app/context.ts"), "utf8")
    const union = /export type Page = ([^\n]+)/.exec(source)![1]!
    const pages = [...union.matchAll(/"([a-z-]+)"/g)].map((match) => match[1]!).filter((name) => name !== "chat")
    expect(pages.filter((name) => !(name in PAGE_TITLES))).toEqual([])
  })
})
