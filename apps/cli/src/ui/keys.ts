export type KeyToken = { type: "key"; seq: string } | { type: "paste"; text: string }

const PASTE_START = "\x1b[200~"
const PASTE_END = "\x1b[201~"

/**
 * An OSC reply of the terminal (a colour, the clipboard): `Esc ]`, its number and `;`, then text up to BEL or `Esc \`. It is never
 * input: the BEL that ends it is the byte ctrl+g sends, and it must not run that key. `Esc ]` with no number is alt+], a key.
 */
const OSC_START = /^\x1b\]\d{1,4};/
/** The start of a reply cut by the read before its `;`. */
const OSC_START_CUT = /^\x1b\]\d{1,4}$/
/** A whole reply. */
const OSC_REPLY = /^\x1b\]\d{1,4};[^\x07\x1b]*(?:\x07|\x1b\\)/
/** A reply that has not ended is held this long; a longer one was not a reply and its bytes are keys again. */
export const OSC_HOLD_MAX = 4_096
/** An unfinished CSI is held only this long (a mouse report is about 16 bytes); longer, its bytes are keys. */
const CSI_HOLD_MAX = 64
const CSI_PARAMETER = /^[\x30-\x3f]$/

/** Stdin reads are not paste boundaries. Keep both delimiters and their payload together, and an OSC reply cut by a read. */
export function createKeyTokenizer() {
  let pending = ""
  /** `Esc` or `Esc ]` when the last read ended on it: it went out as a key, and the next read may show it began a reply. */
  let tail = ""
  return (chunk: string): KeyToken[] => {
    // A reply cut right after its first one or two bytes: they were a key already (a lone Esc is never held back), the rest is dropped whole.
    const rejoined = pending === "" && tail !== "" && OSC_REPLY.test(tail + chunk)
    const data = rejoined ? tail + chunk : pending + chunk
    pending = ""
    tail = ""
    let cut = data.length
    let at = 0
    while (at < data.length) {
      const start = data.indexOf(PASTE_START, at)
      if (start < 0) break
      const end = data.indexOf(PASTE_END, start + PASTE_START.length)
      if (end < 0) { cut = start; break }
      at = end + PASTE_END.length
    }
    if (cut === data.length) {
      // A lone Escape remains a key; CSI paste prefixes can span reads.
      for (let n = PASTE_START.length - 1; n >= 2; n--) {
        if (data.endsWith(PASTE_START.slice(0, n))) { cut = data.length - n; break }
      }
    }
    // An unfinished reply waits for its end unless what follows is already known (a paste start is an Esc, which ends it).
    const head = data.slice(0, cut)
    const { tokens, held } = scanKeys(head, cut === data.length)
    pending = head.slice(held) + data.slice(cut)
    const last = tokens.at(-1)
    if (pending === "" && last?.type === "key" && (last.seq === "\x1b" || last.seq === "\x1b]") && data.endsWith(last.seq)) tail = last.seq
    return tokens
  }
}

function isPrintable(char: string) {
  return char >= " " && char !== "\x7f"
}

/**
 * Splits one raw stdin chunk into keys. Terminals deliver typed-ahead input, escape sequences and
 * pastes in a single read, so "hello\r" must become the text "hello" plus a submit, and a bracketed
 * paste stays literal text (its newlines never submit). An OSC reply is dropped, its terminator included.
 */
export function tokenizeKeys(data: string): KeyToken[] {
  return scanKeys(data, false).tokens
}

/**
 * The keys of `data`, and where an OSC reply that has not ended begins (`data.length` when there is none). With `hold` the caller keeps
 * that part for the next read; without it the unfinished reply is dropped.
 */
function scanKeys(data: string, hold: boolean): { tokens: KeyToken[]; held: number } {
  const tokens: KeyToken[] = []
  let i = 0
  while (i < data.length) {
    if (data.startsWith("\x1b]", i)) {
      const reply = OSC_START.test(data.slice(i, i + 7))
      const short = data.length - i <= OSC_HOLD_MAX
      if (hold && short && !reply && OSC_START_CUT.test(data.slice(i))) return { tokens, held: i }
      if (reply) {
        let end = i + 2
        while (end < data.length && data[end] !== "\x07" && data[end] !== "\x1b") end++
        // An Esc that is not `Esc \` ends the reply too (ECMA-48) and starts the next key; the last byte of a read may still become `Esc \`.
        const open = end === data.length || (data[end] === "\x1b" && end + 1 === data.length)
        if (open && hold && short) return { tokens, held: i }
        if (!open || !hold) {
          i = open ? data.length : data[end] === "\x07" ? end + 1 : data[end + 1] === "\\" ? end + 2 : end
          continue
        }
      }
    }
    if (data.startsWith(PASTE_START, i)) {
      const end = data.indexOf(PASTE_END, i + PASTE_START.length)
      const stop = end < 0 ? data.length : end
      tokens.push({ type: "paste", text: data.slice(i + PASTE_START.length, stop) })
      i = end < 0 ? data.length : end + PASTE_END.length
      continue
    }
    const char = data[i]!
    if (char === "\x1b") {
      const next = data[i + 1]
      if (next === "[" || next === "O") {
        let j = i + 2
        while (j < data.length && !(data.charCodeAt(j) >= 0x40 && data.charCodeAt(j) <= 0x7e)) j++
        // A CSI the read cut after its parameters (`Esc [<0;` of a click, `Esc [1;` of a modified arrow) waits for the rest;
        // `Esc [` alone is alt+[ and goes at once.
        if (hold && j === data.length && next === "[" && j - i > 2 && j - i <= CSI_HOLD_MAX && CSI_PARAMETER.test(data[i + 2]!)) return { tokens, held: i }
        tokens.push({ type: "key", seq: data.slice(i, j + 1) })
        i = j + 1
      } else if (next !== undefined) {
        tokens.push({ type: "key", seq: data.slice(i, i + 2) })
        i += 2
      } else {
        tokens.push({ type: "key", seq: char })
        i++
      }
      continue
    }
    if (!isPrintable(char)) {
      tokens.push({ type: "key", seq: char })
      i++
      continue
    }
    let j = i
    while (j < data.length && isPrintable(data[j]!)) j++
    tokens.push({ type: "key", seq: data.slice(i, j) })
    i = j
  }
  return { tokens, held: data.length }
}
