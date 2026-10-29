import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { appHarness, cleanTemps, plain, tempDir } from "../apps/cli/test/session-ui-harness"
import { densitySession, densitySubset, DENSITY_NOW } from "../apps/cli/test/density-session"
import { activeTheme, glyphs, setTheme, sgr, type Line, type Span } from "../apps/cli/src/ui/theme"
import { createTranscript } from "../apps/cli/src/view/transcript"
import { DEFAULT_TUI_PROFILE, writeTuiProfile, type TuiProfile } from "../apps/cli/src/view/tui-profile"
import { orbitDetails, ORBIT_CARD_ROWS, renderOrbit, type OrbitCamera, type OrbitGraph } from "../apps/cli/src/view/panel-orbit"
import { panelCard } from "../apps/cli/src/view/panel-card"

/**
 * The full view's frames for the density work. Every frame is the real transcript or the real wired app (appHarness) on the
 * owner's session (`apps/cli/test/density-session.ts`). Usage: `bun scripts/render-density-frames.ts [directory] [before|after]`.
 * For each scene it writes `<name>.txt` (plain), `<name>.ansi` (truecolor, dark `mend`), `<name>.roles.txt` (every span tagged by
 * its theme role and attributes, dark `mend` then light `paper`, with the color each role has in the theme) and, for the
 * failed-card scenes, `<name>.ansi256` (the 256-color fallback). `before` draws the build without the setting (the default
 * rendering at the time of the owner's screenshots); `after` draws each density, the failed cards, and the Galaxy block.
 */
const target = process.argv[2] ?? path.join(import.meta.dir, "../.agents/runs/frames/full-density")
const phase = process.argv[3] === "after" ? "after" : "before"
mkdirSync(target, { recursive: true })

const THEMES = [{ label: "dark", name: "mend" }, { label: "light", name: "paper" }] as const
const DENSITIES = ["dense", "standard", "calm"] as const

function tag(span: Span): string {
  const parts = [`fg=${span.fg ?? span.fgHex ?? "(terminal)"}`]
  if (span.bg || span.bgHex) parts.push(`bg=${span.bg ?? span.bgHex}`)
  for (const attribute of ["bold", "dim", "italic", "underline", "strike"] as const) if (span[attribute]) parts.push(attribute)
  if (span.link) parts.push("link")
  return parts.join(" ")
}

function rolesOf(lines: readonly Line[]): string[] {
  return lines.map((line, row) => {
    const merged: Span[] = []
    for (const span of line) {
      const last = merged.at(-1)
      if (last && tag(last) === tag(span)) last.text += span.text
      else merged.push({ ...span })
    }
    const shown = (text: string) => JSON.stringify(text.replace(/ {4,}/g, (run) => `<${run.length} spaces>`))
    return `${String(row).padStart(3)}| ${merged.filter((span) => span.text !== "").map((span) => `[${tag(span)}] ${shown(span.text)}`).join(" ")}`
  })
}

function roleTable(): string[] {
  const colors = activeTheme().colors as Record<string, string>
  return Object.entries(colors).map(([role, hex]) => `  ${role.padEnd(12)} ${hex}`)
}

/** Writes one scene; `lines` is called once per theme (the rows do not depend on it, the role table does). */
function write(name: string, lines: () => Line[], options: { fallbacks?: boolean } = {}) {
  const sections: string[] = []
  let first: Line[] = []
  for (const theme of THEMES) {
    setTheme(theme.name)
    const rows = lines()
    sections.push(`== ${theme.label} (${theme.name}) ==`, ...rolesOf(rows), "", `roles in ${theme.name}:`, ...roleTable(), "")
    if (theme.label === "dark") first = rows
  }
  setTheme("mend")
  const text = first.map((line) => plain(line).replace(/\s+$/, ""))
  writeFileSync(path.join(target, `${name}.txt`), text.join("\n") + "\n")
  writeFileSync(path.join(target, `${name}.ansi`), first.map((line) => line.map((span) => sgr(span, "truecolor") + span.text + "\x1b[0m").join("")).join("\n") + "\n")
  writeFileSync(path.join(target, `${name}.roles.txt`), sections.join("\n") + "\n")
  if (options.fallbacks) writeFileSync(path.join(target, `${name}.ansi256`), first.map((line) => line.map((span) => sgr(span, "256") + span.text + "\x1b[0m").join("")).join("\n") + "\n")
  console.log(`${name}: ${first.length} rows`)
}

type Density = (typeof DENSITIES)[number]
const profileOf = (density: Density | undefined, extra: Partial<TuiProfile> = {}) => ({ ...DEFAULT_TUI_PROFILE, ...(density ? { toolDensity: density } : {}), ...extra }) as TuiProfile

/** The whole transcript of `events` at `width`, as the rows the chat column draws. */
function transcriptRows(events: Parameters<ReturnType<typeof createTranscript>["apply"]>[0][], width: number, density: Density | undefined): Line[] {
  const t = createTranscript({ appearance: profileOf(density), glyphs: glyphs({}), mode: "full", now: () => DENSITY_NOW })
  t.setAppearance({ ...profileOf(density), reasoning: "auto", toolOutput: "auto", timestamps: false })
  for (const event of events) t.apply(event)
  return t.viewport(width, 5000).map((line) => line.spans)
}

const session = () => densitySession("ses_density")
const sceneName = (kind: string, density: Density | undefined, size: string) => `${phase === "before" ? "before" : density ?? "default"}-${kind}-${size}`

/** The wired app on the fixture: the screen at the bottom of the session. */
function screen(density: Density | undefined, width: number, height: number): Line[] {
  const dataDir = tempDir()
  if (density) writeTuiProfile(dataDir, profileOf(density))
  const h = appHarness({ dataDir, directory: tempDir(), width, height, mode: "full" })
  h.app.applySettings({ onboarded: true, reducedMotion: true })
  const { events } = densitySession(h.sessionId)
  for (const event of events) h.app.onEvent(event)
  h.app.render()
  return h.frames.at(-1) ?? []
}

const sizes = [[160, 45], [100, 30]] as const
const densities: Array<Density | undefined> = phase === "before" ? [undefined] : [...DENSITIES]
for (const density of densities) {
  for (const [width, height] of sizes) {
    write(sceneName("session", density, `${width}x${height}`), () => transcriptRows(session().events, width, density))
    write(sceneName("screen", density, `${width}x${height}`), () => screen(density, width, height))
  }
}

// The failed cards: the shell of the owner's screenshot and the two short errors, on their own.
const fixture = session()
const failedShell = densitySubset(fixture, (tool) => tool.title.startsWith("shell: mendcode docs packages"))
const shortErrors = densitySubset(fixture, (tool) => tool.failed && !tool.title.startsWith("shell:"))
for (const width of [100, 80]) {
  const density = phase === "before" ? undefined : "calm"
  write(`${phase}-failed-shell-${width}`, () => transcriptRows(failedShell, width, density), { fallbacks: true })
  write(`${phase}-short-error-${width}`, () => transcriptRows(shortErrors, width, density), { fallbacks: true })
}

// The Galaxy panel's Top block (and its neighbours) at the panel's default width and at 32 columns.
const orbitGraph: OrbitGraph = (() => {
  const node = (id: string, kind: OrbitGraph["nodes"][number]["kind"], label: string, activity: number, at = DENSITY_NOW - 60_000) => ({ id, kind, label, target: label, activity, at })
  const nodes = [node("agent:session", "agent", "This session", 38), node("tool:glob", "tool", "glob", 8), node("tool:grep", "tool", "grep", 8), node("tool:read", "tool", "read", 5), node("tool:web_search", "tool", "web_search", 4), node("file:docs-commands", "file", "apps/cli/src/docs-commands.ts", 3), node("file:packages-md", "file", "docs/packages.md", 2), node("mcp:graft", "mcp", "graft", 0)]
  return { nodes, edges: [["agent:session", "tool:glob"], ["agent:session", "tool:grep"], ["agent:session", "tool:read"], ["tool:read", "file:packages-md"], ["tool:grep", "file:docs-commands"]], touches: [{ from: "tool:read", to: "file:packages-md", at: DENSITY_NOW - 20_000 }, { from: "tool:grep", to: "file:docs-commands", at: DENSITY_NOW - 90_000 }] }
})()
const camera: OrbitCamera = { yaw: 0.6, pitch: 0.2, selected: 0, focused: true }
for (const width of [56, 32]) {
  write(`${phase}-galaxy-${width}`, () => {
    const inner = width - 2
    const details = orbitDetails({ graph: orbitGraph, camera, width: inner, now: DENSITY_NOW, rows: ORBIT_CARD_ROWS })
    return [
      ...renderOrbit(orbitGraph, inner, 18, camera).slice(-4),
      ...panelCard({ title: "Focus", value: "agent", body: details.focus, width }),
      ...panelCard({ title: "Recent", value: "2", body: details.recent, width }),
      ...panelCard({ title: "Top", value: "", body: details.top, width }),
    ]
  })
}

cleanTemps()
