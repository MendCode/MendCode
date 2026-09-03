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
            title: `Session message → ${command.targetSessionID}`,
            output: [
              `Queued session message ${command.id}.`,
              `target: ${command.targetSessionID}`,
              `state: ${command.state}`,
              `policy: ${command.policy.decision}`,
              command.policy.decision === "safe_auto"
                ? "Automatic delivery waits for the target idle boundary without interrupting active work. The command remains active until the target finishes, then its response is returned here automatically."
                : "Automatic delivery is disabled because the sessions do not share a verified workspace.",
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
