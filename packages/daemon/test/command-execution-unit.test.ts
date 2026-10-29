import { expect, test } from "bun:test"
import { createCommandExecution } from "../src/command-execution"
import type { CustomCommand } from "../src/custom-commands"
import type { ModelCatalog } from "../src/models"

const catalog: ModelCatalog = { selectable: true, defaults: { model: "native" }, list: () => [{ id: "native", name: "Native", efforts: [] }, { id: "external", name: "External", efforts: [], engine: "claude" }] }
const base = { args: "", directory: "/tmp/fixture", current: { model: "native" }, sessionModel: { model: "native" }, hasSelection: false, currentAgent: "build", agents: [{ name: "build", description: "Build", mode: "primary" as const, source: "builtin" as const, trusted: true }], permission: "full" as const, trusted: true }
const command: CustomCommand = { name: "audit", description: "Audit", source: "user", body: "Inspect files", argumentHint: "" }

/** An execution whose inline shell is held, not run: what the engine would run is what `held` records. */
function held(extra: Partial<Parameters<typeof createCommandExecution>[0]> = {}) {
  const commands: string[] = []
  const execution = createCommandExecution({ catalog, inlineShell: (text) => { commands.push(text); return `<m${commands.length - 1}>` }, prompt: async () => "", ...extra })
  return { execution, commands }
}

test("plain command templates do not introduce a per-turn model override", async () => {
  const { execution } = held()
  expect(await execution.prepare({ ...base, command })).toEqual({ text: "Inspect files", subtask: false, agent: "build" })
  expect(await execution.prepare({ ...base, current: { model: "external" }, sessionModel: { model: "external" }, command })).toEqual({ text: "Inspect files", subtask: false, agent: "build" })
})

test("subtask commands cannot run on an external session engine before shell expansion", async () => {
  const { execution, commands } = held()
  await expect(execution.prepare({ ...base, sessionModel: { model: "external" }, command: { ...command, subtask: true, body: "!`touch refused`" } })).rejects.toThrow("native session")
  await expect(execution.prepare({ ...base, command: { ...command, model: "external", subtask: true, body: "!`touch refused`" } })).rejects.toThrow("native session")
  expect(commands).toEqual([])
})

test("command model and selection apply to external session engines as per-turn overrides", async () => {
  const { execution } = held()
  const prepared = await execution.prepare({ ...base, sessionModel: { model: "external" }, hasSelection: true, command })
  expect(prepared.subtask).toBe(false)
  await expect(execution.prepare({ ...base, command: { ...command, model: "external" } })).resolves.toBeDefined()
})

test("inline shell is held for the engine, not run: the prompt carries a marker and the command waits for the turn's permission pipeline", async () => {
  const { execution, commands } = held()
  const prepared = await execution.prepare({ ...base, command: { ...command, body: "Status: !`git status`" } })
  expect(commands).toEqual(["git status"])
  expect(prepared.text).toBe("Status: <m0>")
})

test("arguments reach inline shell as single quoted words and are never re-parsed as shell syntax", async () => {
  const { execution, commands } = held()
  await execution.prepare({ ...base, args: '"HEAD; echo INJECTED"', command: { ...command, body: "!`git show $1`" } })
  await execution.prepare({ ...base, args: "it's $(id) `id` | cat > x", command: { ...command, body: "!`echo $ARGUMENTS`" } })
  await execution.prepare({ ...base, args: "a b", command: { ...command, body: "!`echo $1 then $2`" } })
  expect(commands).toEqual([`git show 'HEAD; echo INJECTED'`, `echo 'it'\\''s' '$(id)' '\`id\`' '|' cat '>' x`, "echo a then b"])
})

test("a placeholder that would sit inside quotes is rejected with a clear message before any prompt is queued", async () => {
  const { execution, commands } = held()
  for (const body of ['!`printf "%s" "$1"`', "!`printf '%s' '$1'`", '!`echo "x $ARGUMENTS"`', "!`echo \\$1`"]) {
    await expect(execution.prepare({ ...base, args: "HEAD", command: { ...command, body } })).rejects.toThrow(/inside quotes/)
  }
  // Without a value nothing is inserted, so the documented template shape keeps working argument-free.
  await expect(execution.prepare({ ...base, args: "", command: { ...command, body: '!`printf "%s" "$1"`' } })).resolves.toBeDefined()
  expect(commands).toEqual(['printf "%s" ""'])
})

test("inline shell is refused in plan mode, in an untrusted project and outside the native engine, before anything is held", async () => {
  const { execution, commands } = held({ engine: "codex" })
  const shelled = { ...command, body: "!`touch x`" }
  await expect(held().execution.prepare({ ...base, permission: "plan", command: shelled })).rejects.toThrow("plan mode")
  await expect(held().execution.prepare({ ...base, trusted: false, command: { ...shelled, source: "project" } })).rejects.toThrow("trust")
  await expect(execution.prepare({ ...base, command: shelled })).rejects.toThrow("native engine")
  await expect(held().execution.prepare({ ...base, sessionModel: { model: "external" }, command: shelled })).rejects.toThrow("native engine")
  expect(commands).toEqual([])
})
