import { createIdFactory, type Settings } from "@mendcode/protocol"
import { DEFAULT_TUI_PROFILE, writeTuiProfile, type TuiProfile } from "../src/view/tui-profile"
import { appHarness, plain, scratch } from "./extensions-harness"

/**
 * The owner's Pi status area, asked of MendCode and resolved by settings alone: a profile, the quota readings a session has, and one
 * model call. Shared by the footer-rows tests and `scripts/render-footer-rows-frames.ts`, so the frames and the assertions are one scene.
 */
export const NOW = 1_800_000_000_000
const HOUR = 3_600_000
const DAY = 24 * HOUR
const ids = createIdFactory()

/** Which readings the session holds: both providers fresh as the owner saw them, a stale one, one whose windows ended, or none at all. */
export type QuotaScene = "fresh" | "stale" | "expired" | "unknown"

const snapshot = (provider: string, windows: Array<{ id: string; label: string; usedPercent: number; resetsAt?: number }>, fetchedAt = NOW) => ({ type: "quota.snapshot", gseq: 1, at: NOW, provider, windows, fetchedAt, source: "local test fixture" }) as never

export function quotaScene(scene: QuotaScene): unknown[] {
  if (scene === "unknown") return []
  if (scene === "fresh") return [
    snapshot("codex", [{ id: "secondary", label: "7d", usedPercent: 8, resetsAt: NOW + 5 * DAY + 9 * HOUR }]),
    snapshot("claude", [{ id: "seven_day", label: "7d", usedPercent: 61, resetsAt: NOW + DAY + 23 * HOUR }, { id: "five_hour", label: "5h", usedPercent: 11, resetsAt: NOW + 2 * HOUR }]),
  ]
  // Claude's last turn ran two days ago, in windows that have not ended; Codex is current.
  if (scene === "stale") return [
    snapshot("codex", [{ id: "secondary", label: "7d", usedPercent: 8, resetsAt: NOW + 5 * DAY + 9 * HOUR }]),
    snapshot("claude", [{ id: "seven_day", label: "7d", usedPercent: 38, resetsAt: NOW + 3 * DAY }, { id: "five_hour", label: "5h", usedPercent: 4, resetsAt: NOW + 20 * HOUR }], NOW - 2 * DAY - 2 * HOUR),
  ]
  // Claude's 5h window ended since the reading; its 7d window is still open.
  return [
    snapshot("codex", [{ id: "secondary", label: "7d", usedPercent: 8, resetsAt: NOW + 5 * DAY + 9 * HOUR }]),
    snapshot("claude", [{ id: "seven_day", label: "7d", usedPercent: 38, resetsAt: NOW + 3 * DAY }, { id: "five_hour", label: "5h", usedPercent: 96, resetsAt: NOW - 3 * HOUR }], NOW - 2 * DAY - 2 * HOUR),
  ]
}

/** What `/footer preset rows` plus the tagline sets, as a profile. */
export const FIVE_ROWS: Partial<TuiProfile> = {
  footerRows: [["directory", "text:tagline"], ["model", "effort", "context", "cache", "tokens"], ["quota:codex"], ["quota:claude"], ["codegraph"]],
  footerText: { tagline: "keep the contract, improve the result" },
  quotaView: "left",
  quotaColor: "accent",
}

export type RowsOptions = { profile?: Partial<TuiProfile>; width?: number; height?: number; theme?: string; quotas?: QuotaScene; settings?: Settings; effort?: string; calls?: boolean; /** The daemon's `codegraph.status` for the session's directory, as pushed after a graph tool indexed it. */ graph?: "indexing" | "indexed"; /** The daemon's `session.savings` reply, by source. */ savings?: Array<{ source: string; calls: number; tokens: number }> }

/** A session after one model call, with the footer the profile asks for. */
export async function rowsScreen(options: RowsOptions = {}) {
  const layout = scratch()
  writeTuiProfile(layout.dataDir, { ...DEFAULT_TUI_PROFILE, ...(options.theme ? { theme: options.theme } : {}), ...options.profile })
  const h = await appHarness({
    dataDir: layout.dataDir, directory: "/Users/dev/Code/MendCodeV2", home: "/Users/dev", width: options.width ?? 160, height: options.height ?? 30,
    reply: (command) => command.type === "models.list" ? { ok: true, result: { models: [], effective: { model: "gpt-6.1-sol", effort: options.effort ?? "low" } } } : command.type === "session.savings" && options.savings ? { ok: true, result: { savings: options.savings } } : undefined,
  })
  await h.start({ onboarded: true, tier: "full", reducedMotion: true, ...options.settings })
  await Bun.sleep(5)
  for (const event of quotaScene(options.quotas ?? "fresh")) h.app.onGlobal(event as never)
  if (options.graph) {
    const indexed = options.graph === "indexed"
    h.app.onGlobal({ type: "codegraph.status", gseq: 0, at: NOW, directory: "/Users/dev/Code/MendCodeV2", state: options.graph, files: indexed ? 2594 : 0, symbols: indexed ? 17641 : 0, edges: indexed ? 41203 : 0, partial: false } as never)
  }
  h.message("hello", "hi")
  if (options.calls !== false) {
    const turnId = ids("turn")
    h.event({ type: "usage.recorded", turnId, provider: "openai", model: "gpt-6.1-sol", input: 3_100, output: 13, reasoning: 0, cacheRead: 0, cacheWrite: 0, contextTokens: 1_600 })
  }
  h.app.render()
  const lines = () => h.frames.at(-1)!
  return { h, lines, text: () => lines().map(plain), cleanup: layout.cleanup }
}
