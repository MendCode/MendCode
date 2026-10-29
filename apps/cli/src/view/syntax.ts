/**
 * The terminal's syntax tokenizer. The implementation lives in the protocol package (`packages/protocol/src/syntax.ts`) because the
 * daemon lexes the lines above a file viewer's window with the same code; this module is where the terminal imports it from.
 */
export { highlight, isHighlighted, HIGHLIGHT_LANGUAGES, type HighlightState } from "@mendcode/protocol/wire"
