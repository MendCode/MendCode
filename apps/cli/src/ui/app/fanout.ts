import type { SessionId } from "@mendcode/protocol"
import { parseFanout, fanoutSections, type FanoutRow } from "../../view/fanout"
import { createTextPageState, preload } from "../lazy-pages"
import type { AppContext } from "./context"

export function createFanout(ctx: AppContext, actions: { switchSession(id: SessionId): Promise<void>; openChanges(): Promise<void> }) {
  const { input, state, requestFrame, say, fail } = ctx
  async function fanoutCommand(args: string) {
    if (input.remote) return fail("Fan-out worktrees are local only")
    const parsed = parseFanout(args)
    const open = /^(open|changes) ([1-8])$/.exec(args.trim())
    if (!parsed && !open && args.trim() && args.trim() !== "compare") return say('/fanout "prompt" modelA modelB · compare · open N · changes N', "warning")
    const reply = await input.send({ type: "session.fanout", sessionId: state.sessionId, action: parsed ? "start" : "compare", ...parsed })
    if (!reply.ok) return fail(reply.error.message)
    const rows = (reply.result?.branches ?? []) as FanoutRow[]
    if (open) {
      const row = rows[Number(open[2]) - 1]
      if (!row) return say("No such fan-out branch", "warning")
      input.directory = row.directory
      await actions.switchSession(row.sessionId as SessionId)
      if (open[1] === "changes") await actions.openChanges()
      return
    }
    await preload("recap")
    state.textPage = createTextPageState({ title: "Fan-out", summary: `${rows.length} branches · leases retained · /fanout compare refreshes`, sections: fanoutSections(rows) })
    state.page = "text"
    requestFrame()
  }
  return { fanoutCommand }
}
