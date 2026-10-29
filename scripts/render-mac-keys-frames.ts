import { mkdirSync, writeFileSync } from "node:fs"
import path from "node:path"
import { appHarness, conversation, ids, plain, tempDir, type Harness } from "../apps/cli/test/session-ui-harness"
import { ANSWER, dragOver, key as press, scene, screen } from "../apps/cli/test/reply-comments-helpers"
import { DEFAULT_TUI_PROFILE, writeTuiProfile, type TuiProfile } from "../apps/cli/src/view/tui-profile"
import { textWidth } from "../apps/cli/src/view/wrap"
import { resetKeyLabels } from "../apps/cli/src/ui/key-labels"

/**
 * Real harness frames (80x24, plain text) of the key hints on a Mac and on Linux: the footer's queue hint, the slash menu's key
 * column, the shortcut overlay, the hint after a copy, the "Option is not Alt" toast and /terminal-setup. Usage:
 * `render-mac-keys-frames.ts <directory>`. Each surface is drawn once per platform (`macos`, `linux`), the platform injected into the
 * app, so the frames do not depend on the machine that draws them.
 */
const argument = process.argv[2]
if (!argument) throw new Error("usage: render-mac-keys-frames.ts <directory>")
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

function make(platform: string, profile: Partial<TuiProfile> = {}) {
  const dataDir = tempDir()
  writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, sidebar: "hidden", ...profile } as TuiProfile)
  const h = appHarness({ dataDir, directory: "/work/mend", width: WIDTH, height: HEIGHT, mode: "full", env: GHOSTTY, platform, now: () => TURN_AT + 60_000 })
  h.app.applySettings({ onboarded: true })
  return h
}

for (const [name, platform] of PLATFORMS) {
  // The queue panel above the prompt: "send now · drop last · alt+↑ edit" while a turn runs.
  {
    const h = make(platform)
    await Bun.sleep(10)
    const talk = conversation(h.sessionId, h.app.onEvent)
    talk.exchange("Build the firmware", "The build finished.")
    const turnId = ids("turn")
    h.app.onEvent({ type: "turn.started", sessionId: h.sessionId, seq: 900, at: TURN_AT, turnId, queueId: ids("queue") } as never)
    h.app.onEvent({ type: "foreground.state", sessionId: h.sessionId, seq: 901, at: TURN_AT + 500, state: "generating", turnId } as never)
    h.app.onEvent({ type: "queue.changed", sessionId: h.sessionId, seq: 902, at: TURN_AT + 3_000, queue: [{ queueId: ids("queue"), preview: "and then lint it", attachments: 0 }] } as never)
    save(`footer-queue-${name}`, rows(h))
  }
  // The slash menu's key column.
  {
    const h = make(platform)
    await h.type("/prompt-history")
    save(`slash-menu-${name}`, rows(h))
  }
  // The shortcut overlay (`?` on an empty prompt).
  {
    const h = make(platform)
    await h.type("?")
    save(`shortcut-overlay-${name}`, rows(h))
  }
  // The offer after a copy: the toast and the pill name the comment key.
  {
    const s = await scene({ width: WIDTH, height: HEIGHT }, { exchanges: [["How should I run the migration?", ANSWER]], directory: "/work/mend", harness: { platform, env: GHOSTTY } })
    await dragOver(s, "Use codex for both. Faster, but the plan is never reviewed.")
    save(`comment-hint-${name}`, screen(s.h))
    await press(s, "\x1bq")
    await Bun.sleep(5)
    save(`comment-compose-${name}`, screen(s.h))
  }
  // Option+Q arriving as œ: the one line, once. On Linux the same key says nothing.
  {
    const h = make(platform)
    await h.app.onKey("œ")
    await Bun.sleep(30)
    save(`option-not-alt-${name}`, rows(h))
  }
  // /terminal-setup: on a Mac it opens on Option as Alt, with the Ghostty line.
  {
    const h = make(platform)
    await h.type("/terminal-setup")
    await h.type("\r")
    await Bun.sleep(30)
    save(`terminal-setup-${name}`, rows(h))
    if (platform === "darwin") {
      await h.app.onKey("œ")
      save(`terminal-setup-key-check-${name}`, rows(h))
      await h.app.onKey("\t")
      save(`terminal-setup-newline-${name}`, rows(h))
    }
  }
  resetKeyLabels()
}
console.log(`frames in ${target}`)
// The apps keep their timers (toasts, the offer after a copy); the frames are written.
process.exit(0)
