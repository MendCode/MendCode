import { describe, expect, test } from "bun:test"
import { readInterpretation } from "../src/loop-interpret"

describe("the small role's answer to a schedule phrase", () => {
  test("a strict-form trigger and an objective are accepted, in a fence or after reasoning", () => {
    expect(readInterpretation('{"trigger":"every 3h","objective":"revisa facturas"}')).toEqual({ trigger: "every 3h", objective: "revisa facturas" })
    expect(readInterpretation('<think>hm</think>\n```json\n{"trigger":"Daily 09:30","objective":"  check   the issues "}\n```')).toEqual({ trigger: "daily 09:30", objective: "check the issues" })
    expect(readInterpretation('{"trigger":"now","objective":"say hi"}')).toEqual({ trigger: "now", objective: "say hi" })
    expect(readInterpretation('{"trigger":"adaptive","objective":"watch"}')).toEqual({ trigger: "adaptive 10m", objective: "watch" })
  })

  test("anything else is refused: no JSON, a trigger the loops do not run, no objective", () => {
    expect(readInterpretation("sure, every 3h")).toBeUndefined()
    expect(readInterpretation('{"trigger":"every 10s","objective":"x"}')).toBeUndefined()
    expect(readInterpretation('{"trigger":"every third thursday","objective":"x"}')).toBeUndefined()
    expect(readInterpretation('{"trigger":"every 3h","objective":"  "}')).toBeUndefined()
    expect(readInterpretation('{"trigger":3,"objective":"x"}')).toBeUndefined()
  })
})
