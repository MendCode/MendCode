import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { PlanReview } from "@/plan-review"
import { resolvePlanExitAgent, switchToBuildAgent } from "./plan"
import { Session } from "@/session/session"
import { Provider } from "@/provider/provider"
import { MessageV2 } from "@/session/message-v2"
import { Config } from "@/config/config"
import { Agent } from "@/agent/agent"

export const Parameters = Schema.Struct({
  title: Schema.optional(Schema.String).annotate({
    description: "Short title for the plan modal",
  }),
  markdown: Schema.String.annotate({
    description: "The complete Markdown plan to render for user review",
  }),
})

function updateDisplayedPlanInput(input: {
  session: Session.Interface
  ctx: Tool.Context
  params: Schema.Schema.Type<typeof Parameters>
}) {
  if (!input.ctx.callID) return Effect.void

  return Effect.gen(function* () {
    const part = MessageV2.parts(input.ctx.messageID).find(
      (item): item is MessageV2.ToolPart =>
        item.type === "tool" && item.callID === input.ctx.callID && item.tool === "plan_review",
    )
    if (!part) return
    yield* input.session.updatePart({
      ...part,
      state: {
        ...part.state,
        input: input.params,
      },
    } satisfies MessageV2.ToolPart)
  })
}

export const PlanReviewTool = Tool.define<
  typeof Parameters,
  {},
  PlanReview.Service | Session.Service | Provider.Service | Config.Service | Agent.Service
>(
  "plan_review",
  Effect.gen(function* () {
    const planReview = yield* PlanReview.Service
    const session = yield* Session.Service
    const provider = yield* Provider.Service
    const config = yield* Config.Service
    const agents = yield* Agent.Service

    return {
      description:
        "Show a Markdown implementation plan to the user in an interactive review modal. Use this only when you have a complete plan ready for approval, edit, or rejection.",
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const reply = yield* planReview.ask({
            sessionID: ctx.sessionID,
            title: params.title,
            markdown: params.markdown,
            tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
          })

          const reviewedMarkdown = reply.markdown ?? params.markdown
          if ((reply.action === "apply" || reply.action === "edit") && reply.markdown !== undefined) {
            yield* updateDisplayedPlanInput({
              session,
              ctx,
              params: { ...params, markdown: reviewedMarkdown },
            })
          }

          if (reply.action === "apply") {
            const planExitAgent = yield* resolvePlanExitAgent({ config, agents })
            yield* switchToBuildAgent({
              session,
              provider,
              sessionID: ctx.sessionID,
              agent: planExitAgent,
              text: [
                "Implement this approved plan. The user approved it via the plan review modal. You can now edit files.",
                "",
                reviewedMarkdown,
              ].join("\n"),
            })
            return {
              title: "Plan approved",
              output: `User approved the plan and switched to ${planExitAgent}. Continue by implementing the approved plan.`,
              metadata: { planExitAgent },
            }
          }

          if (reply.action === "edit") {
            return {
              title: "Plan edited",
              output: [
                "The user manually edited the plan. Treat this edited Markdown as the latest source of truth:",
                "",
                reviewedMarkdown,
              ].join("\n"),
              metadata: {},
            }
          }

          return {
            title: "Plan rejected",
            output: [
              "The user rejected the plan.",
              reply.reason ? `Reason: ${reply.reason}` : undefined,
              "Decide whether to revise the plan or explain why no revision is needed before showing it again.",
            ]
              .filter(Boolean)
              .join("\n"),
            metadata: {},
          }
        }).pipe(
          Effect.catchTag("PlanReviewClosedError", () =>
            Effect.succeed({
              title: "Plan closed",
              output:
                "The user closed the plan review modal without approving or rejecting it. Ask what they want to change before proceeding.",
              metadata: {},
            }),
          ),
          Effect.orDie,
        ),
    }
  }),
)
