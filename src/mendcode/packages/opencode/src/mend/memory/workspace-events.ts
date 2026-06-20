import { BusEvent } from "@/bus/bus-event"
import { GlobalBus } from "@/bus/global"
import { Identifier } from "@/id/id"
import { Schema } from "effect"
import type { MemoryWorkspace } from "./workspaces"

export const MemoryWorkspaceEvent = BusEvent.define(
  "memory.workspace",
  Schema.Struct({
    root: Schema.String,
    workspaceID: Schema.String,
    status: Schema.Union([Schema.Literal("created"), Schema.Literal("updated")]),
    displayName: Schema.String,
  }),
)

export function publishMemoryWorkspaceEvent(input: {
  root: string
  workspace: MemoryWorkspace
  status: "created" | "updated"
}) {
  GlobalBus.emit("event", {
    directory: input.root,
    payload: {
      id: Identifier.create("evt", "ascending"),
      type: MemoryWorkspaceEvent.type,
      properties: {
        root: input.workspace.root,
        workspaceID: input.workspace.id,
        status: input.status,
        displayName: input.workspace.displayName,
      },
    },
  })
}
