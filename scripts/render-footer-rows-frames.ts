import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { plain } from "../apps/cli/test/extensions-harness"
import { FIVE_ROWS, rowsScreen, type QuotaScene, type RowsOptions } from "../apps/cli/test/footer-rows-fixture"
import { activeTheme, sgr, type Line, type Span } from "../apps/cli/src/ui/theme"
import { DEFAULT_TUI_PROFILE } from "../apps/cli/src/view/tui-profile"

/**
 * The multi-row footer's frames: each one is a screen of the real wired app (appHarness: createApp, the real renderer) after one model call,
 * with a profile that asks for the Pi-like status area and nothing else (no extension). Usage: `bun scripts/render-footer-rows-frames.ts [directory]`.
 * For each scene it writes `<name>.txt` and `<name>.ansi` (dark theme `mend`) and `<name>.roles.txt`: the footer's rows with every span tagged by
 * its theme role and attributes, dark then light (`paper`). `PREVIEW.txt` puts Pi's reference next to the result.
 */
const target = process.argv[2] ?? path.join(import.meta.dir, "../.agents/runs/frames/footer-rows")
mkdirSync(target, { recursive: true })

const THEMES = [{ label: "dark", name: "mend" }, { label: "light", name: "paper" }] as const
const FOOTER_TAIL = 8

function tag(span: Span): string {
  const parts = [`fg=${span.fg ?? span.fgHex ?? "(terminal)"}`]
  if (span.bg || span.bgHex) parts.push(`bg=${span.bg ?? span.bgHex}`)
  for (const attribute of ["bold", "dim", "italic", "underline", "strike"] as const) if (span[attribute]) parts.push(attribute)
  return parts.join(" ")
}

/** The last rows of the frame (the footer sits under the prompt), each span tagged by role. */
function rolesOf(lines: Line[]): string[] {
  const start = Math.max(0, lines.length - FOOTER_TAIL)
  return lines.slice(start).map((line, offset) => {
    const merged: Span[] = []
    for (const span of line) {
      const last = merged.at(-1)
      if (last && tag(last) === tag(span)) last.text += span.text
      else merged.push({ ...span })
    }
    const shown = (text: string) => JSON.stringify(text.replace(/ {4,}/g, (run) => `<${run.length} spaces>`))
    return `${String(start + offset).padStart(2)}| ${merged.filter((span) => span.text.trim() !== "").map((span) => `[${tag(span)}] ${shown(span.text)}`).join(" ")}`
  })
}

const roleTable = () => Object.entries(activeTheme().colors as Record<string, string>).map(([role, hex]) => `  ${role.padEnd(12)} ${hex}`)
const rows = (lines: Line[]) => lines.map(plain)

type Scene = { name: string; options: RowsOptions; /** Only these themes are drawn; the first is the one written as `<name>.txt`. */ themes?: Array<(typeof THEMES)[number]["label"]> }
const five = (icons: "none" | "glyph" | "nerd", extra: RowsOptions = {}): RowsOptions => ({ ...extra, profile: { ...FIVE_ROWS, footerIcons: icons, ...extra.profile } })

const scenes: Scene[] = [
  { name: "classic-160", options: { width: 160 } },
  ...(["none", "glyph", "nerd"] as const).flatMap((icons) => [160, 100, 60].map((width) => ({ name: `rows-${icons}-${width}`, options: five(icons, { width }) }))),
  ...(["fresh", "stale", "expired", "unknown"] as QuotaScene[]).map((quotas) => ({ name: `quota-${quotas}`, options: five("nerd", { width: 160, quotas }) })),
  { name: "graph-on", options: five("nerd", { width: 160 }) },
  { name: "graph-indexing", options: five("nerd", { width: 160, graph: "indexing" }) },
  { name: "graph-indexed", options: five("nerd", { width: 160, graph: "indexed" }) },
  { name: "graph-off", options: five("nerd", { width: 160, graph: "indexed", settings: { features: { codegraph: false } } as never }) },
  { name: "terminal-12-rows", options: five("nerd", { width: 160, height: 12 }) },
  { name: "terminal-20-rows", options: five("nerd", { width: 160, height: 20 }) },
  { name: "light-theme", options: five("nerd", { width: 160 }), themes: ["light"] },
]

const sections = new Map<string, string[]>()
const screens = new Map<string, string[]>()
for (const scene of scenes) {
  const out: string[] = []
  const drawn = THEMES.filter((theme) => !scene.themes || scene.themes.includes(theme.label))
  for (const theme of drawn) {
    const screen = await rowsScreen({ ...scene.options, theme: theme.name })
    const lines = screen.lines()
    out.push(`== ${theme.label} (${theme.name}) ==`, ...rolesOf(lines), "", `roles in ${theme.name}:`, ...roleTable(), "")
    if (theme === drawn[0]) {
      writeFileSync(path.join(target, `${scene.name}.txt`), rows(lines).join("\n") + "\n")
      writeFileSync(path.join(target, `${scene.name}.ansi`), lines.map((line) => line.map((span) => sgr(span, "truecolor") + span.text + "\x1b[0m").join("")).join("\n") + "\n")
      screens.set(scene.name, rows(lines))
      console.log(`${scene.name}: ${lines.length} rows`)
    }
    screen.cleanup()
  }
  writeFileSync(path.join(target, `${scene.name}.roles.txt`), out.join("\n") + "\n")
  sections.set(scene.name, out)
}

const PI = [
  " ~/Code/MendCodeV2  |  keep the contract, improve the result",
  " gpt-6.1-sol |  low:JEV |  context 1% | {..} cache 0% |  in 3.1k / out 13 / read 0",
  " CODEX  | 7d ██████░░ 92% left | 5h n/a | reset 5d9h",
  " CLAUDE | 7d ███░░░░░ 39% left | 5h ███████░ 89% left | reset 1d23h | cached",
  " GRAFT  | 20287 nodes | 59533 edges | synced | 0 tok saved",
]
const mine = screens.get("graph-indexed")!
const footer = mine.slice(-FOOTER_TAIL).filter((line) => line.trim() !== "")
const graphStates = ["graph-on", "graph-indexing", "graph-indexed", "graph-off"].map((name) => `  ${name.padEnd(15)} ${screens.get(name)!.filter((line) => /graph/i.test(line)).map((line) => line.replace(/^.*│/, "").trim()).join("")}`)
const preview = [
  "PI (the target, from the owner's terminal)",
  ...PI,
  "",
  "MENDCODE (settings only: /footer preset rows, /footer icons nerd; no extension). The last rows of the 160x30 frame:",
  ...footer,
  "",
  "Roles of each part (dark `mend`; the full dump is graph-indexed.roles.txt):",
  ...(sections.get("graph-indexed")!.filter((line) => /^\s*\d+\|/.test(line)).slice(-6)),
  "",
  "The graph row by state (the daemon pushes the counts when the index changes, so they are as of the last graph tool run in the project; `~N saved` joins when the session counts it):",
  ...graphStates,
  "",
  "Parts with no source in MendCode: \"synced\" (whether the index is current with the disk) and the Pi-only `tok saved` of another tool.",
]
writeFileSync(path.join(target, "PREVIEW.txt"), preview.join("\n") + "\n")
void DEFAULT_TUI_PROFILE
console.log(`frames in ${target}`)
