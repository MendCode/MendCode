import { describe, expect, test } from "bun:test"
import { commandInvocationText, syntheticCommandTemplateParts } from "../../src/session/prompt"

describe("command prompt parts", () => {
  test("keeps slash invocation visible and command template synthetic", () => {
    expect(commandInvocationText("probe", "target")).toBe("/probe target")
    expect(commandInvocationText("probe", "")).toBe("/probe")

    const [part] = syntheticCommandTemplateParts("probe", [
      {
        type: "text",
        text: "Expanded command template",
      },
    ])

    expect(part).toMatchObject({
      type: "text",
      text: "Expanded command template",
      synthetic: true,
      metadata: {
        kind: "command_template",
        command: "probe",
      },
    })
  })
})
