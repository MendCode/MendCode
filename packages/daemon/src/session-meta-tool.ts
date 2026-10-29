import { SessionMetaInput } from "@mendcode/protocol"
import { defineTool, fail } from "@mendcode/tools"

export const sessionMetaTool = defineTool({
  name: "session_meta",
  tier: "balanced",
  description: "Update this thread only: rename (title), regenerate_title (configured title model), link_pr (PR number or URL, omitted = saved branch), unlink_pr, settle (archive with reason), restore, pin (pinned), rules (inactiveDays/null, prClosed, disabled), check (refresh linked PR and evaluate opt-in rules). No polling. Agent settlement waits for running and queued work to finish.",
  permission: "write",
  args: SessionMetaInput,
  permissionFor: (args) => args.action === "link_pr" || args.action === "check" || args.action === "regenerate_title" ? "execute" : "write",
  async execute(args, context) {
    if (!context.sessionMeta) return fail({ title: "session_meta", message: "Session metadata unavailable" })
    try {
      const result = await context.sessionMeta(args)
      return { output: JSON.stringify(result), title: `session_meta ${args.action}`, truncated: false, isError: false }
    } catch { return fail({ title: "session_meta", message: "Metadata operation refused or failed" }) }
  },
})
