import { Schema } from "effect"

import { zod } from "@/util/effect-zod"
import { PositiveInt, withStatics } from "@/util/schema"

const boundedInt = (minimum: number, maximum: number) =>
  Schema.Int.check(Schema.isGreaterThanOrEqualTo(minimum), Schema.isLessThanOrEqualTo(maximum))

export const TimeoutMs = boundedInt(1_000, 300_000)
export const SummaryTokens = boundedInt(512, 8_192)

/**
 * Additive configuration for the beta AI control plane.
 *
 * This module deliberately contains only configuration shapes. Provider and
 * role resolution lives in `mend/config/compound-models.ts`, where the
 * running provider inventory is available.
 */
export const Compaction = Schema.Struct({
  strategy: Schema.optional(Schema.Literals(["portable", "auto", "native"])),
  portable_mode: Schema.optional(Schema.Literals(["legacy", "incremental"])),
  timeout_ms: Schema.optional(TimeoutMs),
  max_summary_tokens: Schema.optional(SummaryTokens),
  on_native_error: Schema.optional(Schema.Literals(["stop", "portable"])),
}).pipe(withStatics((schema) => ({ zod: zod(schema) })))
export type Compaction = Schema.Schema.Type<typeof Compaction>

const RoleModelRef = Schema.Struct({
  role: Schema.String,
}).pipe(withStatics((schema) => ({ zod: zod(schema) })))

const DirectModelRef = Schema.Struct({
  providerID: Schema.String,
  modelID: Schema.String,
  variant: Schema.optional(Schema.String),
}).pipe(withStatics((schema) => ({ zod: zod(schema) })))

export const ModelRef = Schema.Union([RoleModelRef, DirectModelRef]).pipe(
  withStatics((schema) => ({ zod: zod(schema) })),
)
export type ModelRef = Schema.Schema.Type<typeof ModelRef>

const LimitsShape = Schema.Struct({
  maxModelRequests: boundedInt(1, 32),
  maxTotalTokens: PositiveInt,
  maxRuntimeMs: boundedInt(1_000, 3_600_000),
  maxCostUsd: Schema.optional(Schema.Finite.check(Schema.isGreaterThan(0))),
  unknownCost: Schema.Literals(["block", "allow-with-token-cap"]),
})

export const Limits = LimitsShape.pipe(withStatics((schema) => ({ zod: zod(schema) })))
export type Limits = Schema.Schema.Type<typeof Limits>

export const CompoundProfile = Schema.Struct({
  strategy: Schema.Literals(["single", "cascade", "critic"]),
  primary: ModelRef,
  escalation: Schema.optional(ModelRef),
  critic: Schema.optional(ModelRef),
  limits: Limits,
}).check(
  Schema.makeFilter((value) => {
    const minimum = value.strategy === "single" ? 1 : value.strategy === "cascade" ? 2 : 3
    return value.limits.maxModelRequests >= minimum
      ? undefined
      : {
          path: ["limits", "maxModelRequests"],
          issue: `${value.strategy} profiles require at least ${minimum} model requests for their bounded state machine`,
        }
  }),
).pipe(withStatics((schema) => ({ zod: zod(schema) })))
export type CompoundProfile = Schema.Schema.Type<typeof CompoundProfile>

export const Orchestration = Schema.Struct({
  enabled: Schema.Boolean,
  profiles: Schema.Record(Schema.String, CompoundProfile),
}).pipe(withStatics((schema) => ({ zod: zod(schema) })))
export type Orchestration = Schema.Schema.Type<typeof Orchestration>

export const Info = Schema.Struct({
  version: Schema.Literal(1),
  orchestration: Orchestration,
}).pipe(withStatics((schema) => ({ zod: zod(schema) })))
export type Info = Schema.Schema.Type<typeof Info>

export type Strategy = CompoundProfile["strategy"]
