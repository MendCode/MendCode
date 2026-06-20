import { BusEvent } from "@/bus/bus-event"
import { GlobalBus } from "@/bus/global"
import { Identifier } from "@/id/id"
import { Schema } from "effect"
import type { DreamRunStatus } from "./dream"

export const MemoryDreamEvent = BusEvent.define(
  "memory.dream",
  Schema.Struct({
    root: Schema.String,
    runID: Schema.String,
    status: Schema.Union([
      Schema.Literal("started"),
      Schema.Literal("progress"),
      Schema.Literal("running"),
      Schema.Literal("completed"),
      Schema.Literal("failed"),
      Schema.Literal("canceled"),
      Schema.Literal("missed"),
    ]),
    message: Schema.String,
    proposalCount: Schema.Number,
  }),
)

export function publishMemoryDreamEvent(input: {
  root: string
  runID: string
  status: DreamRunStatus | "started" | "progress"
  message: string
  proposalCount?: number
}) {
  GlobalBus.emit("event", {
    directory: input.root,
    payload: {
      id: Identifier.create("evt", "ascending"),
      type: MemoryDreamEvent.type,
      properties: {
        root: input.root,
        runID: input.runID,
        status: input.status,
        message: input.message,
        proposalCount: input.proposalCount ?? 0,
      },
    },
  })
}
