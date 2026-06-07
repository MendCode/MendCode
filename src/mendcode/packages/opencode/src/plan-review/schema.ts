import { Schema } from "effect"

import { Identifier } from "@/id/id"
import { zod, ZodOverride } from "@/util/effect-zod"
import { Newtype } from "@/util/schema"

export class PlanReviewID extends Newtype<PlanReviewID>()(
  "PlanReviewID",
  Schema.String.annotate({ [ZodOverride]: Identifier.schema("planReview") }),
) {
  static ascending(id?: string): PlanReviewID {
    return this.make(Identifier.ascending("planReview", id))
  }

  static readonly zod = zod(this)
}
