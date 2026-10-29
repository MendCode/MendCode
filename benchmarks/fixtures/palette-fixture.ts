import { glyphs } from "../../apps/cli/src/ui/theme"
import { themeNames } from "../../apps/cli/src/ui/theme"
import { SLASH_COMMANDS } from "../../apps/cli/src/view/commands"
import { composeOverlay, renderPalette, type PaletteItem } from "../../apps/cli/src/view/palette"
import { homeScreen, print } from "./home-fixture"

/** usage: bun palette-fixture.ts <width> <height> [query] [selected] — the palette items as the app builds them, over the home page. */
const width = Number(process.argv[2] ?? 120)
const height = Number(process.argv[3] ?? 35)
const query = process.argv[4] ?? ""
const selected = Number(process.argv[5] ?? 0)

const items: PaletteItem[] = [
  ...SLASH_COMMANDS.map((c): PaletteItem => ({ id: `command:${c.name}`, kind: "command", title: c.name, hint: c.summary, keywords: c.aliases.join(" ") })),
  { id: "session:a", kind: "session", title: "Fix flaky reconnect in the daemon", hint: "open", keywords: "/Users/dev/Code/MendCodeV2" },
  ...themeNames().slice(0, 6).map((name): PaletteItem => ({ id: `theme:${name}`, kind: "theme", title: name, ...(name === "mend" ? { hint: "current" } : {}), keywords: "theme colors" })),
  ...["minimal", "balanced", "full"].map((m): PaletteItem => ({ id: `view:${m}`, kind: "view", title: m, ...(m === "balanced" ? { hint: "current" } : {}), keywords: "view mode" })),
  ...["ask before edits", "auto edits", "full access", "plan mode"].map((m): PaletteItem => ({ id: `permission:${m}`, kind: "permission", title: m, ...(m === "ask before edits" ? { hint: "current" } : {}), keywords: "permissions" })),
]

const overlay = renderPalette({ items, state: { query, selected }, width, height, glyphs: glyphs({}) })
print(composeOverlay(homeScreen({ width, height }, []), overlay, width))
