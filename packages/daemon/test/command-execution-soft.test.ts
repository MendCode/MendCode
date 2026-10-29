import { expect, test } from "bun:test"
import { createCommandExecution } from "../src/command-execution"
import { skillCommandText, type CustomCommand } from "../src/custom-commands"
import type { ModelCatalog } from "../src/models"

const catalog: ModelCatalog = { selectable: true, defaults: { model: "native" }, list: () => [{ id: "native", name: "Native", efforts: [] }, { id: "other", name: "Other", efforts: [] }] }
const agents = [
  { name: "build", description: "Build", mode: "primary" as const, source: "builtin" as const, trusted: true },
  { name: "explore", description: "Explore", mode: "subagent" as const, source: "builtin" as const, trusted: true },
]
const base = { args: "", directory: "/tmp/fixture", current: { model: "native" }, sessionModel: { model: "native" }, hasSelection: false, currentAgent: "build", agents, permission: "full" as const, trusted: true }
const command: CustomCommand = { name: "triage", description: "Triage", source: "project", body: "Triage $ARGUMENTS", argumentHint: "", foreign: true }
const execution = () => createCommandExecution({ catalog, inlineShell: () => "", prompt: async () => "" })

test("a foreign command's model and agent apply only when they exist here", async () => {
  const unknown = await execution().prepare({ ...base, command: { ...command, model: "sonnet", agent: "Plan-Reviewer" } })
  expect(unknown).toEqual({ text: "Triage", subtask: false, agent: "build" })
  const known = await execution().prepare({ ...base, command: { ...command, model: "other", agent: "Explore" } })
  expect(known).toMatchObject({ agent: "explore", model: { model: "other" } })
  expect(known.subtask).toBe(true)
})

test("a native command with an unknown model still fails loudly", async () => {
  const { foreign: _foreign, ...native } = command
  await expect(execution().prepare({ ...base, command: { ...native, model: "sonnet" } })).rejects.toThrow()
})

test("a skill run as /name sends its text as an argument, so shell markers in the skill never run", async () => {
  const shells: string[] = []
  const exec = createCommandExecution({ catalog, inlineShell: (text) => { shells.push(text); return "RAN" }, prompt: async () => "" })
  const text = skillCommandText({ dir: "/skills/x", body: "Run !`rm -rf /` for $ARGUMENTS and keep $1 and $HOME" }, "the target")
  expect(text).toBe("Skill folder: /skills/x\n\nRun !`rm -rf /` for the target and keep $1 and $HOME")
  const prepared = await exec.prepare({ ...base, command: { ...command, name: "x", skill: true, body: "$ARGUMENTS" }, args: text })
  expect(prepared.text).toBe(text)
  expect(shells).toEqual([])
})

test("skill arguments are appended when the body has no placeholder", () => {
  expect(skillCommandText({ dir: "/s", body: "Do it." }, "now")).toBe("Skill folder: /s\n\nDo it.\n\nARGUMENTS: now")
  expect(skillCommandText({ dir: "/s", body: "Do it." }, "")).toBe("Skill folder: /s\n\nDo it.")
})
