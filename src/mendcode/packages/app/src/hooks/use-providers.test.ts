import { describe, expect, test } from "bun:test"
import { billableConnectedProviders, connectedProviders } from "./provider-lists"

const providers = [
  {
    id: "opencode",
    name: "MendCode",
    models: {
      free: { cost: { input: 0 } },
    },
  },
  {
    id: "openai",
    name: "OpenAI",
    models: {
      paid: { cost: { input: 1 } },
    },
  },
  {
    id: "anthropic",
    name: "Anthropic",
    models: {
      paid: { cost: { input: 3 } },
    },
  },
]

describe("provider helpers", () => {
  test("connected providers reflect runtime connected ids without billable-model filtering", () => {
    const result = connectedProviders(providers, ["opencode", "openai"])

    expect(result.map((p) => p.id)).toEqual(["opencode", "openai"])
  })

  test("billable connected providers remain a separate list for paid-model gates", () => {
    const result = billableConnectedProviders(providers, ["opencode", "openai"])

    expect(result.map((p) => p.id)).toEqual(["openai"])
  })
})
