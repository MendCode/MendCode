import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import DESCRIPTION from "./tell.txt"
import { AgentCommand } from "@/session/agent-command"
import { AgentCommandPolicy } from "@/session/agent-command-policy"
import { SessionID } from "@/session/schema"
import { MessageV2 } from "@/session/message-v2"
import { assertExternalDirectoryEffect } from "./external-directory"
import { mimeType } from "@/util/filesystem"
import * as path from "path"
import { stat } from "fs/promises"
import { pathToFileURL } from "url"

export const Parameters = Schema.Struct({
  targetSessionID: SessionID.annotate({
    description: "Exact target session ID. Do not guess or resolve an ambiguous title.",
  }),
  text: Schema.optional(Schema.String).annotate({
    description:
      "Optional plain-text message to queue. Keep it focused. Either text or at least one attachment is required.",
  }),
  files: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Absolute local file paths to attach, up to 10 total attachments.",
  }),
  userAttachments: Schema.optional(Schema.Array(Schema.String)).annotate({
    description:
      "Filenames of attachments from earlier user messages in this session to forward. Attachments on the current user message are included automatically.",
  }),
})

function inputAttachment(part: MessageV2.FilePart): MessageV2.FilePartInput {
  return {
    type: "file",
    mime: part.mime,
    filename: part.filename,
    url: part.url,
    source: part.source,
  }
}

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
          const assistant = ctx.messages.find(
            (message): message is MessageV2.WithParts & { info: MessageV2.Assistant } =>
              message.info.id === ctx.messageID && message.info.role === "assistant",
          )
          const currentUser = assistant
            ? ctx.messages.find((message) => message.info.id === assistant.info.parentID)
            : ctx.messages.findLast((message) => message.info.role === "user")
          const currentAttachments =
            currentUser?.info.role === "user"
              ? currentUser.parts.filter((part): part is MessageV2.FilePart => part.type === "file")
              : []
          const requestedAttachments = (params.userAttachments ?? []).map((filename) => {
            const matches = ctx.messages.flatMap((message) =>
              message.info.role === "user"
                ? message.parts.filter(
                    (part): part is MessageV2.FilePart =>
                      part.type === "file" && part.filename === filename,
                  )
                : [],
            )
            if (matches.length === 0) throw new Error(`User attachment not found: ${filename}`)
            if (matches.length > 1) throw new Error(`User attachment filename is ambiguous: ${filename}`)
            return matches[0]!
          })
          const localAttachments = yield* Effect.forEach(params.files ?? [], (file) =>
            Effect.gen(function* () {
              if (!path.isAbsolute(file)) return yield* Effect.fail(new Error(`Attachment path must be absolute: ${file}`))
              yield* assertExternalDirectoryEffect(ctx, file, { kind: "file" })
              yield* ctx.ask({ permission: "read", patterns: [file], always: ["*"], metadata: {} })
              const info = yield* Effect.tryPromise(() => stat(file)).pipe(
                Effect.catch(() => Effect.fail(new Error(`Attachment file not found: ${file}`))),
              )
              if (!info.isFile())
                return yield* Effect.fail(new Error(`Attachment file not found: ${file}`))
              return {
                type: "file" as const,
                mime: yield* Effect.promise(() => mimeType(file)),
                filename: path.basename(file),
                url: pathToFileURL(file).href,
              }
            }),
          )
          const attachments = [...currentAttachments, ...requestedAttachments]
            .map(inputAttachment)
            .concat(localAttachments)
            .filter(
              (attachment, index, all) =>
                all.findIndex(
                  (candidate) =>
                    candidate.url === attachment.url &&
                    candidate.mime === attachment.mime &&
                    candidate.filename === attachment.filename,
                ) === index,
            )
            .slice(0, 10)
          const text = params.text?.trim() || (attachments.length > 0 ? "Shared attachments." : "")
          if (!text) return yield* Effect.fail(new Error("Session message requires text or at least one attachment."))
          const command = yield* commands
            .create({
              sourceSessionID: ctx.sessionID,
              targetSessionID: params.targetSessionID,
              type: "peer_message",
              payload: { text, attachments: attachments.length > 0 ? attachments : undefined },
            })
            .pipe(Effect.orDie)
          return {
            title: `Session message → ${command.targetSessionID}`,
            output: [
              `Queued session message ${command.id}.`,
              `target: ${command.targetSessionID}`,
              `state: ${command.state}`,
              `policy: ${command.policy.decision}`,
              `attachments: ${attachments.length}`,
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
        }).pipe(Effect.orDie),
    }
  }),
)
