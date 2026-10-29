/**
 * The live part of an inline (no alternate screen) terminal: a block of rows at the bottom of the normal screen that
 * is redrawn in place, with finished output written above it once so it lands in the terminal's own scrollback.
 *
 * Every method returns the escape string to write; the region addresses rows relative to its own top, so it never
 * needs the cursor's absolute position and works wherever the shell left the prompt.
 */
const up = (rows: number) => (rows > 0 ? `\x1b[${rows}A` : "")
const down = (rows: number) => (rows > 0 ? `\x1b[${rows}B` : "")

export function createInlineRegion() {
  /** The rows as last written (each already encoded, with its line erase when it needs one). */
  let previous: string[] = []
  /** The row the terminal cursor rests on, counted from the region's top. */
  let cursorRow = 0

  /** Takes the cursor to the region's first row, column 0. */
  const top = () => `${up(cursorRow)}\r`

  return {
    get height() {
      return previous.length
    },
    /** Erases the region and leaves the cursor on its first row, where the next output starts. */
    clear(): string {
      const out = `${top()}\x1b[J`
      previous = []
      cursorRow = 0
      return out
    },
    /** Finished lines: the region is erased, the lines are written once and scroll away; the next draw starts below them. */
    commit(lines: readonly string[]): string {
      let out = `${top()}\x1b[J`
      for (const line of lines) out += `${line}\r\n`
      previous = []
      cursorRow = 0
      return out
    },
    /** Rewrites only the rows that changed, growing or shrinking the region at its bottom; `cursor` is relative to the region. */
    draw(rows: readonly string[], cursor?: { row: number; col: number }): string {
      const count = rows.length
      const had = previous.length
      let out = top()
      let at = 0
      if (count > Math.max(1, had)) {
        // New rows open below the old last one; at the bottom of the screen that scrolls the region up, which keeps it whole.
        const last = Math.max(1, had) - 1
        out += down(last)
        out += "\r\n".repeat(count - Math.max(1, had))
        at = count - 1
      }
      const move = (row: number) => {
        out += row > at ? down(row - at) : up(at - row)
        at = row
      }
      for (let y = 0; y < count; y++) {
        if (rows[y] === previous[y]) continue
        move(y)
        out += `\r${rows[y]}`
      }
      if (count < had) {
        move(count)
        out += "\r\x1b[J"
      }
      const target = count === 0 ? 0 : Math.min(count - 1, Math.max(0, cursor?.row ?? count - 1))
      move(target)
      out += cursor ? `\x1b[${Math.max(0, cursor.col) + 1}G\x1b[?25h` : "\x1b[?25l"
      previous = [...rows]
      cursorRow = target
      return out
    },
  }
}
export type InlineRegion = ReturnType<typeof createInlineRegion>
