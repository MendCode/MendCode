import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { appHarness, conversation, ids, plain, tempDir, type Harness } from "../apps/cli/test/session-ui-harness"
import { ANSWER, dragOver, key as press, scene, screen } from "../apps/cli/test/reply-comments-helpers"
import { DEFAULT_TUI_PROFILE, writeTuiProfile, type TuiProfile } from "../apps/cli/src/view/tui-profile"
import { textWidth } from "../apps/cli/src/view/wrap"
import { resetKeyLabels } from "../apps/cli/src/ui/key-labels"

/**
 * Real harness frames (80x24, plain text) of what the Option work changed, on a Mac and on Linux: the hints before and after a real Alt
 * key, the composed character running its binding, the ctrl+x chord hint, and `/terminal-setup` with its apply step (against a temporary
 * home, never the real one). Usage: `render-mac-option-frames.ts <directory>`. The platform is injected into the app, so the frames do not
 * depend on the machine that draws them.
 */
const argument = process.argv[2]
if (!argument) throw new Error("usage: render-mac-option-frames.ts <directory>")
const target: string = argument
mkdirSync(target, { recursive: true })

const PLATFORMS = [["macos", "darwin"], ["linux", "linux"]] as const
const GHOSTTY = { TERM_PROGRAM: "ghostty", TERM: "xterm-ghostty" }
const WIDTH = 80
const HEIGHT = 24
const TURN_AT = Date.UTC(2026, 9, 6, 12, 0, 0)

function save(name: string, lines: string[]) {
  if (lines.some((line) => textWidth(line) > WIDTH)) throw new Error(`overflow: ${name}`)
  writeFileSync(path.join(target, `${name}.txt`), `${lines.map((line) => line.trimEnd()).join("\n")}\n`)
}
const rows = (h: Harness) => (h.app.render(), h.frames.at(-1)!.map(plain))

function make(platform: string, extra: { terminalConfig?: { home: string }; profile?: Partial<TuiProfile> } = {}) {
  const dataDir = tempDir()
  writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, sidebar: "hidden", ...extra.profile } as TuiProfile)
  const h = appHarness({ dataDir, directory: "/work/mend", width: WIDTH, height: HEIGHT, mode: "full", env: GHOSTTY, platform, now: () => TURN_AT + 60_000, ...(extra.terminalConfig ? { terminalConfig: extra.terminalConfig } : {}) })
  h.app.applySettings({ onboarded: true })
  return h
}

async function queued(platform: string) {
  const h = make(platform)
  await Bun.sleep(10)
  const talk = conversation(h.sessionId, h.app.onEvent)
  talk.exchange("Build the firmware", "The build finished.")
  const turnId = ids("turn")
  h.app.onEvent({ type: "turn.started", sessionId: h.sessionId, seq: 900, at: TURN_AT, turnId, queueId: ids("queue") } as never)
  h.app.onEvent({ type: "foreground.state", sessionId: h.sessionId, seq: 901, at: TURN_AT + 500, state: "generating", turnId } as never)
  h.app.onEvent({ type: "queue.changed", sessionId: h.sessionId, seq: 902, at: TURN_AT + 3_000, queue: [{ queueId: ids("queue"), preview: "and then lint it", attachments: 0 }] } as never)
  return h
}

for (const [name, platform] of PLATFORMS) {
  // Hints with no proof yet that Option sends Alt: a Mac names the ctrl+x chord, Linux the Alt key.
  save(`footer-queue-${name}`, rows(await queued(platform)))
  {
    const h = make(platform)
    await h.type("/prompt-history")
    save(`slash-menu-${name}`, rows(h))
  }
  {
    const h = make(platform)
    await h.type("?")
    save(`shortcut-overlay-${name}`, rows(h))
  }
  // The hint after a copy, then the same screen after a real Alt key has arrived (the second changes only on a Mac).
  {
    const s = await scene({ width: WIDTH, height: HEIGHT }, { exchanges: [["How should I run the migration?", ANSWER]], directory: "/work/mend", harness: { platform, env: GHOSTTY } })
    await dragOver(s, "Use codex for both. Faster, but the plan is never reviewed.")
    save(`comment-hint-${name}`, screen(s.h))
    await press(s, "\x1bq")
    await Bun.sleep(5)
    save(`comment-compose-after-alt-${name}`, screen(s.h))
  }
  // The ctrl+x chord does what the Alt key does.
  {
    const s = await scene({ width: WIDTH, height: HEIGHT }, { exchanges: [["How should I run the migration?", ANSWER]], directory: "/work/mend", harness: { platform, env: GHOSTTY } })
    await dragOver(s, "Use codex for both. Faster, but the plan is never reviewed.")
    await press(s, "\x18")
    save(`chord-armed-${name}`, screen(s.h))
    await press(s, "w")
    await Bun.sleep(5)
    save(`chord-comment-${name}`, screen(s.h))
  }
  // The composed character: on a Mac the lone œ opens the comment; on Linux it is a letter and is typed.
  {
    const s = await scene({ width: WIDTH, height: HEIGHT }, { exchanges: [["How should I run the migration?", ANSWER]], directory: "/work/mend", harness: { platform, env: GHOSTTY } })
    await dragOver(s, "Use codex for both. Faster, but the plan is never reviewed.")
    await press(s, "œ")
    await Bun.sleep(30)
    save(`option-character-${name}`, screen(s.h))
  }
  // /terminal-setup with the apply step, against a temporary home.
  {
    const home = mkdtempSync(path.join(tmpdir(), "mend-frames-home-"))
    const h = make(platform, { terminalConfig: { home } })
    await h.type("/terminal-setup")
    await h.type("\r")
    await Bun.sleep(40)
    save(`terminal-setup-${name}`, rows(h))
    await h.type("a")
    save(`terminal-setup-confirm-${name}`, rows(h))
    await h.type("y")
    save(`terminal-setup-done-${name}`, rows(h))
    await h.type("a")
    save(`terminal-setup-present-${name}`, rows(h))
    rmSync(home, { recursive: true, force: true })
  }
  resetKeyLabels()
}
console.log(`frames in ${target}`)
// The apps keep their timers (toasts, the offer after a copy); the frames are written.
process.exit(0)
