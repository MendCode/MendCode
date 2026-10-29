import { describe, expect, test } from "bun:test"
import { createIdFactory } from "@mendcode/protocol"
import { createRunLimitsStore, systemWithLimits } from "../src/run-limits"

const ids = createIdFactory()

describe("run limits store", () => {
  test("a patch merges, null clears one field and an empty result forgets the session", () => {
    const store = createRunLimitsStore()
    const session = ids("session")
    expect(store.get(session)).toBeUndefined()
    expect(store.configure(session, { maxSteps: 3, tools: ["read"] })).toEqual({ maxSteps: 3, tools: ["read"] })
    expect(store.configure(session, { offline: true, tools: undefined })).toEqual({ maxSteps: 3, tools: ["read"], offline: true })
    expect(store.configure(session, { maxSteps: null, tools: null })).toEqual({ offline: true })
    expect(store.configure(session, { offline: null })).toEqual({})
    expect(store.get(session)).toBeUndefined()
  })

  test("limits are per session and removed with it", () => {
    const store = createRunLimitsStore()
    const [a, b] = [ids("session"), ids("session")]
    store.configure(a, { excludeTools: ["shell"] })
    expect(store.get(b)).toBeUndefined()
    store.delete(a)
    expect(store.get(a)).toBeUndefined()
  })

  test("the system prompt is replaced and/or extended, never otherwise touched", () => {
    expect(systemWithLimits("base", undefined)).toBe("base")
    expect(systemWithLimits("base", { maxSteps: 2 })).toBe("base")
    expect(systemWithLimits("base", { appendSystemPrompt: "more" })).toBe("base\n\nmore")
    expect(systemWithLimits("base", { systemPrompt: "own" })).toBe("own")
    expect(systemWithLimits("base", { systemPrompt: "own", appendSystemPrompt: "more" })).toBe("own\n\nmore")
  })
})
