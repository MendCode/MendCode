import { describe, expect, test } from "bun:test"
import {
  findSlashAutocompleteTrigger,
  findSlashCommandInvocation,
} from "../../../../src/cli/cmd/tui/component/prompt/slash-command"

describe("slash command prompt helpers", () => {
  test("finds slash autocomplete triggers anywhere in the current token", () => {
    expect(findSlashAutocompleteTrigger("/", 1)).toEqual({ index: 0 })
    expect(findSlashAutocompleteTrigger("recuerda /spe", "recuerda /spe".length)).toEqual({ index: 9 })
    expect(findSlashAutocompleteTrigger("recuerda /spe ahora", "recuerda /spe ahora".length)).toBeUndefined()
    expect(findSlashAutocompleteTrigger("path/to", "path/to".length)).toBeUndefined()
  })

  test("extracts a command invocation from any token on the first line", () => {
    const exists = (name: string) => name === "spec"

    expect(findSlashCommandInvocation("/spec haz esto", exists)).toEqual({
      name: "spec",
      arguments: "haz esto",
    })
    expect(findSlashCommandInvocation("recuerda /spec haz esto\ncon detalle", exists)).toEqual({
      name: "spec",
      arguments: "recuerda haz esto\ncon detalle",
    })
    expect(findSlashCommandInvocation("recuerda /unknown haz esto", exists)).toBeUndefined()
    expect(findSlashCommandInvocation("ignora /unknown pero usa /spec bien", exists)).toEqual({
      name: "spec",
      arguments: "ignora /unknown pero usa bien",
    })
    expect(findSlashCommandInvocation("path/to /spec", exists)).toEqual({
      name: "spec",
      arguments: "path/to",
    })
  })
})
