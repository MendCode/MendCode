import { Schema } from "effect"

export class ApiBadRequestError extends Schema.ErrorClass<ApiBadRequestError>("BadRequestError")(
  {
    success: Schema.Literal(false),
    data: Schema.Null,
    errors: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)),
  },
  { httpApiStatus: 400 },
) {}

export class ApiNotFoundError extends Schema.ErrorClass<ApiNotFoundError>("NotFoundError")(
  {
    name: Schema.Literal("NotFoundError"),
    data: Schema.Struct({
      message: Schema.String,
    }),
  },
  { httpApiStatus: 404 },
) {}

export function badRequest(error: Record<string, unknown>) {
  return new ApiBadRequestError({
    success: false,
    data: null,
    errors: [error],
  })
}

export function notFound(message: string) {
  return new ApiNotFoundError({
    name: "NotFoundError",
    data: { message },
  })
}
