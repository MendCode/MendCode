import { describe, expect, test } from "bun:test"
import {
  findSlashAutocompleteTrigger,
  findSlashCommandInvocation,
  findSlashCommandToken,
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

  test("finds slash command tokens anywhere for input highlighting", () => {
    const exists = (name: string) => name === "spec" || name === "skills"

    expect(findSlashCommandToken("/spec do this", exists)).toEqual({
      name: "spec",
      start: 0,
      end: 5,
    })
    expect(findSlashCommandToken("  /skills", exists)).toEqual({
      name: "skills",
      start: 2,
      end: 9,
    })
    expect(findSlashCommandToken("remember /spec", exists)).toEqual({
      name: "spec",
      start: 9,
      end: 14,
    })
    expect(findSlashCommandToken("ignore /unknown but use /spec well", exists)).toEqual({
      name: "spec",
      start: 24,
      end: 29,
    })
    expect(findSlashCommandToken("/unknown", exists)).toBeUndefined()
    expect(findSlashCommandToken("path/to /spec", exists)).toEqual({
      name: "spec",
      start: 8,
      end: 13,
    })
  })
})
