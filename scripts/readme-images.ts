// Draws the README and website screenshots (docs/assets/readme/*.svg) from the real views, or checks that the committed
// files are what the views draw now.
//
//   bun scripts/readme-images.ts            write every image
//   bun scripts/readme-images.ts --check    fail when a committed image differs from what the views draw
//   bun scripts/readme-images.ts session    write only the named scenes
//
// Each scene is a frame of the real TUI (the same view functions the terminal draws, over fixed data) on a full-screen
// terminal of COLUMNS x ROWS cells, set in a window with the product's own theme colors. Nothing is hand-drawn: change a
// view, run this script, commit the images with it. The logos are artwork, not frames, and are left alone.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ChangedFile, ChangesReport, Goal, MemoryEntry, MemoryGraphReport, MemoryLink, PackageInfo, SessionId } from "@mendcode/protocol"
// Demo data only: a throwaway data dir per scene, fixed daemon replies, placeholder credential names; never the user's ~/.mendcode.
import { resolveActivation, type Activation } from "../packages/protocol/src/activation-data"
import type { CommandReply } from "@mendcode/client"
import { DEFAULT_THEME } from "../apps/cli/src/themes"
import { activeTheme, setColorOverrides, setGlyphMode, setTheme, type Line } from "../apps/cli/src/ui/theme"
import { createChangesPageState, renderChangesPage } from "../apps/cli/src/view/changes-page"
import { createMemoryPageState, renderMemoryPage } from "../apps/cli/src/view/memory-page"
import { createPackagesPageState, renderPackagesPage } from "../apps/cli/src/view/packages-page"
import { cells } from "../apps/cli/src/view/wrap"
import { DEFAULT_TUI_PROFILE, writeTuiProfile } from "../apps/cli/src/view/tui-profile"
import { appHarness, ids, NOW } from "../apps/cli/test/session-ui-harness"

/** A normal full-screen terminal window on a desktop monitor. */
export const COLUMNS = 200
export const ROWS = 56

const CELL_WIDTH = 8.4
const CELL_HEIGHT = 18
const FONT_SIZE = 14
const TITLEBAR = 34
const PAD = 16
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace"
const DIRECTORY = "~/Code/shop-api"

const xml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
const num = (value: number) => value.toFixed(1)

function hexOf(color: string | undefined): string | undefined {
  if (!color) return undefined
  return /^#[0-9a-f]{3}$/i.test(color) ? `#${[...color.slice(1)].map((digit) => digit + digit).join("")}`.toLowerCase() : color.toLowerCase()
}

type Run = { col: number; width: number; text: string; fg: string; bg: string | undefined; bold: boolean; dim: boolean; italic: boolean; underline: boolean; strike: boolean }

/** A row's spans as runs of equal style, one cell grid column each, wide characters counted by their cell width. */
function runsOf(line: Line): Run[] {
  const theme = activeTheme()
  const runs: Run[] = []
  let col = 0
  for (const span of line) {
    const fg = hexOf(span.fgHex) ?? hexOf(theme.colors[span.fg ?? "text"]) ?? "#ffffff"
    const bg = hexOf(span.bgHex) ?? (span.bg ? hexOf(theme.colors[span.bg]) : undefined)
    const style = { fg, bg, bold: span.bold === true, dim: span.dim === true, italic: span.italic === true, underline: span.underline === true, strike: span.strike === true }
    for (const cell of cells(span.text)) {
      const last = runs.at(-1)
      if (last && last.col + last.width === col && last.fg === fg && last.bg === bg && last.bold === style.bold && last.dim === style.dim && last.italic === style.italic && last.underline === style.underline && last.strike === style.strike) {
        last.text += cell.text
        last.width += cell.width
      } else runs.push({ col, width: cell.width, text: cell.text, ...style })
      col += cell.width
    }
  }
  return runs
}

/** One frame in a window: title bar with three dots and `title`, the theme's background, a monospaced cell grid. */
export function renderSvg({ frame, title, columns = COLUMNS, rows = ROWS }: { frame: readonly Line[]; title: string; columns?: number; rows?: number }): string {
  const theme = activeTheme()
  const width = Math.round(columns * CELL_WIDTH + PAD * 2)
  const height = TITLEBAR + PAD * 2 + rows * CELL_HEIGHT
  const backgrounds: string[] = []
  const texts: string[] = []
  frame.slice(0, rows).forEach((line, row) => {
    const top = TITLEBAR + PAD + row * CELL_HEIGHT
    for (const run of runsOf(line)) {
      const x = PAD + run.col * CELL_WIDTH
      const runWidth = run.width * CELL_WIDTH
      if (run.bg && run.bg !== hexOf(theme.background)) backgrounds.push(`<rect x="${num(x)}" y="${top}" width="${num(runWidth)}" height="${CELL_HEIGHT}" fill="${run.bg}"/>`)
      if (run.text.trim() === "" && !run.underline && !run.strike) continue
      // Edge spaces carry no ink and some renderers drop them (shifting the text): the text starts where its first glyph does.
      const lead = run.text.length - run.text.trimStart().length
      const tail = run.text.length - run.text.trimEnd().length
      const inkX = x + lead * CELL_WIDTH
      const inkWidth = runWidth - (lead + tail) * CELL_WIDTH
      const attributes = [
        `x="${num(inkX)}"`,
        `y="${top + 13}"`,
        `textLength="${num(inkWidth)}"`,
        `lengthAdjust="spacingAndGlyphs"`,
        `fill="${run.fg}"`,
        ...(run.dim ? [`fill-opacity="0.6"`] : []),
        ...(run.bold ? [`font-weight="700"`] : []),
        ...(run.italic ? [`font-style="italic"`] : []),
        ...(run.underline || run.strike ? [`text-decoration="${[run.underline ? "underline" : "", run.strike ? "line-through" : ""].filter(Boolean).join(" ")}"`] : []),
      ]
      texts.push(`<text ${attributes.join(" ")}>${xml(run.text.trim())}</text>`)
    }
  })
  const border = hexOf(theme.colors.border) ?? "#636363"
  const muted = hexOf(theme.colors.muted) ?? "#a3a3a3"
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${xml(title)}">`,
    `<rect width="${width}" height="${height}" rx="10" fill="${hexOf(theme.background)}"/>`,
    `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="10" fill="none" stroke="${border}" stroke-opacity="0.6"/>`,
    `<line x1="0" y1="${TITLEBAR}" x2="${width}" y2="${TITLEBAR}" stroke="${border}" stroke-opacity="0.6"/>`,
    `<circle cx="22" cy="17" r="5.5" fill="#3a3f3c"/><circle cx="40" cy="17" r="5.5" fill="#3a3f3c"/><circle cx="58" cy="17" r="5.5" fill="#3a3f3c"/>`,
    `<text x="${width / 2}" y="21.5" text-anchor="middle" font-family="${MONO}" font-size="12" fill="${muted}">${xml(title)}</text>`,
    backgrounds.join(""),
    `<g font-family="${MONO}" font-size="${FONT_SIZE}" xml:space="preserve" style="white-space:pre">${texts.join("")}</g>`,
    `</svg>`,
    ``,
  ].join("\n")
}

// ---------------------------------------------------------------------------------------------------------------------
// Scenes. Every one is deterministic: a fixed clock, fixed ids and data, the product's default theme.

const reply = (result: unknown) => ({ ok: true, result }) as CommandReply

const CHANGED: ChangedFile[] = [
  {
    path: "src/cart/totals.ts", status: "modified", additions: 2, deletions: 1, binary: false, truncated: false,
    diff: [
      "@@ -18,5 +18,6 @@ export function totals(cart: Cart): Totals {",
      "   const subtotal = sum(cart.items.map(lineTotal))",
      "-  const discount = subtotal * cart.coupon.rate",
      "+  const raw = subtotal * cart.coupon.rate",
      "+  const discount = Math.min(raw, cart.coupon.cap ?? raw)",
      "   const total = roundCents(subtotal - discount)",
      "   return { subtotal, discount, total }",
      " }",
      "@@ -41,6 +42,7 @@ function lineTotal(item: CartItem): number {",
      "   if (item.quantity <= 0) return 0",
      "-  return item.price * item.quantity",
      "+  const gross = item.price * item.quantity",
      "+  return roundCents(gross)",
      " }",
      " ",
      " export function roundCents(value: number): number {",
    ].join("\n"),
  },
  {
    path: "test/totals.test.ts", status: "modified", additions: 14, deletions: 0, binary: false, truncated: false,
    diff: [
      "@@ -22,3 +22,17 @@ describe(\"totals\", () => {",
      "   test(\"a percentage coupon takes its share\", () => {",
      "     expect(totals(cart({ rate: 0.2 })).discount).toBe(40)",
      "   })",
      "+",
      "+  test(\"a capped coupon never takes more than its cap\", () => {",
      "+    const result = totals(cart({ rate: 0.2, cap: 15 }))",
      "+    expect(result.discount).toBe(15)",
      "+    expect(result.total).toBe(185)",
      "+  })",
      "+",
      "+  test(\"a cap above the percentage changes nothing\", () => {",
      "+    expect(totals(cart({ rate: 0.1, cap: 50 })).discount).toBe(20)",
      "+  })",
      "+",
      "+  test(\"no cap means the whole percentage\", () => {",
      "+    expect(totals(cart({ rate: 0.1 })).discount).toBe(20)",
      "+  })",
      " })",
    ].join("\n"),
  },
  {
    path: "src/api/coupons.ts", status: "modified", additions: 1, deletions: 1, binary: false, truncated: false,
    diff: [
      "@@ -9,4 +9,4 @@ export function preview(code: string, cart: Cart) {",
      "   const coupon = findCoupon(code)",
      "-  return { discount: cart.subtotal * coupon.rate }",
      "+  return { discount: totals({ ...cart, coupon }).discount }",
      " }",
    ].join("\n"),
  },
  {
    path: "src/cart/coupons.ts", status: "modified", additions: 3, deletions: 0, binary: false, truncated: false,
    diff: ["@@ -1,6 +1,9 @@", " export type Coupon = {", "   code: string", "   rate: number", "+  /** The most the coupon may take off one order, in dollars; absent means no limit. */", "+  cap?: number", " }", "+", "+export const hasCap = (coupon: Coupon): boolean => coupon.cap !== undefined"].join("\n"),
  },
  {
    path: "src/checkout/summary.ts", status: "modified", additions: 2, deletions: 2, binary: false, truncated: false,
    diff: ["@@ -28,6 +28,6 @@ export function summary(cart: Cart) {", "   const priced = totals(cart)", "-  const saved = cart.subtotal * cart.coupon.rate", "-  return { ...priced, saved }", "+  const saved = priced.discount", "+  return { ...priced, saved, capped: hasCap(cart.coupon) && saved === cart.coupon.cap }", " }"].join("\n"),
  },
  {
    path: "test/api/coupons.test.ts", status: "added", additions: 18, deletions: 0, binary: false, truncated: false,
    diff: ["@@ -0,0 +1,6 @@", "+import { expect, test } from \"bun:test\"", "+import { preview } from \"../../src/api/coupons\"", "+", "+test(\"the preview applies the cap\", () => {", "+  expect(preview(\"SAVE20\", cart(200)).discount).toBe(15)", "+})"].join("\n"),
  },
  { path: "docs/coupons.md", status: "added", additions: 16, deletions: 0, binary: false, truncated: false, diff: ["@@ -0,0 +1,3 @@", "+# Coupons", "+", "+A coupon takes `rate` of the subtotal and never more than its `cap`."].join("\n") },
  { path: "CHANGELOG.md", status: "modified", additions: 2, deletions: 0, binary: false, truncated: false, diff: ["@@ -1,3 +1,5 @@", " # Changelog", " ", "+- Fixed: a coupon with a cap no longer takes more than the cap off an order.", "+"].join("\n") },
]

/** /changes: the files of the branch's work and the selected file's diff, full screen. */
function changesFrame(): Line[] {
  const report: ChangesReport = { root: "/work/shop-api", branch: "fix/coupon-cap", files: CHANGED, omittedFiles: 0, complete: true }
  return renderChangesPage({ report, state: createChangesPageState(), width: COLUMNS, height: ROWS })
}

const memory = (id: string, text: string, patch: Partial<MemoryEntry> = {}): MemoryEntry => ({ memoryId: id, scope: "project", directory: "/work/shop-api", text, category: "", status: "saved", source: "agent", createdAt: NOW, updatedAt: NOW, ...patch }) as MemoryEntry
const memoryLink = (from: string, to: string, kind: MemoryLink["kind"] = "related"): MemoryLink => ({ from, to, kind, createdAt: NOW }) as MemoryLink

/** /memory, Graph tab: ten saved memories and their links around the selected one. */
function memoryFrame(): Line[] {
  const nodes = [
    memory("cap", "A coupon's discount never exceeds its cap; totals() applies the cap, not the caller.", { category: "constraints" }),
    memory("preview", "The checkout preview calls totals() and must show the capped discount.", { category: "constraints" }),
    memory("coupons", "totals() in src/api/coupons.ts is the only place discounts are computed.", { category: "architecture" }),
    memory("old", "Old rule: discounts are applied in the cart component.", { category: "architecture" }),
    memory("docs", "The API docs give money as integer cents.", { category: "conventions" }),
    memory("cents", "Money is integer cents everywhere; round only in roundCents().", { category: "conventions" }),
    memory("prices", "Prices are stored as integer cents in the orders table.", { category: "conventions" }),
    memory("tests", "Tests run with bun test; every change adds or updates a test.", { category: "tooling", source: "user" }),
    memory("pnpm", "Use pnpm, never npm; CI runs pnpm install --frozen-lockfile.", { category: "tooling", source: "user", scope: "user" }),
    memory("deploy", "Deploys go through the release workflow, never from a laptop.", { category: "tooling" }),
  ]
  const links = [
    memoryLink("cap", "preview", "supports"), memoryLink("cap", "coupons", "supports"), memoryLink("cap", "old", "supersedes"), memoryLink("cap", "tests"),
    memoryLink("coupons", "docs"), memoryLink("docs", "cents", "supports"), memoryLink("cents", "prices"), memoryLink("deploy", "tests"),
  ]
  const connected = new Set(links.flatMap((link) => [link.from as string, link.to as string]))
  const graph: MemoryGraphReport = { nodes, links, health: { nodes: nodes.length, links: links.length, connected: connected.size, isolated: nodes.length - connected.size, conflicts: 0, state: "partial" } } as MemoryGraphReport
  const state = { ...createMemoryPageState(), tab: "graph" as const, graph: { mode: "ego" as const, selected: "cap" } }
  return renderMemoryPage({ memories: nodes, state, directory: "/work/shop-api", width: COLUMNS, height: ROWS, now: NOW, graph, data: { workspaces: { workspaces: [], omitted: 0 }, currentDirectory: "/work/shop-api" } })
}

const RETRO = new URL("../examples/profiles/retro/", import.meta.url).pathname

/** /packages, overrides list: what the retro example package takes over, resolved by the daemon's own resolver from its real manifest and keys. */
function packagesFrame(): Line[] {
  const manifest = JSON.parse(readFileSync(path.join(RETRO, "mendcode-profile.json"), "utf8")) as { activate: Activation; name: string; version: string; description: string }
  const keybindings = JSON.parse(readFileSync(path.join(RETRO, "keybindings.json"), "utf8")) as Record<string, string>
  const key = "user:retro"
  const retro: PackageInfo = {
    name: "retro", source: "user", key, dir: "/Users/dev/.mendcode/packages/retro", enabled: true,
    manifest: { name: manifest.name, version: manifest.version, description: manifest.description },
    install: { source: "github:you/retro", installedAt: NOW - 3_600_000 },
    contents: { tools: 0, skills: 1, commands: 1, themes: 1, mcp: false, extensions: 2 },
  }
  const result = resolveActivation({
    packages: [{ key, scope: "user", activation: manifest.activate, keybindings }],
    state: { user: { kept: [] }, project: { kept: [] } },
    projectTrusted: true,
    base: {},
    panel: () => undefined,
  })
  const activation = { result: { rows: result.rows, owners: result.owners, waiting: result.waiting, conflicts: result.conflicts }, problems: [] }
  const state = { ...createPackagesPageState(), overrides: { key, selected: 0 } }
  return renderPackagesPage({ report: { directory: "/work/shop-api", packages: [retro] }, state, width: COLUMNS, height: ROWS, now: NOW, activation })
}

const RESPONSE = [
  "totals() never read coupon.cap: a $15-cap coupon took $40 off a $200 cart.",
  "",
  "- The discount is now min(subtotal × rate, cap).",
  "- The graph lists two callers; a sub-agent checked preview().",
  "- The new test covers the cap: 3 passed.",
].join("\n")

/** A session of the shop-api work through the real app: the user's request, the folded reads, an edit with its diff, a test run. */
/** `typed`: input typed into the prompt after the turn, as a user would; `settings`: applied before it (a tier, say). */
async function shopSession({ goal = false, finished = false, typed = [], settings = {} }: { goal?: boolean; finished?: boolean; typed?: string[]; settings?: Record<string, unknown> }): Promise<Line[]> {
  const dataDir = mkdtempSync(path.join(tmpdir(), "mendcode-readme-"))
  try {
    writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE })
    // A fixed id: the session's accent color is a hash of it, so a counter would change the picture with the test order.
    const sessionId = "session_readme_shop_api" as SessionId
    const others = [ids("session"), ids("session")]
    const listed = (title: string, minutesAgo: number, id: string) => ({ sessionId: id, title, directory: DIRECTORY, createdAt: NOW - 86_400_000, updatedAt: NOW - minutesAgo * 60_000, lastSeq: 0, state: "idle", queued: 0 })
    const h = appHarness({
      width: COLUMNS, height: ROWS, mode: "balanced", sessionId, dataDir, directory: DIRECTORY,
      reply: (command) => {
        if (command.type === "session.list") return reply({ sessions: [listed("Cap coupon discounts at the coupon's limit", 1, sessionId), listed("Flaky checkout test", 95, others[0]!), listed("Release notes for 2.4", 310, others[1]!)] })
        if (command.type === "git.branch") return reply({ branch: "fix/coupon-cap" })
        if (command.type === "changes.query") return reply({ root: DIRECTORY, files: CHANGED.map(({ diff: _diff, ...file }) => ({ ...file, diff: "" })), omittedFiles: 0 })
        return undefined
      },
    })
    h.app.applySettings({ onboarded: true, ...settings } as never)
    await Bun.sleep(5)
    let seq = 0
    let clock = NOW - 90_000
    const emit = (body: Record<string, unknown>) => {
      clock += 1_000
      h.app.onEvent({ sessionId, seq: ++seq, at: clock, ...body } as never)
    }
    // An earlier turn: the failing run that started the work.
    const first = ids("turn")
    emit({ type: "turn.started", turnId: first, queueId: ids("queue") })
    const asked = ids("item")
    emit({ type: "item.started", turnId: first, itemId: asked, kind: "user_message" })
    emit({ type: "item.completed", itemId: asked, status: "ok", text: "Support says a $15-cap coupon took $40 off a $200 cart. Can you reproduce it?" })
    const ran = ids("item")
    emit({ type: "item.started", turnId: first, itemId: ran, kind: "tool_call", meta: { tool: "shell: bun run scripts/price.ts SAVE20 200" } })
    emit({ type: "item.completed", itemId: ran, status: "ok", text: "coupon SAVE20 rate 0.2 cap 15\nsubtotal 200.00\ndiscount 40.00\ntotal 160.00\n", meta: { exitCode: 0, durationMs: 400 } })
    const said = ids("item")
    emit({ type: "item.started", turnId: first, itemId: said, kind: "agent_message" })
    emit({ type: "item.completed", itemId: said, status: "ok", text: "Reproduced: the discount is the whole 20%, so the cap is ignored somewhere in the pricing path." })
    emit({ type: "turn.completed", turnId: first })
    const turn = ids("turn")
    const item = (kind: string, text: string, meta: Record<string, unknown> = {}, status = "ok", started: Record<string, unknown> = {}) => {
      const itemId = ids("item")
      emit({ type: "item.started", turnId: turn, itemId, kind, ...(Object.keys(started).length ? { meta: started } : {}) })
      emit({ type: "item.completed", itemId, status, text, meta })
      return itemId
    }
    const tool = (title: string, text: string, meta: Record<string, unknown> = {}) => {
      const itemId = ids("item")
      emit({ type: "item.started", turnId: turn, itemId, kind: "tool_call", meta: { tool: title } })
      emit({ type: "item.completed", itemId, status: "ok", text, meta })
      return itemId
    }
    emit({ type: "turn.started", turnId: turn, queueId: ids("queue") })
    item("user_message", "Orders with a capped coupon get the full percentage off. Find why, fix it and add a test.")
    if (finished) {
      tool("read: src/cart/totals.ts", Array.from({ length: 30 }, (_, i) => `${String(i + 1).padStart(6)}\tline ${i}`).join("\n"))
      tool("read: src/cart/coupons.ts", Array.from({ length: 22 }, (_, i) => `${String(i + 1).padStart(6)}\tline ${i}`).join("\n"))
      tool("read: test/totals.test.ts", Array.from({ length: 24 }, (_, i) => `${String(i + 1).padStart(6)}\tline ${i}`).join("\n"))
      tool("grep: coupon.cap", "src/cart/coupons.ts:4:  cap?: number\nsrc/api/coupons.ts:9:  const coupon = findCoupon(code)")
    }
    tool("edit: src/cart/totals.ts", ["--- a/src/cart/totals.ts", "+++ b/src/cart/totals.ts", ...CHANGED[0]!.diff.split("\n").slice(0, 8)].join("\n"))
    if (finished || goal) {
      tool("shell: bun test test/totals.test.ts", "bun test v1.3\n\ntest/totals.test.ts:\n(pass) totals > a percentage coupon takes its share\n(pass) totals > a capped coupon never takes more than its cap\n(pass) totals > no cap means the whole percentage\n\n 3 pass\n 0 fail\n", { exitCode: 0, durationMs: 1_100 })
    }
    if (finished) {
      tool("graph_callers: totals", "src/api/coupons.ts:9 preview\nsrc/checkout/summary.ts:31 summary")
      const task = ids("item")
      emit({ type: "item.started", turnId: turn, itemId: task, kind: "tool_call", meta: { tool: "task: Check the API's coupon preview" } })
      emit({ type: "item.completed", itemId: task, status: "ok", text: "task_id: ses_review\nstate: completed\npreview() uses the same totals(); nothing else to change.", meta: { toolCalls: 4, durationMs: 21_400, taskId: "ses_review", state: "completed" }, toolInput: JSON.stringify({ agent: "reviewer", model: "gpt-6-luna-mini", description: "Check the API's coupon preview" }) })
      tool("todo 3/3", "[x] Find where the cap is ignored\n[x] Cap the discount in totals() and test it\n[x] Check the API's coupon preview")
      item("agent_message", RESPONSE)
      emit({ type: "usage.recorded", turnId: turn, provider: "native", model: "gpt-6-luna", input: 72_000, output: 2_000, reasoning: 0, cacheRead: 0, cacheWrite: 0, contextTokens: 74_000 })
      emit({ type: "turn.completed", turnId: turn })
    } else if (goal) {
      tool("todo 2/3", "[x] Find where the cap is ignored\n[x] Cap the discount in totals() and test it\n[ ] Check the API's coupon preview")
      item("agent_message", RESPONSE.split("\n").filter((row) => !row.includes("sub-agent")).join("\n"))
      tool("read: src/api/coupons.ts", Array.from({ length: 30 }, (_, i) => `${String(i + 1).padStart(6)}\tline ${i}`).join("\n"))
      const running = ids("item")
      emit({ type: "item.started", turnId: turn, itemId: running, kind: "tool_call", meta: { tool: "shell: bun test test/api" } })
      emit({ type: "item.delta", itemId: running, text: "bun test v1.3\ntest/api/coupons.test.ts:\n" })
      emit({ type: "usage.recorded", turnId: turn, provider: "native", model: "gpt-6-luna", input: 72_000, output: 2_000, reasoning: 0, cacheRead: 0, cacheWrite: 0, contextTokens: 74_000 })
      const created: Goal = { goalId: ids("goal"), sessionId, objective: "Cap coupon discounts and cover the API preview", status: "active", tokenBudget: 200_000, tokensUsed: 64_000, timeUsedSeconds: 360, createdAt: NOW - 360_000, updatedAt: NOW } as Goal
      emit({ type: "goal.changed", change: "progress", goal: created, by: "system" })
    }
    for (const input of typed) await h.type(input)
    await Bun.sleep(5)
    h.app.render()
    return h.frames.at(-1)!
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
}

const HOME = "/Users/dev"
const PROJECT = `${HOME}/Code/shop-api`

/** Credentials in the demo vault: names and scopes only, as the daemon answers `env.list`; no value exists anywhere. */
const CREDENTIALS = [
  { name: "FAKE_API_KEY", scope: "project", updatedAt: NOW - 3_600_000 },
  { name: "STRIPE_TEST_KEY", scope: "project", updatedAt: NOW - 7_200_000 },
  { name: "DATABASE_URL", scope: "session", updatedAt: NOW - 600_000 },
  { name: "GITHUB_TOKEN", scope: "global", updatedAt: NOW - 3 * 86_400_000 },
]

/** A demo `.env` pasted on /env. Its values are placeholders; the page lists the names the daemon reports and never shows a value. */
const PASTED_DOTENV = "FAKE_API_KEY=‹secret:1›\nFAKE_WEBHOOK_SECRET=‹secret:2›\nSENTRY_DSN=‹secret:3›\nPATH=/tmp/demo\nEMPTY_FLAG=\n"
const PASTED_ITEMS = [
  { name: "FAKE_API_KEY", status: "replace" },
  { name: "FAKE_WEBHOOK_SECRET", status: "new" },
  { name: "SENTRY_DSN", status: "new" },
  { name: "PATH", status: "refused", reason: "runtime configuration" },
  { name: "EMPTY_FLAG", status: "empty" },
]

const listedSession = (sessionId: string, title: string, folder: string, minutesAgo: number) => ({ sessionId, title, directory: `${HOME}/Code/${folder}`, createdAt: NOW - 2 * 86_400_000, updatedAt: NOW - minutesAgo * 60_000, lastSeq: 12, state: "idle", queued: 0 })
const SESSIONS = [
  listedSession("session_readme_shop_api", "Cap coupon discounts at the coupon's limit", "shop-api", 1),
  listedSession("session_readme_flaky", "Flaky checkout test", "shop-api", 95),
  listedSession("session_readme_notes", "Release notes for 2.4", "shop-api", 310),
  listedSession("session_readme_cents", "Migrate orders to integer cents", "shop-api", 1_500),
  listedSession("session_readme_dark", "Dark mode for the dashboard", "admin-web", 40),
  listedSession("session_readme_csv", "Fix the CSV export header", "admin-web", 2_900),
  listedSession("session_readme_rate", "Rate limit the public API", "gateway", 200),
  listedSession("session_readme_guide", "Write the onboarding guide", "docs-site", 4_400),
]

/**
 * A page of the real app, opened by typing into it as a user does, over a throwaway data dir and fixed daemon replies. HOME is the
 * demo user's for the frame, so folders read `~/Code/...` and nothing of the machine's own home shows.
 */
async function appPage({ typed }: { typed: string[] }): Promise<Line[]> {
  const dataDir = mkdtempSync(path.join(tmpdir(), "mendcode-readme-"))
  const home = process.env.HOME
  process.env.HOME = HOME
  try {
    writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE })
    const h = appHarness({
      width: COLUMNS, height: ROWS, mode: "balanced", sessionId: "session_readme_shop_api" as SessionId, dataDir, directory: PROJECT,
      reply: (command) => {
        if (command.type === "env.list") return reply({ entries: CREDENTIALS, native: true, engines: true })
        if (command.type === "privacy.get") return reply({ enabled: false, target: false })
        if (command.type === "env.import") return reply({ digest: "demo", items: PASTED_ITEMS })
        if (command.type === "session.list") return reply({ sessions: SESSIONS })
        if (command.type === "git.branch") return reply({ branch: "fix/coupon-cap" })
        return undefined
      },
    })
    h.app.applySettings({ onboarded: true })
    await Bun.sleep(5)
    for (const input of typed) await h.type(input)
    await Bun.sleep(5)
    h.app.render()
    return h.frames.at(-1)!
  } finally {
    if (home === undefined) delete process.env.HOME
    else process.env.HOME = home
    rmSync(dataDir, { recursive: true, force: true })
  }
}

const BRACKETED = (text: string) => `\x1b[200~${text}\x1b[201~`

export type Scene = { file: string; title: string; frame: () => Promise<Line[]> | Line[] }

export const SCENES: Scene[] = [
  { file: "session.svg", title: `mendcode — ${DIRECTORY}`, frame: () => shopSession({ finished: true }) },
  { file: "goal.svg", title: "mendcode — /goal", frame: () => shopSession({ goal: true }) },
  { file: "changes.svg", title: "mendcode — /changes", frame: changesFrame },
  { file: "memory-graph.svg", title: "mendcode — /memory", frame: memoryFrame },
  { file: "profiles.svg", title: "mendcode — /packages", frame: packagesFrame },
  { file: "env.svg", title: "mendcode — /env", frame: () => appPage({ typed: ["/env\r"] }) },
  { file: "env-paste.svg", title: "mendcode — /env, a pasted .env", frame: () => appPage({ typed: ["/env\r", BRACKETED(PASTED_DOTENV)] }) },
  { file: "privacy.svg", title: "mendcode — /privacy", frame: () => appPage({ typed: ["/privacy\r"] }) },
  { file: "sessions.svg", title: "mendcode — /sessions", frame: () => appPage({ typed: ["/sessions\r", "\x0c"] }) },
  // In minimalist, a command of a higher tier typed by hand answers in one row on the prompt: the tier that has it and how to get there.
  { file: "notice.svg", title: "mendcode — a one-line notice", frame: () => shopSession({ finished: true, typed: ["/review\r"], settings: { tier: "minimalist" } }) },
]

export const IMAGES_DIR = new URL("../docs/assets/readme/", import.meta.url).pathname

/** Every scene's SVG, by file name. */
export async function renderImages(only: readonly string[] = []): Promise<Record<string, string>> {
  // The product's own look, whatever the machine or an earlier test left behind: default theme, unicode glyphs, no color overrides.
  const previousTheme = activeTheme().name
  const previousEnv = { glyphs: process.env.MENDCODE_GLYPHS, theme: process.env.MENDCODE_THEME }
  delete process.env.MENDCODE_GLYPHS
  delete process.env.MENDCODE_THEME
  setTheme(DEFAULT_THEME)
  setGlyphMode("unicode")
  setColorOverrides({})
  try {
    const out: Record<string, string> = {}
    for (const scene of SCENES) {
      if (only.length > 0 && !only.some((name) => scene.file.startsWith(name))) continue
      const frame = await scene.frame()
      out[scene.file] = renderSvg({ frame, title: scene.title })
    }
    return out
  } finally {
    setTheme(previousTheme)
    if (previousEnv.glyphs !== undefined) process.env.MENDCODE_GLYPHS = previousEnv.glyphs
    if (previousEnv.theme !== undefined) process.env.MENDCODE_THEME = previousEnv.theme
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const check = args.includes("--check")
  const names = args.filter((arg) => !arg.startsWith("--"))
  const images = await renderImages(names)
  mkdirSync(IMAGES_DIR, { recursive: true })
  let drifted = 0
  for (const [file, svg] of Object.entries(images)) {
    const target = path.join(IMAGES_DIR, file)
    if (check) {
      const current = (await Bun.file(target).exists()) ? await Bun.file(target).text() : undefined
      if (current !== svg) {
        console.error(`docs/assets/readme/${file} drifted: run \`bun scripts/readme-images.ts\` and commit the images`)
        drifted++
      }
    } else {
      await Bun.write(target, svg)
      console.log(`wrote docs/assets/readme/${file} (${svg.length} bytes)`)
    }
  }
  if (drifted > 0) process.exitCode = 1
}
