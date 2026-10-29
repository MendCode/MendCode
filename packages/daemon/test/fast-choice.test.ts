import { expect, test } from "bun:test"
import { invalidChoice, usableEffort, type ModelCatalog } from "../src/models"

const catalog: ModelCatalog = {
  selectable: true,
  defaults: { model: "gpt-6-luna" },
  list: () => [{ id: "gpt-6-luna", name: "GPT-6-Luna", efforts: ["low", "high"], variants: { thrifty: { effort: "low", parameters: { max_output_tokens: 2000 } } } }],
}
const fast = { service_tier: "priority" }

test("a fast choice is valid and keeps service_tier through effort resolution", () => {
  expect(invalidChoice({ model: "gpt-6-luna", effort: "high", parameters: fast }, catalog)).toBeUndefined()
  expect(usableEffort({ model: "gpt-6-luna", effort: "high", parameters: fast }, catalog)).toEqual({ model: "gpt-6-luna", effort: "high", parameters: fast })
})

test("a variant's parameters join a fast choice's instead of replacing them", () => {
  expect(usableEffort({ model: "gpt-6-luna", variant: "thrifty", parameters: fast }, catalog)).toEqual({ model: "gpt-6-luna", variant: "thrifty", effort: "low", parameters: { service_tier: "priority", max_output_tokens: 2000 } })
})
