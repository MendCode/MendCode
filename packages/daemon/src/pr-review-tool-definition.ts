import { z } from "zod"
import { defineTool, fail } from "@mendcode/tools"

/** Shared guidance and tool metadata are needed before any review runs. */
export const NO_SELF_MENTION = "To review a PR now, call pr_review with action review (or the user runs /pr review <n>); never post an @mendcode comment, or anything else, on the forge from the user's account to trigger a review, and never post without the user's consent."

export const PrReviewToolArgs = z.strictObject({
  action: z.enum(["review", "status"]),
  pr: z.string().trim().min(1).max(300).optional().describe("review: the PR number or URL; omitted, the PR of the checkout's current branch"),
  // No description: every prompt that lists the tool would pay for it. The answer to a review of an already reviewed head names it.
  full: z.boolean().optional(),
})

/** `enabled`: `experimental.pr_review` is on (checked on every call). */
export function createPrReviewTool({ enabled }: { enabled(): boolean }) {
  return defineTool({
    name: "pr_review",
    tier: "balanced",
    description: [
      "Have MendCode's own PR reviewer review one pull request of this checkout now (action review, pr: number or URL; omitted, the current branch's PR), exactly as the user's /pr review does: two passes in read-only child sessions, the repository's filters and claims apply, and the findings arrive in this session.",      "It posts on the PR only as the user's /pr publish consent allows; until then the review stays in this session. action status lists this checkout's review jobs and the posting consent.",
      NO_SELF_MENTION,
      "To review every new PR from now on, the user runs /pr watch-repo; to set up or configure the reviewer, use review_config (setup first).",
    ].join(" "),
    // A review spends model calls and may post (as `/pr publish` allows), but runs no code the model wrote: it follows the session's
    // permission mode like a command (full access runs it, accept-edits and default ask, and a grant for the session or always holds).
    permission: "execute",
    permissionFor: (args) => (args.action === "review" ? "execute" : "read"),
    args: PrReviewToolArgs,
    async preview(args, context) {
      const port = context.prReview
      if (args.action !== "review" || !port || !enabled()) return undefined
      return port.preview({ pr: args.pr }).catch(() => undefined)
    },
    async execute(args, context) {
      const title = `pr_review ${args.action}${args.pr ? ` ${args.pr}` : ""}`
      if (!enabled()) return fail({ title, message: "The PR reviewer is off: the user turns it on with /pr on (experimental.pr_review)." })
      const port = context.prReview
      if (!port) return fail({ title, message: "MendCode's PR reviewer is not available in this session (it runs only in a local session of the daemon's machine). Ask the user to run /pr review <n>; do not comment on the PR to trigger it." })
      const done = args.action === "review" ? await port.review({ pr: args.pr, full: args.full }) : await port.status()
      if (!done.ok) return fail({ title, message: `[PR_REVIEW]: ${done.message}` })
      return { output: done.text, truncated: false, title, isError: false }
    },
  })
}
