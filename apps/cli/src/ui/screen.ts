import { hostCellPixels, terminalPixels } from "./terminal-pixels"
import { createTerminalMode, MODE_SUBSCRIBE, MODE_UNSUBSCRIBE } from "./terminal-mode"
import { createTerminalFocus, FOCUS_SUBSCRIBE, FOCUS_UNSUBSCRIBE } from "./terminal-focus"
import { createKeyboardProtocol, translateKey } from "./keyboard-protocol"
import { createInlineRegion } from "./inline-region"
import type { CellPixels } from "../pets/frames"
import { cells, takeCells } from "../view/wrap"
import { createMemoryGovernor, framesPerCollection } from "./memory-governor"
import type { ImageLayer, ImagePlacement } from "./image-layer"
import { colorDepth, sgr, type Line } from "./theme"
import { HYPERLINK_CLOSE, hyperlinkOpen, hyperlinksAllowed, safeLink } from "./hyperlink"

/** A row as the escape string to write, plus how many cells it fills (≤ width; escapes and controls never pass). */
function encode(line: Line, width: number, depth: "truecolor" | "256", links = false) {
  let out = ""
  let used = 0
  for (const span of line) {
    const taken = takeCells(span.text, width - used)
    const text = taken.text
    used += taken.width
    if (!text) continue
    const style = sgr(span, depth)
    const body = style ? `${style}${text}\x1b[0m` : text
    const link = links ? safeLink(span.link) : undefined
    out += link ? `${hyperlinkOpen(link)}${body}${HYPERLINK_CLOSE}` : body
    if (used >= width) break
  }
  return { out, used }
}

/** Synchronized output (DEC mode 2026): the terminal shows the whole frame at once; terminals without it ignore it. */
const SYNC_START = "\x1b[?2026h"
const SYNC_END = "\x1b[?2026l"

/**
 * Differential terminal renderer (T10a decision B): keeps the previous frame and rewrites only rows
 * that changed. Draws only when asked; it owns no timers.
 */
export function createScreen(
  output: { write(data: string): unknown; columns?: number; rows?: number; isTTY?: boolean },
  env: Record<string, string | undefined> = process.env,
  options: { images?: ImageLayer; cellPixels?: CellPixels; inline?: boolean; mouse?: boolean; keyboard?: boolean; collectGarbage?: () => void; /** This process replaced one that left its frame on the alternate screen (`/restart`): the first frame paints over it instead of clearing. */ keepFrame?: boolean } = {},
) {
  // Frame-driven collection (memory-governor.ts); tests pass `collectGarbage` to watch the schedule.
  const governor = createMemoryGovernor({ every: framesPerCollection(env), ...(options.collectGarbage ? { collect: options.collectGarbage } : {}) })
  let previous: string[] = []
  let held: Line[] | undefined
  // Inline mode (--no-alt-screen): the chat lives in a region at the bottom of the normal screen and finished output
  // scrolls into the terminal's own scrollback. Pages and overlays borrow the alternate screen while they are open.
  const inline = options.inline === true
  let keepFrame = options.keepFrame === true && !inline
  const region = createInlineRegion()
  let alt = !inline
  let size = { width: output.columns ?? 80, height: output.rows ?? 24 }
  const geometry = terminalPixels({ size: () => size, write: (data) => output.write(data), tty: output.isTTY === true, host: hostCellPixels(env, options.cellPixels) })
  // Optional graphics layer, drawn above the text after the row diff.
  let images = inline ? undefined : options.images
  images?.setSize?.(size.width, size.height)
  // Kitty and Ghostty keep images when text is rewritten; MENDCODE_IMAGES_REPLACE=rows re-places an image whose rows changed, for unverified terminals.
  const replaceOnRows = env.MENDCODE_IMAGES_REPLACE === "rows"
  const noRows: ReadonlySet<number> = new Set()
  const depth = colorDepth(env)
  // OSC 8 hyperlinks on spans that carry a `link`; the app turns them off with the `hyperlinks` setting.
  const linksAllowed = hyperlinksAllowed(env)
  let links = linksAllowed
  // Button + SGR mouse reporting for wheel scroll. MENDCODE_MOUSE=0 keeps native click-drag selection
  // (most terminals still allow selecting with shift/option held while reporting is on).
  // Screen-reader mode passes `mouse: false`: reporting would swallow the terminal's own selection and cursor review.
  const mouse = options.mouse !== false && env.MENDCODE_MOUSE !== "0"
  const mouseOn = mouse ? "\x1b[?1003h\x1b[?1006h" : ""
  const mouseOff = mouse ? "\x1b[?1006l\x1b[?1003l" : ""

  // The window title (OSC 2): the shell's title is pushed on enter and popped on leave (xterm title stack).
  // MENDCODE_TERMINAL_TITLE=0 leaves it alone.
  const titles = env.MENDCODE_TERMINAL_TITLE !== "0"
  let title = ""
  let cursorShape: "default" | "bar" | "block" = "default"

  // The terminal's light/dark mode (the `system` theme): asked for on demand, never at start, so a prompt that
  // does not read it never receives the reply. MENDCODE_TERMINAL_MODE=0 never asks.
  const terminalMode = createTerminalMode(env)
  const modeAllowed = env.MENDCODE_TERMINAL_MODE !== "0" && output.isTTY === true
  let modeSubscribed = false

  // Window focus (DEC 1004), asked for while the screen is entered so notifications can wait for the user to look away.
  // MENDCODE_FOCUS_EVENTS=0 never asks; terminals that do not know the mode ignore it and the focus stays unknown.
  const focus = createTerminalFocus()
  const focusAllowed = env.MENDCODE_FOCUS_EVENTS !== "0" && output.isTTY === true
  const focusOn = focusAllowed ? FOCUS_SUBSCRIBE : ""
  const focusOff = focusAllowed ? FOCUS_UNSUBSCRIBE : ""

  // The kitty keyboard protocol (keyboard-protocol.ts): the caller decides (`keyboard`: a Mac, the setting on); MENDCODE_KEY_PROTOCOL=0 never asks.
  // The terminal is asked on entering and the flags are pushed only after it answers; leaving, suspending and the process exit pop them.
  const keyboard = createKeyboardProtocol({ write: (data) => output.write(data), enabled: options.keyboard === true && env.MENDCODE_KEY_PROTOCOL !== "0" && output.isTTY === true })
  let entered = false
  // After `leave` the terminal is someone else's (the shell, an editor) until `enter`: a frame asked for meanwhile (a timer, a late event
  // while the process finishes closing) must not reach it, or its text and images stay on the shell's screen.
  let left = false
  let altKeyboard = false

  return {
    get cellPixels() { return geometry.value },
    resolveCellPixels(host?: CellPixels) { return geometry.resolve(host) },
    consumeTerminalInput(data: string) { return terminalMode.consume(geometry.consume(focus.consume(keyboard.consume(data)))) },
    get keyboard() { return keyboard },
    /** One key as the sequence the app binds: with the keyboard protocol on, a `CSI u` key becomes `a`, `\r`, `\x03` or `\x1bq`; otherwise the key unchanged. */
    translateKey(seq: string, altBound?: (seq: string) => boolean) { return keyboard.translate(seq, altBound) },
    /** The same for raw input that is not split into keys (the crash screen reads single keys). */
    translateKeys(data: string) { return keyboard.active ? data.replace(/\x1b\[[\d:;]*u/g, (seq) => translateKey(seq)) : data },
    /** The setting changed: the protocol is popped, or asked for when the screen is entered. */
    setKeyboard(on: boolean) { keyboard.setEnabled(on && env.MENDCODE_KEY_PROTOCOL !== "0" && output.isTTY === true, entered) },
    /** The flags go back before the process ends by any path (the exit handler calls it; leaving the screen already did). */
    releaseKeyboard() {
      const pop = keyboard.release()
      if (pop) output.write(pop)
    },
    get terminalMode() { return terminalMode },
    get focus() { return focus },
    /** Asks the terminal for its mode and for later changes; the answers arrive through `consumeTerminalInput`. */
    requestTerminalMode() {
      if (!modeAllowed || modeSubscribed) return
      modeSubscribed = true
      output.write(MODE_SUBSCRIBE)
    },
    get size() {
      return size
    },
    get imageProtocol() {
      return images?.protocol ?? "off"
    },
    /** Switching protocols first overwrites old placements, then forces text to be restored next frame. */
    setImages(next?: ImageLayer) {
      const clear = images?.clearAll()
      if (clear) output.write(clear)
      images = inline ? undefined : next
      images?.setSize?.(size.width, size.height)
      previous = []
    },
    /** Turns OSC 8 links on or off (the `hyperlinks` setting); `MENDCODE_HYPERLINKS=0` keeps them off. The next draw repaints every row. */
    setHyperlinks(on: boolean) {
      const next = on && linksAllowed
      if (next === links) return
      links = next
      previous = []
    },
    /** True when the chat runs without the alternate screen (`--no-alt-screen`). */
    get inline() { return inline },
    /** Inline mode only: shows a page or an overlay on the alternate screen, or goes back to the inline region. */
    fullscreen(on: boolean) {
      if (!inline || on === alt || held) return
      alt = on
      previous = []
      // The alternate screen keeps its own flag stack: the keys of a page there use the protocol too, and the flags come off before it is left.
      const push = on ? keyboard.alternate(true) : ""
      const pop = !on && altKeyboard ? keyboard.alternate(false) : ""
      altKeyboard = push !== ""
      output.write(on ? `\x1b[?1049h${push}${mouseOn}\x1b[2J` : `${mouseOff}${pop}\x1b[?1049l`)
    },
    enter() {
      images?.invalidate()
      entered = true
      left = false
      if (inline) output.write(`${titles ? "\x1b[22;0t" : ""}\x1b[?25l\x1b[?2004h${focusOn}`)
      else output.write(`\x1b[?1049h${titles ? "\x1b[22;0t" : ""}\x1b[?25l\x1b[?2004h${focusOn}${mouseOn}${keepFrame ? "" : "\x1b[2J"}`)
      keepFrame = false
      keyboard.ask()
    },
    /**
     * `handOver`: the process is about to be replaced by one that enters again at once (`/restart`): the modes are
     * reset, but the alternate screen and its frame stay, so nothing flashes between the two.
     */
    leave(handOver = false) {
      entered = false
      left = true
      geometry.stop()
      const altPop = altKeyboard ? keyboard.alternate(false) : ""
      altKeyboard = false
      // Our images go before the alternate screen is left so none stays on the screen we return to.
      const closing = `\x1b[0m${cursorShape === "default" ? "" : "\x1b[0 q"}${keyboard.release()}${mouseOff}${modeSubscribed ? MODE_UNSUBSCRIBE : ""}${focusOff}\x1b[?2004l\x1b[?25h${titles && title ? "\x1b[23;0t" : ""}${images?.clearAll() ?? ""}`
      if (!inline) return void output.write(handOver ? `${closing}\x1b[?25l` : `${closing}\x1b[?1049l`)
      // The prompt and footer go; the history stays in the scrollback and the shell continues under it.
      if (alt) { alt = false; previous = []; output.write(`${mouseOff}${altPop}\x1b[?1049l`) }
      output.write(`${region.clear()}${closing}`)
    },
    /**
     * A message over the whole screen (the crash screen): the app's own frames are replaced by `rows` until `release`,
     * and an inline chat borrows the alternate screen for it. Cursor and images are hidden meanwhile.
     */
    hold(rows: Line[]) {
      if (!held && inline && !alt) {
        alt = true
        output.write(`\x1b[?1049h${mouseOn}\x1b[2J`)
      }
      held = rows
      previous = []
      this.draw(rows)
    },
    release() {
      if (!held) return
      held = undefined
      previous = []
      images?.invalidate()
    },
    get held() { return held !== undefined },
    /** The terminal cursor's shape (DECSCUSR), written only when it changes; vim mode uses a block outside insert mode. */
    setCursorShape(shape: "default" | "bar" | "block") {
      if (shape === cursorShape) return
      cursorShape = shape
      output.write(shape === "block" ? "\x1b[2 q" : shape === "bar" ? "\x1b[6 q" : "\x1b[0 q")
    },
    /** Sets the window title when it changed; control characters are dropped and it is capped at 80 cells. */
    setTitle(next: string) {
      if (!titles) return
      const clean = [...cells(next.replace(/[\x00-\x1f\x7f]/g, " "))].map((cell) => cell.text).join("").slice(0, 80)
      if (clean === title) return
      title = clean
      output.write(`\x1b]2;${clean}\x07`)
    },
    /** A control sequence outside the frame: the bell, or an OSC 52 clipboard write. It draws nothing, so the row diff stays valid. */
    write(data: string) {
      output.write(data)
    },
    /** Forgets what was drawn, so the next `draw` repaints every row (after another program used the terminal). */
    invalidate() {
      previous = []
      // Another program used the terminal: whatever the region held is gone, so it starts again where the cursor is.
      if (inline && !alt) region.clear()
      images?.invalidate()
    },
    resize(width: number, height: number) {
      size = { width, height }
      previous = []
      images?.setSize?.(width, height)
      images?.invalidate()
      // The terminal reflows the old rows in its own way: the region is erased where it was and drawn again.
      output.write(inline && !alt ? region.clear() : "\x1b[2J")
    },
    /**
     * Paints one frame. In inline mode `rows` is the live region (not a whole screen) and `finished` the lines that
     * became final since the last frame: they are written above the region once and never repainted.
     */
    draw(rows: Line[], cursor?: { row: number; col: number }, placements?: ImagePlacement[], finished: Line[] = []) {
      if (left) return
      if (held) {
        rows = held
        cursor = undefined
        placements = undefined
        finished = []
      }
      if (inline && !alt) {
        const done = finished.map((line) => `${encode(line, size.width, depth, links).out}`)
        const live = rows.slice(0, size.height).map((line) => {
          const encoded = encode(line, size.width, depth, links)
          return `${encoded.out}${encoded.used < size.width ? "\x1b[K" : ""}`
        })
        const out = `${done.length ? region.commit(done) : ""}${region.draw(live, cursor)}`
        output.write(`${SYNC_START}${out}${SYNC_END}`)
        governor.frame()
        return out.length
      }
      const changedRows = new Set<number>()
      const wanted = placements ?? []
      const repaint = images?.repaintRows?.(wanted) ?? noRows
      let out = ""
      for (let y = 0; y < size.height; y++) {
        // The bottom-right cell is never written: some terminals scroll the screen when it is filled.
        const width = y === size.height - 1 ? size.width - 1 : size.width
        const encoded = encode(rows[y] ?? [], width, depth, links)
        if (encoded.out !== previous[y] || repaint.has(y)) {
          // EL alone does not remove graphics in every terminal: overwrite the old image's cells, then restore text.
          if (repaint.has(y)) out += `\x1b[${y + 1};1H\x1b[0m${" ".repeat(width)}`
          // Erasing after a full row would hit the pending-wrap cell and delete the row's last character.
          out += `\x1b[${y + 1};1H${encoded.out}${encoded.used < width ? "\x1b[K" : ""}`
          previous[y] = encoded.out
          changedRows.add(y)
        }
      }
      // Uploads can be large: they go before the synchronized frame. Placements and deletions switch with the text, inside it.
      if (images) {
        const uploads = images.uploads(wanted)
        if (uploads) output.write(uploads)
        out += images.places(wanted, replaceOnRows || images.replaceOnRows ? changedRows : noRows)
      }
      out += cursor ? `\x1b[${cursor.row + 1};${cursor.col + 1}H\x1b[?25h` : "\x1b[?25l"
      output.write(`${SYNC_START}${out}${SYNC_END}`)
      governor.frame()
      return out.length
    },
  }
}
export type Screen = ReturnType<typeof createScreen>
