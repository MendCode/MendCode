import { appHarness, conversation, tempDir } from "./session-ui-harness"
import { DEFAULT_TUI_PROFILE, writeTuiProfile } from "../src/view/tui-profile"
import { ensureMermaid, onMermaidLoaded } from "../src/view/mermaid-lazy"
import { preload } from "../src/ui/lazy-pages"

export async function ui9Harness(source: string, width = 100, height = 30) {
  if (!ensureMermaid()) await new Promise<void>((resolve) => onMermaidLoaded(resolve))
  await preload("diagram")
  const dataDir = tempDir("mend-ui9-data-")
  const directory = tempDir("mend-ui9-project-")
  writeTuiProfile(dataDir, { ...DEFAULT_TUI_PROFILE, pet: "off", images: "off", sidebar: "hidden" })
  const h = appHarness({ dataDir, directory, width, height, version: "0.4.2" })
  h.app.applySettings({ onboarded: true, reducedMotion: true })
  conversation(h.sessionId, h.app.onEvent).exchange("Render the diagram", "```mermaid\n" + source + "\n```")
  await h.type("/diagram\r")
  return h
}

export async function closeUi9(h: Awaited<ReturnType<typeof ui9Harness>>) {
  await h.app.onKey("\x1b")
  await h.app.onKey("\x03")
  await h.app.onKey("\x03")
}
