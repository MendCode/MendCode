import { expect, test } from "bun:test"
import { workflowDefaultModel } from "../../src/session/workflow-model"

test("dedicated workflow default keeps the requested variant and nested model id", () => {
  expect(workflowDefaultModel({ workflow_model: "openai/gpt-5.6-luna-fast", workflow_variant: "max" })).toEqual({
    providerID: "openai", modelID: "gpt-5.6-luna-fast", variant: "max",
  })
  expect(workflowDefaultModel({ workflow_model: "openrouter/vendor/model" })?.modelID).toBe("vendor/model")
})

test("a variant alone does not override the normal model fallback", () => {
  expect(workflowDefaultModel({ workflow_variant: "max" })).toBeUndefined()
  expect(workflowDefaultModel({ workflow_model: "invalid" })).toBeUndefined()
  expect(workflowDefaultModel({ workflow_model: "openai/" })).toBeUndefined()
})
