// Cell/style VT receiver for the sequences emitted by createScreen. Unlike stripping ANSI,
// this applies cursor moves and erases to a cell grid, including differential frames.
export function createPtyScreen(cols: number, rows: number) {
  let grid: string[][] = []
  let styles: string[][] = []
  let style = ""
  let x = 0
  let y = 0
  let pending = ""
  let frames = 0
  const unsupported = new Set<string>()
  const segmenter = new Intl.Segmenter()
  const clear = () => {
    grid = Array.from({ length: rows }, () => Array<string>(cols).fill(" "))
    styles = Array.from({ length: rows }, () => Array<string>(cols).fill(""))
    x = y = 0
  }
  clear()
  const newline = () => {
    y++
    if (y >= rows) {
      grid.shift()
      grid.push(Array<string>(cols).fill(" "))
      styles.shift()
      styles.push(Array<string>(cols).fill(""))
      y = rows - 1
    }
  }
  function csi(body: string, final: string) {
    const args = body.split(";").map((part) => Number(part) || 0)
    const n = args[0] || 1
    if (final === "H" || final === "f") {
      y = Math.min(rows - 1, n - 1)
      x = Math.min(cols - 1, (args[1] || 1) - 1)
    }
    else if (final === "J" && [2, 3].includes(args[0]!)) {
      const cursor = { x, y }
      clear()
      x = cursor.x
      y = cursor.y
    } else if (final === "K") {
      const start = args[0] === 1 || args[0] === 2 ? 0 : Math.min(x, cols - 1)
      const end = args[0] === 1 ? Math.min(x + 1, cols) : cols
      grid[y]!.fill(" ", start, end)
      styles[y]!.fill(style, start, end)
    } else if (final === "A") y = Math.max(0, y - n)
    else if (final === "B") y = Math.min(rows - 1, y + n)
    else if (final === "C") x = Math.min(cols - 1, x + n)
    else if (final === "D") x = Math.max(0, x - n)
    else if (final === "G") x = Math.min(cols - 1, n - 1)
    else if (final === "m") {
      if (!body || body === "0") style = ""
      else style += `\x1b[${body}m`
    }
    else if (final === "t" || final === "q") { /* title stack, cursor shape */ }
    // On a Mac the app asks for real key reports: the kitty keyboard query, device attributes, and the push/pop of the flags. This receiver never answers, which is a terminal that does not speak the protocol.
    else if ((final === "u" && (body === "?" || body.startsWith(">") || body === "<")) || (final === "c" && body === "")) { /* keyboard protocol and device attribute queries */ }
    else if ((final === "h" || final === "l") && body.startsWith("?")) {
      if (body === "?2026" && final === "l") frames++
      if (body === "?1049" && final === "h") clear()
    } else unsupported.add(`CSI ${body}${final}`)
  }
  function feed(text: string) {
    pending += text
    if (pending.length > 256 * 1024) throw new Error("unterminated terminal sequence exceeds capture limit")
    while (pending) {
      if (pending[0] === "\x1b") {
        if (pending.length < 2) return
        if (pending[1] === "[") {
          const match = /^\x1b\[([0-?]*[ -/]*)([@-~])/.exec(pending)
          if (!match) return
          csi(match[1]!, match[2]!)
          pending = pending.slice(match[0].length)
        } else if (pending[1] === "]" || pending[1] === "P" || pending[1] === "_") {
          const match = /^\x1b[\]P_][\s\S]*?(?:\x07|\x1b\\)/.exec(pending)
          if (!match) return
          pending = pending.slice(match[0].length)
        } else {
          unsupported.add(`ESC ${pending[1]}`)
          pending = pending.slice(2)
        }
        continue
      }
      const char = String.fromCodePoint(pending.codePointAt(0)!)
      pending = pending.slice(char.length)
      if (char === "\r") x = 0
      else if (char === "\n") newline()
      else if (char === "\b") x = Math.max(0, x - 1)
      else if (char >= " " && char !== "\x7f") {
        // Variation selectors, emoji modifiers and ZWJ tails may arrive in another PTY read.
        let previous = Math.min(x - 1, cols - 1)
        while (previous > 0 && grid[y]![previous] === "") previous--
        const prefix = previous >= 0 ? grid[y]![previous]! : ""
        if (char.codePointAt(0)! > 127 && prefix && [...segmenter.segment(prefix + char)].length === 1) {
          const joined = prefix + char
          const width = Bun.stringWidth(joined)
          grid[y]![previous] = joined
          for (let i = 1; i < width && previous + i < cols; i++) grid[y]![previous + i] = ""
          x = previous + width
          continue
        }
        const width = Bun.stringWidth(char)
        if (!width) {
          if (x > 0) grid[y]![Math.min(x - 1, cols - 1)] += char
          continue
        }
        if (x + width > cols) {
          x = 0
          newline()
        }
        grid[y]![x] = char
        styles[y]![x] = style
        for (let i = 1; i < width; i++) grid[y]![x + i] = ""
        x += width
      }
    }
  }
  return {
    feed,
    resize(width: number, height: number) {
      cols = width
      rows = height
      clear()
    },
    get frames() { return frames },
    get unsupported() { return [...unsupported] },
    text: () => grid.map((row) => row.join("")).join("\n") + "\n",
    // A full styled snapshot, independent of earlier differential updates.
    ansi: () => grid.map((row, y) => row.map((cell, x) => cell ? `\x1b[0m${styles[y]![x]}${cell}` : "").join("") + "\x1b[0m").join("\n") + "\n",
  }
}
