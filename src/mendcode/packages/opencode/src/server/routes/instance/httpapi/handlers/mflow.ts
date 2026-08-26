import {
  activateMflow,
  deactivateMflow,
  mflowControlStatus,
  mflowLocalRelayGuide,
  removeMflowConfig,
  scanMflowRelays,
} from "@/mend/config/mflow"
import * as InstanceState from "@/effect/instance-state"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { MflowActivatePayload } from "../groups/mflow"

export const mflowHandlers = HttpApiBuilder.group(InstanceHttpApi, "mflow", (handlers) =>
  handlers
    .handle("status", () =>
      Effect.gen(function* () {
        const instance = yield* InstanceState.context
        return yield* Effect.promise(() => mflowControlStatus(instance.directory))
      }),
    )
    .handle("activate", (ctx: { payload: typeof MflowActivatePayload.Type }) =>
      Effect.gen(function* () {
        const instance = yield* InstanceState.context
        return yield* Effect.promise(() => activateMflow(ctx.payload, instance.directory))
      }),
    )
    .handle("scan", () => Effect.promise(() => scanMflowRelays()))
    .handle("relayGuide", () =>
      Effect.gen(function* () {
        return mflowLocalRelayGuide((yield* InstanceState.context).directory)
      }),
    )
    .handle("deactivate", () =>
      Effect.gen(function* () {
        const instance = yield* InstanceState.context
        return yield* Effect.promise(() => deactivateMflow(instance.directory))
      }),
    )
    .handle("remove", () =>
      Effect.gen(function* () {
        const instance = yield* InstanceState.context
        return yield* Effect.promise(() => removeMflowConfig(instance.directory))
      }),
    ),
)
