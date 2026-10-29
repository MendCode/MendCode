import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { cleanTemps, plain } from "../apps/cli/test/session-ui-harness"
import { chat, click, frame, longSource, LONG_KINDS, settle, type LongKind } from "../apps/cli/test/file-viewer-helpers"
import { activeTheme, sgr, type Line, type Span } from "../apps/cli/src/ui/theme"
import { textWidth } from "../apps/cli/src/view/wrap"
import { sliceSpans } from "../apps/cli/src/view/file-viewer"

/**
 * The file viewer's frames: every one is a screen of the real wired app (appHarness: createApp, the real transcript, the real
 * daemon read behind `send`, the real renderer). Usage: `bun scripts/render-file-viewer-frames.ts [directory]`. Writes, for each scene,
 * `<name>.txt` and `<name>.ansi` (the dark theme) and `<name>.roles.txt`: the slot's rows with every span tagged by its theme role and
 * its attributes, the dark theme (`mend`) and then the light one (`paper`), with the color each role has in the theme. `PREVIEW.txt` is
 * the main frame.
 */
const target = process.argv[2] ?? path.join(import.meta.dir, "../.agents/runs/frames/file-viewer")
mkdirSync(target, { recursive: true })

type Ctx = Awaited<ReturnType<typeof chat>>
type Setup = NonNullable<Parameters<typeof chat>[0]>

const THEMES = [{ label: "dark", name: "mend" }, { label: "light", name: "paper" }] as const

function frameRows(h: Ctx["h"]) {
  const lines = h.frames.at(-1) ?? []
  return { text: lines.map(plain), ansi: lines.map((line) => line.map((span) => sgr(span, "truecolor") + span.text + "\x1b[0m").join("")) }
}

/** `fg=text bold` for a span: the role of the foreground and background, then the attributes. A span with no role takes the terminal's own colors. */
function tag(span: Span): string {
  const parts = [`fg=${span.fg ?? span.fgHex ?? "(terminal)"}`]
  if (span.bg || span.bgHex) parts.push(`bg=${span.bg ?? span.bgHex}`)
  for (const attribute of ["bold", "dim", "italic", "underline", "strike"] as const) if (span[attribute]) parts.push(attribute)
  if (span.link) parts.push("link")
  return parts.join(" ")
}

/** The slot's part of the last frame: from the column of the header's `‹` (or of the first row's left edge in a page) to the right. */
function slotLines(lines: Line[]): Line[] {
  const header = lines.find((line) => plain(line).includes("‹ "))
  if (!header) return lines
  const at = textWidth(plain(header).slice(0, plain(header).indexOf("‹ ")))
  return lines.map((line) => sliceSpans(line, at, Infinity))
}

function rolesOf(lines: Line[]): string[] {
  return slotLines(lines).map((line, row) => {
    const merged: Span[] = []
    for (const span of line) {
      const last = merged.at(-1)
      if (last && tag(last) === tag(span)) last.text += span.text
      else merged.push({ ...span })
    }
    // A run of padding is told by its length, so the row stays readable.
    const shown = (text: string) => JSON.stringify(text.replace(/ {4,}/g, (run) => `<${run.length} spaces>`))
    return `${String(row).padStart(2)}| ${merged.filter((span) => span.text !== "").map((span) => `[${tag(span)}] ${shown(span.text)}`).join(" ")}`
  })
}

function roleTable(): string[] {
  const colors = activeTheme().colors as Record<string, string>
  return Object.entries(colors).map(([role, hex]) => `  ${role.padEnd(12)} ${hex}`)
}

async function scene(name: string, setup: Setup, act: (ctx: Ctx) => Promise<void>) {
  const sections: string[] = []
  let main: Ctx | undefined
  for (const theme of THEMES) {
    const ctx = await chat({ ...setup, profile: { ...setup.profile, theme: theme.name } })
    await act(ctx)
    await settle()
    ctx.h.app.render()
    sections.push(`== ${theme.label} (${theme.name}) ==`, ...rolesOf(ctx.h.frames.at(-1) ?? []), "", `roles in ${theme.name}:`, ...roleTable(), "")
    if (theme.label === "dark") {
      main = ctx
      const rows = frameRows(ctx.h)
      writeFileSync(path.join(target, `${name}.txt`), rows.text.join("\n") + "\n")
      writeFileSync(path.join(target, `${name}.ansi`), rows.ansi.join("\n") + "\n")
      console.log(`${name}: ${frame(ctx.h).split("\n").length} rows`)
    }
  }
  writeFileSync(path.join(target, `${name}.roles.txt`), sections.join("\n") + "\n")
  return main!
}

const panel = { rightSidebar: true, sidebarWidgets: [{ type: "context", options: {} }] }

const main = await scene("160x45-cited-range", { width: 160, height: 45 }, async ({ h }) => { await click(h, "src/app.rs:120") })
await scene("120x35-cited-range", { width: 120, height: 35, text: "The range is in src/files/link.rs:56-79 now." }, async ({ h }) => { await click(h, "src/files/link.rs:56-79") })
// The owner's case: a Markdown file of prose in an 80-column slot of his terminal.
const eighty = { sidebarWidth: 80 } as const
await scene("md-80", { width: 200, height: 45, text: "Read worktrees.md first.", profile: eighty }, async ({ h }) => { await click(h, "worktrees.md") })
await scene("md-80-focused", { width: 200, height: 45, text: "Read worktrees.md first.", profile: { ...eighty, viewerFocus: true } }, async ({ h }) => { await click(h, "worktrees.md") })
await scene("md-80-nowrap", { width: 200, height: 45, text: "Read worktrees.md first.", profile: { ...eighty, viewerWrap: "off" } }, async ({ h }) => { await click(h, "worktrees.md") })
await scene("hints-mac", { width: 160, height: 45, platform: "darwin", profile: panel }, async ({ h }) => { await click(h, "src/app.rs:120") })
await scene("hints-mac-focused", { width: 160, height: 45, platform: "darwin", profile: panel }, async ({ h }) => { await click(h, "src/app.rs:120"); await h.app.onKey("\x1b}") })
await scene("hints-rebound", { width: 160, height: 45, profile: panel, keybindings: { "alt+}": null, "ctrl+g": "panel.focus" } }, async ({ h }) => { await click(h, "src/app.rs:120") })
await scene("panel-hints-mac", { width: 160, height: 45, platform: "darwin", profile: panel }, async () => {})
await scene("panel-before", { width: 160, height: 45, profile: panel }, async () => {})
await scene("panel-open", { width: 160, height: 45, profile: panel }, async ({ h }) => { await click(h, "src/app.rs:120") })
await scene("panel-closed", { width: 160, height: 45, profile: panel }, async ({ h }) => {
  await click(h, "src/app.rs:120")
  await h.app.onKey("\x1b}")
  await h.app.onKey("\x1b")
  await settle()
})
await scene("narrow-80x24", { width: 80, height: 24, text: "See src/app.rs:120 for the entry." }, async ({ h }) => { await click(h, "src/app.rs:120") })
await scene("binary", { width: 160, height: 45, text: "The logo is ./logo.png." }, async ({ h }) => { await click(h, "./logo.png") })
await scene("outside-refusal", { width: 160, height: 45, text: "Do not read /etc/hosts please." }, async ({ h }) => { await click(h, "/etc/hosts") })
await scene("git-marks", {
  width: 160, height: 45, text: "The change is at src/app.rs:12.",
  changes: (dir) => ({ root: dir, omittedFiles: 0, files: [{ path: "src/app.rs", status: "modified", additions: 2, deletions: 1, binary: false, truncated: false, diff: "@@ -10,3 +10,4 @@\n     pub fn new() -> Self {\n-        // old comment\n+        // Start with no documents and the default bindings.\n+        // second line\n         App { docs: HashMap::new(), keys: Binding::defaults() }" }] }),
}, async ({ h }) => { await click(h, "src/app.rs:12"); await settle(); h.app.render() })
await scene("minimalist-click-unchanged", { width: 160, height: 45, tier: "minimalist" }, async ({ h }) => { await click(h, "src/app.rs:120") })

// The Changes page, then a click on a file of its list: the file in the viewer at its first changed line.
const changed = (dir: string) => ({
  root: dir, omittedFiles: 0, branch: "main",
  files: [
    { path: "src/app.rs", status: "modified", additions: 2, deletions: 1, binary: false, truncated: false, diff: "@@ -118,5 +118,6 @@\n     }\n \n-    // old target\n+    fn target() { let key = \"value\"; }\n+    // second line\n     }" },
    { path: "DESIGN.md", status: "modified", additions: 1, deletions: 0, binary: false, truncated: false, diff: "@@ -10,2 +10,3 @@\n design 10\n+design added\n design 11" },
  ],
})
await scene("changes-page", { width: 160, height: 40, text: "nothing to see here", changes: changed }, async ({ h }) => { await h.type("/changes\r"); await settle() })
await scene("changes-file-opened", { width: 160, height: 40, text: "nothing to see here", changes: changed }, async ({ h }) => {
  await h.type("/changes\r")
  await settle()
  await click(h, "src/app.rs", 4)
})

// A folder: the listing, then one level down with `..` on top.
await scene("folder-listing", { width: 160, height: 45 }, async ({ h }) => { await h.type("/open src\r"); await settle() })
await scene("folder-nested", { width: 160, height: 45 }, async ({ h }) => { await h.type("/open src/files\r"); await settle() })

// A block comment, a triple-quoted string or a fence opened above the window: before the daemon lexed what is above it, and after.
for (const kind of Object.keys(LONG_KINDS) as LongKind[]) {
  const { file } = LONG_KINDS[kind]
  for (const stripLex of [true, false]) {
    await scene(`window-${kind}-${stripLex ? "before" : "after"}`, { width: 160, height: 45, stripLex }, async ({ h, dir }) => {
      writeFileSync(path.join(dir, file), longSource(kind))
      await h.type(`/open ${file}:3000\r`)
      await settle()
    })
  }
}

writeFileSync(path.join(target, "PREVIEW.txt"), frameRows(main.h).text.join("\n") + "\n")
cleanTemps()
