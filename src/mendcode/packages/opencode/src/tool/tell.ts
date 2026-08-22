import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./tell.txt"
import { AgentCommand } from "@/session/agent-command"
import { AgentCommandPolicy } from "@/session/agent-command-policy"
import { SessionID } from "@/session/schema"

export const Parameters = Schema.Struct({
  targetSessionID: SessionID.annotate({
    description: "Exact target session ID. Do not guess or resolve an ambiguous title.",
  }),
  text: Schema.String.annotate({
    description:
      "Plain-text message to queue. Keep it focused; files, reasoning, permissions, and history are not included.",
  }),
})

type Metadata = {
  peerMessage: {
    commandID: string
    targetSessionID: string
    state: AgentCommand.State
    policy: AgentCommandPolicy.Decision
  }
}

export const TellTool = Tool.define<typeof Parameters, Metadata, AgentCommand.Service>(
  "tell",
  Effect.gen(function* () {
    const commands = yield* AgentCommand.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const command = yield* commands
            .create({
              sourceSessionID: ctx.sessionID,
              targetSessionID: params.targetSessionID,
              type: "peer_message",
              payload: { text: params.text },
            })
            .pipe(Effect.orDie)
          return {
            title: `Peer message → ${command.targetSessionID}`,
            output: [
              `Queued peer message ${command.id}.`,
              `target: ${command.targetSessionID}`,
              `state: ${command.state}`,
              `policy: ${command.policy.decision}`,
              "The target must explicitly accept it before delivery.",
            ].join("\n"),
            metadata: {
              peerMessage: {
                commandID: command.id,
                targetSessionID: command.targetSessionID,
                state: command.state,
                policy: command.policy.decision,
              },
            },
          }
        }),
    }
  }),
)
