import { expect, test } from "bun:test"
import { defineExtension } from "../../src/mend/sdk"

test("defineExtension returns the provided module unchanged", () => {
  const extension = defineExtension({
    id: "demo.extension",
    activate() {},
  })

  expect(extension.id).toBe("demo.extension")
  expect(typeof extension.activate).toBe("function")
})
