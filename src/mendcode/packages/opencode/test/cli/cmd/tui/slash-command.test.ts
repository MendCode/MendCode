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

  test("extracts a command invocation only when slash starts the prompt", () => {
    const exists = (name: string) => name === "spec"

    expect(findSlashCommandInvocation("/spec do this", exists)).toEqual({
      name: "spec",
      arguments: "do this",
    })
    expect(findSlashCommandInvocation("  /spec do this\nwith details", exists)).toEqual({
      name: "spec",
      arguments: "do this\nwith details",
    })
    expect(findSlashCommandInvocation("remember /spec do this\nwith details", exists)).toBeUndefined()
    expect(findSlashCommandInvocation("remember /unknown do this", exists)).toBeUndefined()
    expect(findSlashCommandInvocation("ignore /unknown but use /spec well", exists)).toBeUndefined()
    expect(findSlashCommandInvocation("path/to /spec", exists)).toBeUndefined()
  })
})
