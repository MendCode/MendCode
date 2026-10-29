import type { AppContext } from "./context"

/**
 * Copies the code block, table, list, quote or diagram nearest the middle of the transcript on screen (`ctrl+x Y`): the
 * same text its header's `copy` button puts on the clipboard. Says so when no block with a button is in view.
 */
export function createBlockCopy(ctx: AppContext, actions: { chatWidth: () => number }) {
  const { state, view, say, copyText } = ctx

  function copyFocused(): boolean {
    const rows = state.transcript.viewport(actions.chatWidth(), state.lastBodyHeight, view.get(state.sessionId).offset)
    const middle = (rows.length - 1) / 2
    let target: { at: number; text: string; label: string } | undefined
    rows.forEach((row, at) => {
      const button = row.copy?.[row.copy.length - 1]
      if (button && (!target || Math.abs(at - middle) <= Math.abs(target.at - middle))) target = { at, text: button.text, label: button.label }
    })
    if (!target) {
      say("no copyable block in view", "info")
      return false
    }
    copyText(target.text, target.label)
    return true
  }

  return { copyFocused }
}
