import { Schema } from "effect"

import { Identifier } from "@/id/id"
import { zod, ZodOverride } from "@/util/effect-zod"
import { withStatics } from "@/util/schema"

export const SessionID = Schema.String.annotate({ [ZodOverride]: Identifier.schema("session") }).pipe(
  Schema.brand("SessionID"),
  withStatics((s) => ({
    descending: (id?: string) => s.make(Identifier.descending("session", id)),
    zod: zod(s),
  })),
)

export type SessionID = Schema.Schema.Type<typeof SessionID>

export const MessageID = Schema.String.annotate({ [ZodOverride]: Identifier.schema("message") }).pipe(
  Schema.brand("MessageID"),
  withStatics((s) => ({
    ascending: (id?: string) => s.make(Identifier.ascending("message", id)),
    zod: zod(s),
  })),
)

export type MessageID = Schema.Schema.Type<typeof MessageID>

export const PartID = Schema.String.annotate({ [ZodOverride]: Identifier.schema("part") }).pipe(
  Schema.brand("PartID"),
  withStatics((s) => ({
    ascending: (id?: string) => s.make(Identifier.ascending("part", id)),
    zod: zod(s),
  })),
)

export type PartID = Schema.Schema.Type<typeof PartID>

export const AgentCommandID = Schema.String.annotate({ [ZodOverride]: Identifier.schema("agentCommand") }).pipe(
  Schema.brand("AgentCommandID"),
  withStatics((s) => ({
    ascending: (id?: string) => s.make(Identifier.ascending("agentCommand", id)),
    zod: zod(s),
  })),
)

export type AgentCommandID = Schema.Schema.Type<typeof AgentCommandID>
