import { createApp } from "../ui/app"
import { activeTheme, setTheme, type Glyphs, type Line } from "../ui/theme"
import { keyLabelState, restoreKeyLabels } from "../ui/key-labels"
import type { Screen } from "../ui/screen"
import type { TuiProfile } from "../view/tui-profile"
import type { PresentationMode } from "../view/transcript"
import { createTutorialEngine, type TutorialEngine, type TutorialEngineOptions } from "./engine"

/**
 * The practice chat: the real terminal app (`createApp`) drawing into a rectangle of the tutorial page, wired to the
 * tutorial engine instead of a daemon. It is given no data directory, so it reads and writes no file of the user's (no
 * profile, drafts, stash, scratchpad or keybindings), and its `send` is the engine's: the only "sessions" it can see are
 * the engine's in-memory ones. Its profile and settings changes stay in its own memory. The global theme is put back on exit.
 */
export type SandboxOptions = {
  width: number
  height: number
  glyphs: Glyphs
  profile: TuiProfile
  mode: PresentationMode
  reducedMotion: boolean
  accessible: boolean
  now(): number
  /** Called on every frame the practice chat draws by itself (a streamed delta), so the page can repaint. */
  onFrame(): void
  /** The practice chat asked to quit (/exit, ctrl+c twice): the tour closes instead. */
  onExit(): void
  /** The user's tier and view, so the practice chat has the features and the look of their terminal. */
  settings?: Record<string, unknown>
  sleep?: TutorialEngineOptions["sleep"]
  schedule?: (fn: () => void) => void
  /** The user's effective key bindings: the practice chat answers to the same keys the hints name. */
  bindings?: import("../ui/keymap").Bindings
}

export type Sandbox = ReturnType<typeof createSandbox>

export function createSandbox(options: SandboxOptions) {
  const size = { width: options.width, height: options.height }
  let rows: Line[] = []
  let driving = false
  const restoreTheme = activeTheme().name
  const restoreLabels = keyLabelState()
  const engine: TutorialEngine = createTutorialEngine({ now: options.now, directory: "/practice/cart-demo", ...(options.settings ? { settings: options.settings } : {}), ...(options.sleep ? { sleep: options.sleep } : {}) })
  const screen = {
    size,
    draw: (frame: Line[]) => { rows = frame; if (!driving) options.onFrame() },
    write: () => undefined,
    setTitle: () => undefined,
  } as unknown as Screen
  const app = createApp({
    sessionId: engine.sessionId as never,
    screen,
    send: engine.send,
    subscribe: (sessionId, afterSeq) => engine.subscribe(sessionId, afterSeq),
    directory: "/practice/cart-demo",
    version: "practice",
    now: options.now,
    schedule: options.schedule ?? ((fn) => void setTimeout(fn, 16)),
    glyphs: options.glyphs,
    random: () => 0,
    mode: options.mode,
    profile: options.profile,
    ...(restoreLabels.platform ? { platform: restoreLabels.platform } : {}),
    reducedMotion: options.reducedMotion,
    accessible: options.accessible,
    env: { TERM: "xterm-256color" },
    ...(options.bindings ? { bindings: options.bindings } : {}),
    unsavedNote: "applied in practice only: nothing is saved",
    modelPrefs: { favorites: [], recents: ["tutorial-fast", "tutorial-deep"] },
    exit: options.onExit,
  })
  engine.attach((event) => app.onEvent(event))
  app.applySettings({ onboarded: true, ...options.settings } as never)
  let disposed = false
  return {
    app,
    engine,
    /** The practice chat's current frame at `width` x `height` (it re-renders when the rectangle changes). */
    rows(width: number, height: number): Line[] {
      if (disposed) return []
      size.width = Math.max(20, width)
      size.height = Math.max(5, height)
      driving = true
      try { app.render() } finally { driving = false }
      return rows
    },
    async key(key: string) { if (!disposed) await app.onKey(key) },
    get disposed() { return disposed },
    dispose() {
      if (disposed) return
      disposed = true
      engine.stop()
      setTheme(restoreTheme)
      restoreKeyLabels(restoreLabels)
    },
  }
}
