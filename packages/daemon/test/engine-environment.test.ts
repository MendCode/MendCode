import { expect, test } from "bun:test"
import { engineEnvironment } from "../src/engine-environment"

test("the /env credentials go to other engines with their names for the model, unless engineEnvironment is false", () => {
  const values = () => ({ INSTABOX_KEY: "ib-secret", A_TOKEN: "t" })
  const shared = engineEnvironment({ enabled: true, values })
  expect(shared?.values).toEqual({ INSTABOX_KEY: "ib-secret", A_TOKEN: "t" })
  expect(shared?.note).toContain("A_TOKEN, INSTABOX_KEY")
  expect(shared?.note).not.toContain("ib-secret")
  expect(engineEnvironment({ enabled: false, values })).toBeUndefined()
})

test("no credentials or an unreadable vault give nothing", () => {
  expect(engineEnvironment({ enabled: true, values: () => ({}) })).toBeUndefined()
  expect(engineEnvironment({ enabled: true, values: () => { throw new Error("[STORE]: bad key") } })).toBeUndefined()
})
