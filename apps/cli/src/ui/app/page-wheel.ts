import type { Page } from "./context"

/** What one wheel notch sends a page: the key it already scrolls or moves with, and how many times per notch setting. */
export type WheelStep = { up: string; down: string; repeat: "notch" | "one" }

const ARROWS = { up: "\x1b[A", down: "\x1b[B" }
const PAGING = { up: "\x1b[5~", down: "\x1b[6~" }

/** Pages that read as text: one wheel notch scrolls as many lines as the transcript's. */
const SCROLLING: ReadonlySet<Page> = new Set<Page>(["text", "status", "help", "changes", "messages", "export", "diagnostics", "plan-review", "compaction"])

/** Pages made of rows: the wheel moves the selection a row at a time, as the arrow keys do. */
const LISTS: ReadonlySet<Page> = new Set<Page>([
  "sessions", "tasks", "stash", "drafts", "queue", "skills", "variants", "model-picker", "mcps", "acp", "tools", "packages", "loops", "storage",
  "model", "agent", "theme", "agents", "pet", "workflows", "customize", "settings", "extensions", "hooks", "providers", "secrets", "env", "tree",
  "permissions", "agent-commands", "worktrees", "warp", "compound", "marketplace", "ai-config", "release-channel", "tsm", "ide", "mflow", "reviews",
  "console", "share", "memory", "memory-assistant", "git-commit", "git-pr", "git-init", "connect", "history", "keymap", "prompt-mode", "whatsnew", "today",
])

/** The key a wheel notch becomes on this page, or undefined where the wheel does nothing (chat, the file viewer, forms, the setup, the tutorial). */
export function wheelStep(input: { page: Page; usageTab?: number | undefined; typing?: boolean | undefined }): WheelStep | undefined {
  const { page } = input
  if (page === "usage") return input.usageTab === 0 ? { ...PAGING, repeat: "one" } : { ...ARROWS, repeat: "notch" }
  if (page === "context") return { ...PAGING, repeat: "one" }
  if (input.typing && (page === "settings" || page === "customize")) return undefined
  if (SCROLLING.has(page)) return { ...ARROWS, repeat: "notch" }
  if (LISTS.has(page)) return { ...ARROWS, repeat: "one" }
  return undefined
}

/** Shift with ↑ or ↓ (xterm and kitty send these). */
export const SHIFT_ARROWS = { up: new Set(["\x1b[1;2A", "\x1b[a"]), down: new Set(["\x1b[1;2B", "\x1b[b"]) }
export const FAST_STEP = 5
/** Pages where shift with an arrow already means something else (reorder, select, its own fast move). */
const OWN_SHIFT_ARROWS: ReadonlySet<Page> = new Set<Page>(["changes", "diagram", "queue", "reviews", "customize"])

/**
 * Shift with an arrow on a page moves FAST_STEP rows or lines: the key the page already moves with, sent FAST_STEP times.
 * Undefined where the page owns that key, takes typed text or has no rows.
 */
export function fastStep(input: { page: Page; key: string; usageTab?: number | undefined; typing?: boolean | undefined }): { key: string; times: number } | undefined {
  const direction = SHIFT_ARROWS.up.has(input.key) ? "up" : SHIFT_ARROWS.down.has(input.key) ? "down" : undefined
  if (!direction || OWN_SHIFT_ARROWS.has(input.page) || input.typing) return undefined
  const step = wheelStep(input)
  if (!step || step.up !== ARROWS.up) return undefined
  return { key: step[direction], times: FAST_STEP }
}
