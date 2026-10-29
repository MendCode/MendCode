import { detectTerminal, optionNotice, preload } from "../lazy-pages"
import { configureKeyLabels, isMac, keyLabelState } from "../key-labels"
import { keyName } from "../keymap"
import { OPTION_BINDINGS, showsAltWorks, optionBindingFor, type OptionBindingKey } from "../../view/option-keys"
import { liveAttachments } from "../../view/attachments"
import type { AppContext } from "./context"

/**
 * On a Mac whose terminal types the character Option makes (`œ` for Option+Q), a lone character that is Option+key of a default alt
 * binding runs that binding, where the binding means something, instead of being typed (view/option-keys.ts has the characters per layout).
 *
 * The rule is narrow, because these characters are also letters and symbols people type:
 * - macOS only (the app's `platform`) and the `optionKeys` setting `auto`;
 * - the key is exactly one character, alone in one read: a paste (bracketed or not), a word and a burst of typing never match, a key
 *   pressed on its own does, which is the false positive left (the first letter of "œuvre" on a French keyboard, typed into an empty prompt);
 * - it is the character the active keyboard layout types for that key (the layout is read from the Mac when the character arrives; one
 *   the table does not know changes nothing) and the keymap still binds it;
 * - the binding is live in this exact context: comment on the selection while a selection is kept or the offer after a copy is open, the
 *   comment list only with comments to list, the rest only into an empty prompt, never inside text already typed or a comment being written;
 * - no key has ever arrived as an Alt combination in this session (then Option works, and the character was typed on purpose).
 * The first time one runs, a one-line toast says what happened and how to make Option a real Alt.
 */
export function createOptionKeys(ctx: AppContext) {
  const { state, input, editor } = ctx
  let shown = false
  let optionIsAlt = false

  /** Option is known to send Alt (a real Alt key arrived, or the terminal reports keys for real): the hints name the Alt keys, and the characters are text again. */
  function altSeen() {
    optionIsAlt = true
    if (keyLabelState().altWorks) return
    configureKeyLabels({ altWorks: true })
    ctx.requestFrame()
  }
  input.screen.keyboard?.subscribe((active) => active && altSeen())
  if (input.screen.keyboard?.active) altSeen()

  const afterSelection = () => state.selection?.moved === true || ctx.comments.offering()
  const emptyPrompt = () => editor.isEmpty() && liveAttachments(state.attachments, editor.text).length === 0 && !state.shellMode

  /** Where each binding is live. The tutorial's rail keys are the tour's own, so there the page decides. */
  const live: Record<OptionBindingKey, () => boolean> = {
    q: () => afterSelection() || emptyPrompt(),
    l: () => ctx.comments.hasActive() && (afterSelection() || emptyPrompt()),
    r: emptyPrompt, p: emptyPrompt, ",": emptyPrompt, ".": emptyPrompt,
    "}": () => state.tuiProfile.rightSidebar && emptyPrompt(),
    b: () => false, s: () => false, m: () => false,
  }
  const bound = (key: OptionBindingKey) => state.bindings.direct.has(OPTION_BINDINGS[key]) || key === "}"

  /**
   * Looks at one key before the app acts on it and returns the key to act on: the binding's own sequence when `key` is the character
   * Option typed for it, otherwise `key`. `plain` is true when the key would be typed into the prompt as usual.
   */
  function rewrite(key: string, plain: boolean): string {
    if (!optionIsAlt && showsAltWorks(key)) altSeen()
    if (optionIsAlt || state.tuiProfile.optionKeys === "off" || !isMac(input.platform) || [...key].length !== 1) return key
    const tutorial = state.page === "tutorial"
    if (!tutorial && (!plain || ctx.comments.composing() || ctx.comments.store.listing)) return key
    const binding = optionBindingFor(key, input.keyboardLayout?.())
    if (binding === undefined) return key
    if (tutorial ? !"qbsm".includes(binding) : !(bound(binding) && live[binding]())) return key
    if (!shown && !tutorial) {
      shown = true
      void preload("terminal-setup").then(() => {
        const { message, hint } = optionNotice({ kind: detectTerminal(ctx.env).kind, char: key, key: keyName(OPTION_BINDINGS[binding]) ?? binding })
        ctx.say(message, "info", { hint, ms: 6_000 })
      })
    }
    return OPTION_BINDINGS[binding]
  }

  return { rewrite }
}

export type OptionKeys = ReturnType<typeof createOptionKeys>
