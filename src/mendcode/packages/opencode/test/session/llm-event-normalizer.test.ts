import { describe, expect, test } from "bun:test"
import { createStreamEventNormalizer, type Event } from "../../src/session/llm"

const event = (value: unknown) => value as Event

describe("session.llm stream event normalizer", () => {
  test("keeps reasoning ids stable and exposes delta text", () => {
    const normalize = createStreamEventNormalizer()

    const start = normalize(event({ type: "reasoning-start" })) as any
    const delta = normalize(event({ type: "reasoning-delta", delta: "checking the route" })) as any
    const end = normalize(event({ type: "reasoning-end" })) as any

    expect(start).toMatchObject({ type: "reasoning-start", id: "reasoning-0" })
    expect(delta).toMatchObject({
      type: "reasoning-delta",
      id: "reasoning-0",
      text: "checking the route",
    })
    expect(end).toMatchObject({ type: "reasoning-end", id: "reasoning-0" })
  })

  test("keeps text ids stable and exposes delta text", () => {
    const normalize = createStreamEventNormalizer()

    const start = normalize(event({ type: "text-start" })) as any
    const delta = normalize(event({ type: "text-delta", delta: "hello" })) as any
    const end = normalize(event({ type: "text-end" })) as any

    expect(start).toMatchObject({ type: "text-start", id: "text-0" })
    expect(delta).toMatchObject({ type: "text-delta", id: "text-0", text: "hello" })
    expect(end).toMatchObject({ type: "text-end", id: "text-0" })
  })

  test("preserves provider ids when present", () => {
    const normalize = createStreamEventNormalizer()

    expect(normalize(event({ type: "reasoning-start", id: "provider-reasoning" }))).toMatchObject({
      id: "provider-reasoning",
    })
    expect(
      normalize(event({ type: "reasoning-delta", id: "provider-reasoning", text: "already normalized" })),
    ).toMatchObject({
      id: "provider-reasoning",
      text: "already normalized",
    })
  })
})
