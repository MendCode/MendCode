import { zod } from "@/util/effect-zod"
import { withStatics } from "@/util/schema"
import { Schema } from "effect"
import type { Session } from "./session"

export const CommandType = Schema.Literals(["request_summary", "rename", "tag", "pause_after_turn", "stop", "send_message"]).pipe(
  withStatics((s) => ({ zod: zod(s) })),
)
export type CommandType = Schema.Schema.Type<typeof CommandType>

export const Decision = Schema.Literals(["safe_auto", "same_workspace", "approval_required", "denied"]).pipe(
  withStatics((s) => ({ zod: zod(s) })),
)
export type Decision = Schema.Schema.Type<typeof Decision>

export const Info = Schema.Struct({
  decision: Decision,
  permissions: Schema.Array(Schema.String),
  reason: Schema.String,
  ownership: Schema.optional(
    Schema.Struct({
      targetWriter: Schema.optional(
        Schema.Struct({
          clientID: Schema.String,
          expires: Schema.Number,
        }),
      ),
    }),
  ),
})
  .annotate({ identifier: "AgentCommandPolicy" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Info = Schema.Schema.Type<typeof Info>

export const MatrixItem = Schema.Struct({
  type: CommandType,
  decision: Decision,
  permissions: Schema.Array(Schema.String),
  reason: Schema.String,
})
  .annotate({ identifier: "AgentCommandPolicyMatrixItem" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type MatrixItem = Schema.Schema.Type<typeof MatrixItem>

type SessionLike = Pick<Session.Info, "directory" | "workspaceID">
type OwnershipLike = {
  targetWriter?: {
    clientID: string
    expires: number
  }
}

export function permissionsFor(type: CommandType) {
  if (type === "request_summary") return ["session.summary.read"]
  if (type === "pause_after_turn") return ["session.control.pause_after_turn"]
  if (type === "stop") return ["session.control.stop"]
  if (type === "send_message") return ["session.message.send"]
  return ["agent_view.metadata.patch"]
}

function sameWorkspace(input: { source?: SessionLike; target?: SessionLike }) {
  if (!input.source || !input.target) return false
  if (input.source.workspaceID || input.target.workspaceID) {
    return input.source.workspaceID !== undefined && input.target.workspaceID !== undefined && input.source.workspaceID === input.target.workspaceID
  }
  return input.source.directory === input.target.directory
}

export function evaluate(input: { type: CommandType; source?: SessionLike; target?: SessionLike; ownership?: OwnershipLike }): Info {
  if (input.type === "request_summary") {
    return {
      decision: "safe_auto",
      permissions: permissionsFor(input.type),
      reason: "Read-only summary requests are safe to auto-accept locally.",
    }
  }
  if (input.type === "pause_after_turn" || input.type === "stop" || input.type === "send_message") {
    return {
      decision: "approval_required",
      permissions: permissionsFor(input.type),
      reason: "Execution-changing commands require explicit target approval before they can run.",
    }
  }
  if (sameWorkspace(input)) {
    return {
      decision: "same_workspace",
      permissions: permissionsFor(input.type),
      reason: "Metadata-only command from the same workspace; target still receives an auditable command card.",
    }
  }
  return {
    decision: "approval_required",
    permissions: permissionsFor(input.type),
    reason: "Metadata command crosses workspace or lacks workspace context, so the target must approve it explicitly.",
  }
}

export function matrix(): MatrixItem[] {
  return [
    { type: "request_summary", ...evaluate({ type: "request_summary" }) },
    {
      type: "rename",
      decision: "same_workspace",
      permissions: permissionsFor("rename"),
      reason: "Allowed for same-workspace coordination; otherwise approval_required.",
    },
    {
      type: "tag",
      decision: "same_workspace",
      permissions: permissionsFor("tag"),
      reason: "Allowed for same-workspace coordination; otherwise approval_required.",
    },
    {
      type: "pause_after_turn",
      decision: "approval_required",
      permissions: permissionsFor("pause_after_turn"),
      reason: "Requires explicit target approval before changing the worker run loop.",
    },
    {
      type: "stop",
      decision: "approval_required",
      permissions: permissionsFor("stop"),
      reason: "Requires explicit target approval before aborting active work.",
    },
    {
      type: "send_message",
      decision: "approval_required",
      permissions: permissionsFor("send_message"),
      reason: "Requires explicit target approval before injecting a new user prompt.",
    },
  ]
}

export * as AgentCommandPolicy from "./agent-command-policy"
