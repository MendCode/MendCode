import { describe, expect, test } from "bun:test"
import { createKeyTokenizer, OSC_HOLD_MAX, tokenizeKeys, type KeyToken } from "../src/ui/keys"

describe("tokenizeKeys", () => {
  test("typed-ahead text followed by enter becomes text plus a submit key", () => {
    expect(tokenizeKeys("fix it\r")).toEqual([{ type: "key", seq: "fix it" }, { type: "key", seq: "\r" }])
  })
  test("escape sequences, alt+enter and a trailing lone escape are separate keys", () => {
    expect(tokenizeKeys("\x1b[Bab\x1b\r\x1b[3~\x1b").map((t) => (t.type === "key" ? t.seq : t.text))).toEqual(["\x1b[B", "ab", "\x1b\r", "\x1b[3~", "\x1b"])
  })
  test("a bracketed paste keeps its newlines as text and never submits", () => {
    expect(tokenizeKeys("\x1b[200~line 1\rline 2\x1b[201~\r")).toEqual([{ type: "paste", text: "line 1\rline 2" }, { type: "key", seq: "\r" }])
  })
  test("an unterminated paste consumes the rest of the chunk", () => {
    expect(tokenizeKeys("\x1b[200~abc")).toEqual([{ type: "paste", text: "abc" }])
  })
  test("multi-byte characters stay inside the text run", () => {
    expect(tokenizeKeys("ñandú ✓\x7f")).toEqual([{ type: "key", seq: "ñandú ✓" }, { type: "key", seq: "\x7f" }])
  })
})

describe("OSC replies and ctrl+g", () => {
  const seqs = (tokens: KeyToken[]) => tokens.map((token) => (token.type === "key" ? token.seq : `paste:${token.text}`))
  const COLOUR = "\x1b]11;rgb:1e1e/1e1e/2e2e"
  const CLIPBOARD = "\x1b]52;c;aGVsbG8="

  test("a BEL alone is the ctrl+g key, wherever it is typed", () => {
    expect(seqs(tokenizeKeys("\x07"))).toEqual(["\x07"])
    expect(seqs(tokenizeKeys("ab\x07cd\x07"))).toEqual(["ab", "\x07", "cd", "\x07"])
  })

  test("a whole reply is dropped with its terminator, BEL or Esc \\, and the keys around it stay", () => {
    expect(seqs(tokenizeKeys(`${COLOUR}\x07`))).toEqual([])
    expect(seqs(tokenizeKeys(`${COLOUR}\x1b\\`))).toEqual([])
    expect(seqs(tokenizeKeys(`a${CLIPBOARD}\x07b\r`))).toEqual(["a", "b", "\r"])
    expect(seqs(tokenizeKeys(`${COLOUR}\x07\x07`))).toEqual(["\x07"])
    expect(seqs(tokenizeKeys(`\x07${COLOUR}\x07\x1b[A`))).toEqual(["\x07", "\x1b[A"])
  })

  test("a reply split across reads followed by nothing gives no key", () => {
    for (let cut = 3; cut < COLOUR.length + 1; cut++) {
      const tokenize = createKeyTokenizer()
      const whole = `${COLOUR}\x07`
      expect(seqs(tokenize(whole.slice(0, cut)))).toEqual([])
      expect(seqs(tokenize(whole.slice(cut)))).toEqual([])
      // Nothing is left over: the next key is itself.
      expect(seqs(tokenize("x"))).toEqual(["x"])
    }
  })

  test("a mouse report or modified arrow cut by a read is one key when its end arrives", () => {
    const click = "\x1b[<0;10;5M"
    for (let cut = 3; cut < click.length; cut++) {
      const tokenize = createKeyTokenizer()
      expect(seqs(tokenize(click.slice(0, cut)))).toEqual([])
      expect(seqs(tokenize(click.slice(cut)))).toEqual([click])
    }
    const arrow = createKeyTokenizer()
    expect(seqs(arrow("\x1b[1;"))).toEqual([])
    expect(seqs(arrow("5Ax"))).toEqual(["\x1b[1;5A", "x"])
  })

  test("a reply split across reads followed by a real ctrl+g gives that one key", () => {
    for (let cut = 3; cut < COLOUR.length + 1; cut++) {
      const tokenize = createKeyTokenizer()
      const whole = `${COLOUR}\x07`
      expect(seqs(tokenize(whole.slice(0, cut)))).toEqual([])
      expect(seqs(tokenize(`${whole.slice(cut)}\x07`))).toEqual(["\x07"])
    }
    const later = createKeyTokenizer()
    later(COLOUR)
    later("\x07")
    expect(seqs(later("\x07"))).toEqual(["\x07"])
  })

  test("a reply split in three, and one whose Esc \\ is split, are still dropped", () => {
    const three = createKeyTokenizer()
    expect(seqs(three("\x1b]5"))).toEqual([])
    expect(seqs(three("2;c;aGVs"))).toEqual([])
    expect(seqs(three("bG8=\x07\x07"))).toEqual(["\x07"])
    const st = createKeyTokenizer()
    expect(seqs(st(`${COLOUR}\x1b`))).toEqual([])
    expect(seqs(st("\\\x07"))).toEqual(["\x07"])
  })

  test("a read that ends on Esc or Esc ] is a key at once; the rest of a reply that follows is dropped whole", () => {
    const afterEsc = createKeyTokenizer()
    expect(seqs(afterEsc("\x1b"))).toEqual(["\x1b"])
    expect(seqs(afterEsc(`${COLOUR.slice(1)}\x07`))).toEqual([])
    const afterBracket = createKeyTokenizer()
    expect(seqs(afterBracket("\x1b]"))).toEqual(["\x1b]"])
    expect(seqs(afterBracket(`${COLOUR.slice(2)}\x07\x07`))).toEqual(["\x07"])
  })

  test("alt+] stays a key, and so does text after it: only a number and a semicolon start a reply", () => {
    expect(seqs(tokenizeKeys("\x1b]"))).toEqual(["\x1b]"])
    expect(seqs(tokenizeKeys("\x1b]hello\x07"))).toEqual(["\x1b]", "hello", "\x07"])
    const typed = createKeyTokenizer()
    expect(seqs(typed("\x1b]"))).toEqual(["\x1b]"])
    expect(seqs(typed("12"))).toEqual(["12"])
    expect(seqs(typed("\x07"))).toEqual(["\x07"])
    // A number right after alt+] in one read waits one read to see whether it is a reply; it is typed when it is not.
    const ahead = createKeyTokenizer()
    expect(seqs(ahead("\x1b]1"))).toEqual([])
    expect(seqs(ahead("x"))).toEqual(["\x1b]", "1x"])
  })

  test("an Esc that is not Esc \\ ends a reply and starts the next key; a paste after a reply is whole", () => {
    expect(seqs(tokenizeKeys(`${COLOUR}\x1b[A`))).toEqual(["\x1b[A"])
    const tokenize = createKeyTokenizer()
    expect(seqs(tokenize(`${COLOUR}\x1b[200~pas`))).toEqual([])
    expect(seqs(tokenize("ted\x1b[201~\x07"))).toEqual(["paste:pasted", "\x07"])
  })

  test("what never ends is not held for ever: past the limit its bytes are keys again", () => {
    const tokenize = createKeyTokenizer()
    expect(seqs(tokenize(`${COLOUR}${"f".repeat(OSC_HOLD_MAX)}`))[0]).toBe("\x1b]")
    expect(seqs(tokenize("x"))).toEqual(["x"])
  })
})
