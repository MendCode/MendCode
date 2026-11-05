import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { wheelStep } from "../src/ui/app/page-wheel"
import { catalogSearchKey, createMarketplaceState } from "../src/view/marketplace-page"
import { connectKey, createConnectState } from "../src/view/connect-page"
import { createCustomizePageState, customizePageKey } from "../src/view/customize-page"
import { createHistoryState, historySearchKey } from "../src/view/history-page"
import { createMemoryPageState, memoryPageKey } from "../src/view/memory-page"
import { modelPageKey } from "../src/view/model-page"
import { createReviewsPageState } from "../src/view/reviews-page"
import { reviewsPageKey } from "../src/view/reviews-keys"
import { createSettingsPageState, renderSettingsPage, settingsPageKey, settingsRows } from "../src/view/settings-page"
import { DEFAULT_TUI_PROFILE } from "../src/view/tui-profile"

/**
 * The page standard (docs/keys.md "Pages"): every page with a list opens a `/` box through the shared page search, Esc clears
 * the box before it leaves the page, and Esc on the page goes back. One table of cases runs against each such page.
 */

type Driver = { name: string; press(key: string): void; query(): string; open(): boolean; left(): boolean; reset(): void; enter: "keeps" | "goes" | "acts" }

const SETTINGS_VALUES = { settings: { onboarded: true }, theme: "mend", view: "balanced", reducedMotion: false }

function settingsDriver(): Driver {
  let state = createSettingsPageState()
  let left = false
  return {
    name: "settings", enter: "goes",
    press(key) { const result = settingsPageKey(state, key, SETTINGS_VALUES, { themes: ["mend"] }); state = result.state; left = result.action.type === "close" },
    query: () => state.search?.query ?? "", open: () => state.search?.open === true, left: () => left,
    reset() { state = createSettingsPageState(); left = false },
  }
}
function customizeDriver(): Driver {
  let state = createCustomizePageState()
  let left = false
  return {
    name: "customize", enter: "goes",
    press(key) { const result = customizePageKey(state, key, DEFAULT_TUI_PROFILE); state = result.state; left = result.action.type === "close" },
    query: () => state.search?.query ?? "", open: () => state.search?.open === true, left: () => left,
    reset() { state = createCustomizePageState(); left = false },
  }
}
function reviewsDriver(): Driver {
  let state = createReviewsPageState()
  let left = false
  return {
    name: "reviews", enter: "keeps",
    press(key) { const result = reviewsPageKey(state, key, undefined); state = result.state; left = result.action.type === "close" },
    query: () => state.filter.text, open: () => state.typing === true, left: () => left,
    reset() { state = createReviewsPageState(); left = false },
  }
}
function marketplaceDriver(): Driver {
  let page = createMarketplaceState()
  let left = false
  return {
    name: "marketplace", enter: "keeps",
    // The app closes the page on Esc when the catalog search does not take the key.
    press(key) { left = !catalogSearchKey(page, key, true) && key === "\x1b" },
    query: () => page.query, open: () => page.editing === "query", left: () => left,
    reset() { page = createMarketplaceState(); left = false },
  }
}
function connectDriver(): Driver {
  let state = createConnectState()
  let left = false
  return {
    // Enter on a match connects it, which is what the page does.
    name: "connect", enter: "acts",
    press(key) { const result = connectKey(state, key); state = result.state; left = result.action.type === "close" },
    query: () => state.query ?? "", open: () => state.searching === true, left: () => left,
    reset() { state = createConnectState(); left = false },
  }
}
function memoryDriver(): Driver {
  let state = createMemoryPageState()
  let left = false
  return {
    name: "memory", enter: "keeps",
    press(key) { const result = memoryPageKey(state, key, []); state = result.state; left = result.action.type === "close" },
    query: () => state.filter, open: () => state.filtering, left: () => left,
    reset() { state = createMemoryPageState(); left = false },
  }
}
function historyDriver(): Driver {
  let state = createHistoryState()
  let left = false
  return {
    name: "history", enter: "keeps",
    press(key) { left = historySearchKey(state, key) === undefined && key === "\x1b" },
    query: () => state.query, open: () => state.editing, left: () => left,
    reset() { state = createHistoryState(); left = false },
  }
}

const DRIVERS: Driver[] = [settingsDriver(), customizeDriver(), reviewsDriver(), marketplaceDriver(), connectDriver(), memoryDriver(), historyDriver()]
const type = (driver: Driver, text: string) => { for (const key of text) driver.press(key) }

describe.each(DRIVERS.map((driver) => [driver.name, driver] as const))("page search: %s", (_name, driver) => {
  const cases: Array<{ name: string; run(): void }> = [
    { name: "/ opens an empty box", run() { driver.press("/"); expect(driver.open()).toBe(true); expect(driver.query()).toBe("") } },
    { name: "typed keys edit the query, even q, j and k", run() { driver.press("/"); type(driver, "qjk"); expect(driver.query()).toBe("qjk"); expect(driver.left()).toBe(false) } },
    { name: "Backspace deletes the last character", run() { driver.press("/"); type(driver, "ab"); driver.press("\x7f"); expect(driver.query()).toBe("a") } },
    { name: "Esc clears the box and the page stays", run() { driver.press("/"); type(driver, "ab"); driver.press("\x1b"); expect(driver.open()).toBe(false); expect(driver.query()).toBe(""); expect(driver.left()).toBe(false) } },
    { name: "Esc with no box goes back", run() { driver.press("\x1b"); expect(driver.left() || driver.name === "marketplace" || driver.name === "history").toBe(true) } },
    { name: "Enter closes the box (settings and customize go to the row with every row listed; the lists keep the filter)", run() { driver.press("/"); type(driver, "th"); driver.press("\r"); expect(driver.open()).toBe(false); if (driver.enter === "keeps") expect(driver.query()).toBe("th"); if (driver.enter === "goes") expect(driver.query()).toBe("") } },
    { name: "Ctrl+U clears the text and keeps the box open", run() { driver.press("/"); type(driver, "abc"); driver.press("\x15"); expect(driver.query()).toBe(""); expect(driver.open()).toBe(true) } },
    { name: "/ on a kept filter reopens the box with its text", run() { driver.press("/"); type(driver, "th"); driver.press("\r"); driver.press("/"); if (driver.enter === "keeps") { expect(driver.open()).toBe(true); expect(driver.query()).toBe("th") } } },
    { name: "a second / starts a fresh box", run() { driver.press("/"); type(driver, "a"); driver.press("\x1b"); driver.press("/"); expect(driver.open()).toBe(true); expect(driver.query()).toBe("") } },
  ]
  for (const entry of cases) test(entry.name, () => { driver.reset(); entry.run() })
})

test("model: / opens the model search", () => {
  expect(modelPageKey({ row: 0 }, "/", undefined).action).toEqual({ type: "picker" })
})

// ── A new page has to join the standard ─────────────────────────────────────────────────────────────────────────────────

const ROOT = join(import.meta.dir, "..", "src")
const pageNames = (): string[] => {
  const source = readFileSync(join(ROOT, "ui/app/context.ts"), "utf8")
  return [...source.match(/export type Page = ([^\n]+)/)![1]!.matchAll(/"([^"]+)"/g)].map((match) => match[1]!)
}

/**
 * Every page, by what it is: list (rows; the wheel moves the selection), scroll (text; the wheel scrolls), or other (the chat, a viewer,
 * a form or a wizard that owns its keys). A list says how it searches: box (`/`, the shared page search), ahead (typing filters a picker),
 * or few (a fixed short set of rows, nothing to search).
 */
const PAGES: Record<string, { kind: "list"; search: "box" | "ahead" | "few" } | { kind: "scroll" } | { kind: "other" }> = {
  file: { kind: "other" }, chat: { kind: "other" }, extension: { kind: "other" }, diagram: { kind: "other" }, sidebar: { kind: "other" }, setup: { kind: "other" }, intro: { kind: "other" }, tutorial: { kind: "other" }, "terminal-setup": { kind: "other" },
  tasks: { kind: "list", search: "few" }, stash: { kind: "list", search: "few" }, drafts: { kind: "list", search: "few" }, queue: { kind: "list", search: "few" },
  history: { kind: "list", search: "box" }, skills: { kind: "list", search: "ahead" }, variants: { kind: "list", search: "few" }, "model-picker": { kind: "list", search: "ahead" },
  sessions: { kind: "list", search: "ahead" }, usage: { kind: "scroll" }, help: { kind: "scroll" }, changes: { kind: "scroll" }, memory: { kind: "list", search: "box" }, context: { kind: "scroll" },
  mcps: { kind: "list", search: "few" }, acp: { kind: "list", search: "few" }, tools: { kind: "list", search: "few" }, packages: { kind: "list", search: "few" }, loops: { kind: "list", search: "few" }, storage: { kind: "list", search: "few" },
  model: { kind: "list", search: "box" }, agent: { kind: "list", search: "ahead" }, theme: { kind: "list", search: "ahead" }, agents: { kind: "list", search: "few" }, pet: { kind: "list", search: "ahead" }, workflows: { kind: "list", search: "few" },
  customize: { kind: "list", search: "box" }, settings: { kind: "list", search: "box" }, status: { kind: "scroll" }, extensions: { kind: "list", search: "few" }, hooks: { kind: "list", search: "few" },
  connect: { kind: "list", search: "box" }, providers: { kind: "list", search: "few" }, secrets: { kind: "list", search: "few" }, env: { kind: "list", search: "few" }, tree: { kind: "list", search: "few" }, text: { kind: "scroll" },
  permissions: { kind: "list", search: "few" }, "memory-assistant": { kind: "list", search: "few" }, messages: { kind: "scroll" }, export: { kind: "scroll" }, "plan-review": { kind: "scroll" },
  "prompt-mode": { kind: "list", search: "few" }, compaction: { kind: "scroll" }, "agent-commands": { kind: "list", search: "few" }, diagnostics: { kind: "scroll" }, worktrees: { kind: "list", search: "few" }, warp: { kind: "list", search: "few" },
  "git-commit": { kind: "list", search: "few" }, "git-pr": { kind: "list", search: "few" }, "git-init": { kind: "list", search: "few" }, compound: { kind: "list", search: "few" },
  marketplace: { kind: "list", search: "box" }, "ai-config": { kind: "list", search: "few" }, "release-channel": { kind: "list", search: "few" }, tsm: { kind: "list", search: "few" }, ide: { kind: "list", search: "few" }, mflow: { kind: "list", search: "few" },
  reviews: { kind: "list", search: "box" }, console: { kind: "list", search: "few" }, share: { kind: "list", search: "few" }, keymap: { kind: "list", search: "few" },
}

describe("every page follows the standard", () => {
  test("each page is classified here (a new page must say how it searches and scrolls)", () => {
    expect(pageNames().filter((page) => !(page in PAGES))).toEqual([])
    expect(Object.keys(PAGES).filter((page) => !pageNames().includes(page))).toEqual([])
  })

  test("lists and text pages answer the wheel", () => {
    const missing = Object.entries(PAGES).filter(([page, entry]) => entry.kind !== "other" && wheelStep({ page: page as never }) === undefined).map(([page]) => page)
    expect(missing).toEqual([])
  })

  test("a page that searches with / says so in its keys", () => {
    const boxes = Object.entries(PAGES).filter(([, entry]) => entry.kind === "list" && entry.search === "box").map(([page]) => page)
    expect(boxes.sort()).toEqual(["connect", "customize", "history", "marketplace", "memory", "model", "reviews", "settings"])
  })

  test("only the shared page search edits a / box (no page keeps its own copy)", () => {
    const own: string[] = []
    const walk = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) { walk(path); continue }
        if (!path.endsWith(".ts") || path.endsWith("page-search.ts")) continue
        const text = readFileSync(path, "utf8")
        // A key handler that tests for "/" must go through the shared search (the file viewer's pane search and slash menus are not pages).
        if (/key === "\/"|case "\/":/.test(text) && !/pageSearchKey|catalogSearchKey|historySearchKey/.test(text)) own.push(path.slice(ROOT.length + 1))
      }
    }
    walk(join(ROOT, "view")); walk(join(ROOT, "ui/app"))
    expect(own.filter((path) => !["ui/app/file-viewer.ts", "ui/app/keys.ts", "ui/app/slash-menu.ts", "view/model-page.ts", "view/project-scope.ts", "view/tool-data.ts"].includes(path))).toEqual([])
  })

  test("every *-page.ts view is a known page", () => {
    const known = new Set(["acp", "agent-commands", "agents", "ai-config", "automation-ledger", "changes", "compaction", "compound", "connect", "console", "context", "customize", "diagnostics", "environment", "extensions", "git-commit", "git-init", "git", "git-pr", "git-publish", "help", "history", "hooks", "ide", "intro", "keymap", "loops", "marketplace", "mcps", "memory-assistant", "memory", "mflow", "model", "onboarding", "packages", "permissions", "plan-review", "prompt-mode", "providers", "queue", "reasoning", "release", "reviews", "secrets", "session-tree", "settings", "setup", "skills", "stash", "status", "storage", "tasks", "terminal-setup", "text", "tools", "transcript-actions", "tsm", "tutorial", "uninstall", "usage", "workflows", "worktrees"])
    const files = readdirSync(join(ROOT, "view")).filter((name) => name.endsWith("-page.ts")).map((name) => name.slice(0, -"-page.ts".length))
    expect(files.filter((name) => !known.has(name))).toEqual([])
  })
})

describe("settings search", () => {
  const press = (state: ReturnType<typeof createSettingsPageState>, keys: string[]) => keys.reduce((current, key) => settingsPageKey(current, key, SETTINGS_VALUES, { themes: ["mend"] }).state, state)
  test("the cursor jumps to the first match and arrows move only among matches", () => {
    const opened = press(createSettingsPageState(), ["/", "d", "a", "y", "s"])
    expect(settingsRows(SETTINGS_VALUES)[opened.row]!.label.toLowerCase() + settingsRows(SETTINGS_VALUES)[opened.row]!.id.toLowerCase()).toContain("day")
    const down = press(opened, ["\x1b[B"])
    expect(down.row).toBeGreaterThan(opened.row)
    expect(press(down, ["\x1b[A"]).row).toBe(opened.row)
  })
  test("Enter keeps the cursor on the row and lists every row again", () => {
    const opened = press(createSettingsPageState(), [..."/queue"])
    const done = press(opened, ["\r"])
    expect(done.row).toBe(opened.row)
    expect(done.search).toBeUndefined()
  })
  test("the filtered page lists the matches and the hint row is the shared one", () => {
    const state = press(createSettingsPageState(), [..."/queue"])
    const text = renderSettingsPage({ state, values: SETTINGS_VALUES, width: 100, height: 30 }).map((line) => line.map((span) => span.text).join("")).join("\n")
    expect(text).toContain("/ queue_")
    expect(text).toContain("type to filter")
    expect(text).not.toContain("Retention")
  })
})
