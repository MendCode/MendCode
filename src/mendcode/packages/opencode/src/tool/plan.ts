import path from "path"
import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { Question } from "../question"
import { Session } from "@/session/session"
import { MessageV2 } from "../session/message-v2"
import { Provider } from "@/provider/provider"
import { InstanceState } from "@/effect/instance-state"
import { type SessionID, MessageID, PartID } from "../session/schema"
import { Config } from "@/config/config"
import { Agent } from "@/agent/agent"
import EXIT_DESCRIPTION from "./plan-exit.txt"

function getLastModel(sessionID: SessionID) {
  for (const item of MessageV2.stream(sessionID)) {
    if (item.info.role === "user" && item.info.model) return item.info.model
  }
  return undefined
}

export const resolvePlanExitAgent = Effect.fn("Plan.resolvePlanExitAgent")(function* (input: {
  config: Config.Interface
  agents: Agent.Interface
}) {
  const cfg = yield* input.config.get()
  const requested = cfg.plan_exit_agent?.trim() || "build"
  const agent = yield* input.agents.get(requested)
  if (!agent || agent.mode === "subagent" || agent.hidden === true) return "build"
  return requested
})

export function switchToBuildAgent(input: {
  session: Session.Interface
  provider: Provider.Interface
  sessionID: SessionID
  text: string
  agent?: string
}) {
  return Effect.gen(function* () {
    const model = getLastModel(input.sessionID) ?? (yield* input.provider.defaultModel())
    const agent = input.agent?.trim() || "build"

    const msg: MessageV2.User = {
      id: MessageID.ascending(),
      sessionID: input.sessionID,
      role: "user",
      time: { created: Date.now() },
      agent,
      model,
    }
    yield* input.session.updateMessage(msg)
    yield* input.session.updatePart({
      id: PartID.ascending(),
      messageID: msg.id,
      sessionID: input.sessionID,
      type: "text",
      text: input.text,
      synthetic: true,
    } satisfies MessageV2.TextPart)
  })
}

export const Parameters = Schema.Struct({})

export const PlanExitTool = Tool.define(
  "plan_exit",
  Effect.gen(function* () {
    const session = yield* Session.Service
    const question = yield* Question.Service
    const provider = yield* Provider.Service
    const config = yield* Config.Service
    const agents = yield* Agent.Service

    return {
      description: EXIT_DESCRIPTION,
      parameters: Parameters,
      execute: (_params: {}, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const instance = yield* InstanceState.context
          const info = yield* session.get(ctx.sessionID)
          const plan = path.relative(instance.worktree, Session.plan(info, instance))
          const answers = yield* question.ask({
            sessionID: ctx.sessionID,
            questions: [
              {
                question: `Plan at ${plan} is complete. Would you like to switch to the build agent and start implementing?`,
                header: "Build Agent",
                custom: false,
                options: [
                  { label: "Yes", description: "Switch to build agent and start implementing the plan" },
                  { label: "No", description: "Stay with plan agent to continue refining the plan" },
                ],
              },
            ],
            tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
          })

          if (answers[0]?.[0] === "No") yield* new Question.RejectedError()
          const planExitAgent = yield* resolvePlanExitAgent({ config, agents })

          yield* switchToBuildAgent({
            session,
            provider,
            sessionID: ctx.sessionID,
            agent: planExitAgent,
            text: `Implement this approved plan. The plan at ${plan} has been approved; edit files as needed and execute it.`,
          })

          return {
            title: `Switching to ${planExitAgent}`,
            output: `User approved switching to ${planExitAgent}. Continue by implementing the approved plan.`,
            metadata: { planExitAgent },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
