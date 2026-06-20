import * as InstanceState from "@/effect/instance-state"
import { runMemorySideChat } from "@/server/routes/instance/memory-side-chat"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { MemorySideChatPayload } from "../groups/memory"

export const memoryHandlers = HttpApiBuilder.group(InstanceHttpApi, "memory", (handlers) =>
  Effect.gen(function* () {
    const sideChat = Effect.fn("MemoryHttpApi.sideChat")(function* (ctx: {
      payload: typeof MemorySideChatPayload.Type
    }) {
      const instance = yield* InstanceState.context
      return yield* runMemorySideChat(ctx.payload, instance.directory)
    })

    return handlers.handle("sideChat", sideChat)
  }),
)
