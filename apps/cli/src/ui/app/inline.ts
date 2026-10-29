import type { ItemId } from "@mendcode/protocol"
import type { Block, Transcript } from "../../view/transcript"
import type { Line } from "../theme"
import type { AppContext } from "./context"

/**
 * Inline mode (no alternate screen): which transcript blocks are final and may scroll into the terminal's own
 * scrollback, and what is still live. A block is final once it is finished, is followed by another block (or the turn
 * is over, so nothing can change its trailing gap) and does not belong to a run of tool rows that is still growing
 * (a long run folds its oldest rows into one line). Final blocks are written once and never repainted.
 */
export function createInline(ctx: AppContext) {
  const { state, input } = ctx
  let owner: Transcript | undefined
  const committed = new Set<ItemId>()
  let banner = false

  function committable(blocks: readonly Block[], at: number, idle: boolean) {
    const block = blocks[at]!
    if (block.status === "running") return false
    if (at + 1 >= blocks.length) return idle
    if (!idle && block.kind === "tool_call" && blocks.slice(at + 1).every((next) => next.kind === "tool_call" || next.kind === "reasoning")) return false
    return true
  }

  /** The index after the newest block already written; blocks before it that arrived later (older history) stay out. */
  function firstUncommitted(blocks: readonly Block[]) {
    for (let at = blocks.length - 1; at >= 0; at--) if (committed.has(blocks[at]!.itemId)) return at + 1
    return 0
  }

  function sync() {
    if (owner !== state.transcript) {
      owner = state.transcript
      committed.clear()
    }
  }

  return {
    /** True while the plain chat is on screen: no page, palette, extension modal, card, side chat or find bar needs the alternate screen. */
    live() {
      const chat = state.sideChats.get(state.sessionId)
      return input.screen.inline === true && state.page === "chat" && !state.palette && !state.extModalId && !state.modelQuick && !state.fetchFacts && !state.rewindCard && !state.goalPrompt && !state.returnPrompt && !chat?.open && !state.find && !state.promptSearch && !state.shortcuts && !state.planDraft
    },
    /** The title row written once when the inline chat starts: the product, its version and the project. */
    startLine(): Line | undefined {
      if (banner || state.paging?.loading) return undefined
      banner = true
      const where = input.home && input.directory?.startsWith(input.home) ? `~${input.directory.slice(input.home.length)}` : (input.directory ?? "")
      const name = state.tuiProfile.productName || "MendCode"
      return [{ text: name, fg: "primary", bold: true }, ...(input.version ? [{ text: ` v${input.version}`, fg: "muted" as const }] : []), ...(where ? [{ text: `  ${where}`, fg: "muted" as const }] : [])]
    },
    /** The lines of every block that became final since the last call (marked written), and the lines of the blocks still live. */
    take(width: number): { finished: Line[]; tail: Line[] } {
      sync()
      const transcript = state.transcript
      const blocks = transcript.blocks()
      // While the first window of an opened session loads the history is not known yet.
      if (state.paging && !state.paging.ready && state.paging.loading) return { finished: [], tail: [] }
      const idle = transcript.activeTurn === undefined && transcript.pendingRequests.length === 0
      const finished: Line[] = []
      let at = Math.max(firstUncommitted(blocks), transcript.olderBlocks)
      for (; at < blocks.length && committable(blocks, at, idle); at++) {
        const block = blocks[at]!
        committed.add(block.itemId)
        for (const line of transcript.blockLines(block.itemId, width)) finished.push(line.spans)
      }
      const tail: Line[] = []
      for (let rest = at; rest < blocks.length; rest++) for (const line of transcript.blockLines(blocks[rest]!.itemId, width)) tail.push(line.spans)
      return { finished, tail }
    },
  }
}
