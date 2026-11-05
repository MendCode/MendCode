import { foldLetter } from "../caps-lock"
import type { AppContext } from "./context"

type State = AppContext["state"]
/** `keep`: capitals that are a shortcut of their own on the page (shift+letter) and are never folded. `typing`: true while a text field of the page has the keyboard. */
type CapsRule = { keep?: string; typing?: (state: State) => boolean }

/**
 * Pages whose shortcuts are single letters, audited one by one: where their handlers keep a capital for something else (`G` jumps to the
 * end, `J`/`K` move a queued message) it is listed in `keep`; where a text field can open (a filter, a form, an edit) `typing` says when,
 * and then the raw key goes through. A page that is not here (chat, sessions, memory, skills, theme, setup, customize, connect, console,
 * worktrees, mflow, changes, reviews, memory-assistant, prompt-mode, agent-commands, keymap) either is a text field or keeps capitals in
 * ways that are not tied to one mode, and reads the key as typed.
 */
export const CAPS_PAGES: Readonly<Record<string, CapsRule>> = {
  tools: {}, mcps: {}, context: {}, storage: {}, agent: {}, secrets: {}, extensions: {}, status: {}, hooks: {}, providers: {}, packages: {}, pet: {}, model: {},
  agents: {}, workflows: {}, tasks: {}, help: {}, diagnostics: {}, compound: {}, "ai-config": {}, "release-channel": {}, tsm: {}, ide: {}, tree: {},
  text: { keep: "G" }, permissions: { keep: "R" }, messages: { keep: "Q" }, export: { keep: "Q" },
  history: { keep: "G", typing: (state) => state.historyState.editing },
  queue: { keep: "JK", typing: (state) => state.queueState?.edit !== undefined },
  usage: { typing: (state) => state.usageState.weatherInput !== undefined },
  env: { typing: (state) => state.environmentPage?.edit !== undefined || state.environmentPage?.import !== undefined },
  loops: { typing: (state) => state.loopsState.form !== undefined },
  acp: { typing: (state) => state.acpState.form !== undefined },
  whatsnew: { keep: "G", typing: (state) => state.whatsNew?.search.open === true },
}

/** Caps Lock makes `q` arrive as `Q`, in the legacy encoding and in kitty's text field alike, so a capital is not told from shift+letter: on a listed page it reads as the letter, except where the page gives the capital a meaning. */
export function foldForPage(state: State, key: string): string {
  const rule = CAPS_PAGES[state.page]
  if (!rule || key.length !== 1 || rule.keep?.includes(key) || rule.typing?.(state)) return key
  return foldLetter(key)
}
