import { mkdirSync, writeFileSync } from "node:fs"
import { appHarness, cleanTemps } from "../apps/cli/test/session-ui-harness"
import { activeTheme, setTheme, sgr } from "../apps/cli/src/ui/theme"

// Actual app frames with a scripted daemon reply; no network, reviews or live watches.
const directory = "task-evidence/command-output"
mkdirSync(directory, { recursive: true })
const watches = [
  { directory: "/work/alpha", state: "watching", role: "requested", open: 12, publish: "allowed" },
  { directory: "/work/beta", state: "paused", role: "all", open: 3, publish: "denied" },
  { directory: "/work/old", state: "ended (stopped)", role: "config", open: 0, publish: "not asked" },
]
try {
  for (const theme of ["mend", "paper"]) for (const [width, height] of [[80, 24], [100, 30], [200, 60]]) for (const mode of ["balanced", "minimal"] as const) {
    setTheme(theme)
    const h = appHarness({ width: width!, height: height!, mode, reply: (command) => command.type === "pr.review" ? { ok: true, result: { watches, text: "All repository watches are listed.\nThis device runs at most 2 reviews at once." } } : undefined })
    await h.type("/pr repos\r")
    const name = `${directory}/${theme}-${mode}-${width}x${height}`
    writeFileSync(`${name}.txt`, h.text().join("\n") + "\n")
    const background = sgr({ text: "", bgHex: activeTheme().background }, "truecolor")
    writeFileSync(`${name}.ansi`, background + h.frames.at(-1)!.map((row) => row.map((span) => sgr(span, "truecolor") + span.text + "\x1b[0m" + background).join("")).join("\n") + "\x1b[0m\n")
  }
} finally { cleanTemps() }
