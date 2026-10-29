import { colorDepth, glyphs, sgr, type Line } from "../../apps/cli/src/ui/theme"
import { renderHome, type HomeSession } from "../../apps/cli/src/view/home"
import { textWidth } from "../../apps/cli/src/view/wrap"

/** usage: bun home-fixture.ts <width> <height> <empty|mixed|busy> — the home above a v1-style prompt, as the app lays it out. */
const width = Number(process.argv[2] ?? 120)
const height = Number(process.argv[3] ?? 40)
const scenario = process.argv[4] ?? "empty"
const now = Date.parse("2026-09-28T12:00:00Z")
const minutes = (count: number) => now - count * 60_000

const SESSIONS: Record<string, HomeSession[]> = {
  empty: [],
  mixed: [
    { id: "a", title: "Approve the migration plan", state: "needs_input", updatedAt: minutes(2), startedAt: minutes(12), detail: "Run command: bun run migrate" },
    { id: "b", title: "Fix flaky reconnect in the daemon", state: "looping", updatedAt: minutes(1), startedAt: minutes(95), detail: "loop 3 of 8, tests failing" },
    { id: "c", title: "Port the palette to the v1 look", state: "working", updatedAt: minutes(0), startedAt: minutes(4), detail: "edit apps/cli/src/view/palette.ts" },
    { id: "d", title: "Audit the storage cleanup", state: "working", updatedAt: minutes(0), startedAt: minutes(31), detail: "~/Code/MendCodeV2" },
    { id: "e", title: "Write the release notes", state: "completed", updatedAt: minutes(48), detail: "~/Code/MendCodeV2" },
    { id: "f", title: "Investigate the slow first paint of the transcript on a very long session", state: "completed", updatedAt: minutes(60 * 30), detail: "~/Code/MendCode" },
  ],
  busy: Array.from({ length: 16 }, (_, index): HomeSession => ({
    id: String(index),
    title: `Session number ${index + 1}`,
    state: (["needs_input", "looping", "working", "completed"] as const)[index % 4]!,
    updatedAt: minutes(index * 7),
    startedAt: minutes(index * 9),
    detail: "~/Code/MendCodeV2",
  })),
}

const g = glyphs({})
const version = "0.4.2"
const promptRows: Line[] = [
  [{ text: `  ${g.rule.repeat(width - 4)}`, fg: "primary" }],
  [{ text: "  ❭ ", fg: "muted" }, { text: 'Ask anything... "Fix a TODO in the codebase"', fg: "muted" }],
  [{ text: `  ${g.rule.repeat(width - 4)}`, fg: "primary" }],
  [{ text: " Ask", fg: "primary" }, { text: " · ", fg: "muted" }, { text: "gpt-5", fg: "text" }, { text: " · ", fg: "muted" }, { text: "openai", fg: "muted" }],
]

export function homeScreen(size: { width: number; height: number }, sessions: HomeSession[]): Line[] {
  const body = size.height - promptRows.length - 1
  const rows = renderHome({ width: size.width, height: body, screenHeight: size.height, version, root: "~/Code/MendCodeV2", sessions, selectedId: sessions[2]?.id ?? "", now, spinner: 3 })
  while (rows.length < body) rows.push([])
  return [...rows.slice(0, body), [], ...promptRows]
}

export function print(lines: Line[]) {
  const depth = colorDepth({ COLORTERM: "truecolor" })
  for (const line of lines) {
    let out = ""
    let used = 0
    for (const span of line) {
      const style = sgr(span, depth)
      out += style ? `${style}${span.text}\x1b[0m` : span.text
      used += textWidth(span.text)
    }
    process.stdout.write(`${out}\n`)
  }
}

if (import.meta.main) print(homeScreen({ width, height }, SESSIONS[scenario] ?? []))
