/**
 * A tiny terminal emulator for the escape sequences MendCode writes: printing, CR/LF with scrolling into a scrollback,
 * cursor moves (CUU CUD CUF CUB CHA CUP), erases (EL ED), the alternate screen (1049) and mode switches (ignored).
 * It lets a test read what a user would see, scrollback included.
 */
export function createVt(width: number, height: number) {
  type Buffer = { rows: string[][]; row: number; col: number }
  const emptyRow = () => Array.from({ length: width }, () => " ")
  const blank = () => Array.from({ length: height }, emptyRow)
  let main: Buffer = { rows: blank(), row: 0, col: 0 }
  let saved: Buffer | undefined
  let current = main
  const scrollback: string[] = []
  let pendingWrap = false

  function lineDown() {
    pendingWrap = false
    if (current.row < height - 1) return void current.row++
    const top = current.rows.shift()!
    if (current === main) scrollback.push(top.join("").trimEnd())
    current.rows.push(emptyRow())
  }

  function put(char: string) {
    if (pendingWrap) { current.col = 0; lineDown() }
    current.rows[current.row]![current.col] = char
    if (current.col === width - 1) pendingWrap = true
    else current.col++
  }

  function csi(params: string, final: string) {
    const n = Number.parseInt(params, 10)
    const count = Number.isFinite(n) ? n : 1
    pendingWrap = false
    if (final === "A") current.row = Math.max(0, current.row - count)
    else if (final === "B") current.row = Math.min(height - 1, current.row + count)
    else if (final === "C") current.col = Math.min(width - 1, current.col + count)
    else if (final === "D") current.col = Math.max(0, current.col - count)
    else if (final === "G") current.col = Math.min(width - 1, Math.max(0, count - 1))
    else if (final === "H") {
      const [r, c] = params.split(";").map((part) => Number.parseInt(part, 10))
      current.row = Math.min(height - 1, Math.max(0, (Number.isFinite(r) ? r! : 1) - 1))
      current.col = Math.min(width - 1, Math.max(0, (Number.isFinite(c) ? c! : 1) - 1))
    } else if (final === "K") for (let c = current.col; c < width; c++) current.rows[current.row]![c] = " "
    else if (final === "J") {
      if (params === "2") current.rows = blank()
      else {
        for (let c = current.col; c < width; c++) current.rows[current.row]![c] = " "
        for (let r = current.row + 1; r < height; r++) current.rows[r] = emptyRow()
      }
    } else if ((final === "h" || final === "l") && params === "?1049") {
      if (final === "h") { saved = main; current = { rows: blank(), row: 0, col: 0 } }
      else if (saved) { main = saved; current = main; saved = undefined }
    }
  }

  return {
    write(data: string) {
      for (let i = 0; i < data.length; i++) {
        const char = data[i]!
        if (char === "\x1b") {
          if (data[i + 1] === "[") {
            let j = i + 2
            while (j < data.length && !(data.charCodeAt(j) >= 0x40 && data.charCodeAt(j) <= 0x7e)) j++
            if (j < data.length) csi(data.slice(i + 2, j), data[j]!)
            i = j
          } else if (data[i + 1] === "]") {
            const end = data.indexOf("\x07", i)
            i = end < 0 ? data.length : end
          } else i++
        } else if (char === "\r") { current.col = 0; pendingWrap = false }
        else if (char === "\n") lineDown()
        else put(char)
      }
    },
    /** What is on the visible screen. */
    screen: () => current.rows.map((row) => row.join("").trimEnd()),
    /** Everything the main buffer holds, oldest first: the scrollback and then its screen (blank rows at the end dropped). */
    history() {
      const rows = [...scrollback, ...main.rows.map((row) => row.join("").trimEnd())]
      while (rows.length && !rows.at(-1)) rows.pop()
      return rows
    },
    get alternate() { return current !== main },
    get cursor() { return { row: current.row, col: current.col } },
  }
}
