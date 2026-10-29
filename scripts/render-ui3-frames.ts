import { cpSync, mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { appHarness, conversation, tempDir } from "../apps/cli/test/session-ui-harness"
import { createScreen } from "../apps/cli/src/ui/screen"
import { writeTuiProfile, DEFAULT_TUI_PROFILE } from "../apps/cli/src/view/tui-profile"
import { fit } from "../apps/cli/src/view/deck"
import { textWidth } from "../apps/cli/src/view/wrap"
import { LOGO_FONTS, logoRowsFor } from "../apps/cli/src/view/logo-fonts"
import { writePetProbes } from "./pet-probes"

/** Invoked by render-frames.ts --ui-3; assets are read only, profiles/caches live in isolated temporary dirs. */
export async function renderUi3Frames(directory: string, sizes: string[]) {
  const sources = tempDir()
  const source = process.env.UI3_PET_ROOT ?? path.join(homedir(), ".codex/pets")
  cpSync(path.join(source, "greenie"), path.join(sources, "greenie"), { recursive: true })
  for (const size of sizes.length ? sizes : ["100x30", "180x50"]) {
    const match = /^(\d+)x(\d+)$/.exec(size)
    if (!match) throw new Error(`invalid size: ${size}`)
    const width = Number(match[1])
    const height = Number(match[2])
    for (const graphics of [false, true]) {
      const dataDir = tempDir()
      writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, pet: "mend", images: graphics ? "kitty" : "off" })
      const env = { COLORTERM: "truecolor", MENDCODE_MOUSE: "0" }
      const screen = createScreen({ columns: width, rows: height, write() {} }, env)
      const h = appHarness({ width, height, dataDir, screen, env, directory: "/work/mendcode", pets: { dirs: [{ dir: sources, source: "codex" }], cacheDir: path.join(dataDir, "cache"), images: graphics } })
      const save = (name: string) => {
        h.app.render()
        const frame = h.frames.at(-1)!
        if (frame.length !== height || frame.some((row) => textWidth(row.map((span) => span.text).join("")) > width)) throw new Error(`overflow: ${name} ${size}`)
        writeFileSync(path.join(directory, `${name}-${size}.txt`), frame.map((row) => fit(row, width).map((span) => span.text).join("")).join("\n") + "\n")
      }
      h.app.applySettings({ onboarded: true, reducedMotion: true })
      await h.app.imagesReady
      await h.type("/pet\r")
      await Bun.sleep(80)
      save(`pet-mend-${graphics ? "kitty" : "halfblock"}`)
      await h.app.onKey("\x1b[B")
      save(`pet-greenie-${graphics ? "kitty" : "halfblock"}`)
      await h.app.onKey("\r")
      await Bun.sleep(80)
      conversation(h.sessionId, h.app.onEvent).exchange("Keep the pet by the prompt", "Greenie follows the session state.\n\n" + Array.from({ length: 14 }, (_, i) => `- Checked frame ${i + 1}`).join("\n"))
      save(`chat-greenie-${graphics ? "kitty" : "halfblock"}`)
      await h.app.onKey("\x1b")
      await h.type("/pet\r")
      await h.app.onKey("\x1b[A")
      await h.app.onKey("\r")
      conversation(h.sessionId, h.app.onEvent).emit({ type: "foreground.state", state: "generating", turnId: h.sessionId })
      save(`chat-mend-${graphics ? "kitty" : "halfblock"}`)
      await h.type("/pet\r")
      await h.app.onKey("o")
      h.app.applySettings({ pet: "off" })
      await h.app.onKey("\x03")
    }
  }
  mkdirSync(directory, { recursive: true })
  writeFileSync(path.join(directory, "fonts.txt"), LOGO_FONTS.flatMap((font) => [font, ...["MENDCODE", "AGQRSWXZ", "0123456789"].flatMap((word) => [word, ...logoRowsFor(word, font), ""])]).join("\n") + "\n")
  await writePetProbes(directory, path.join(sources, "greenie"))
}
