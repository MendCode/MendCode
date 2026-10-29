import { expect, test } from "bun:test"
import { AIConfigInput, Command, createIdFactory, isReadOnlyCommand } from "../src"

const ids = createIdFactory()
const patch = { description: "Local repair", roles: { main: { model: "local:main" } } }
const applying = { action: "apply", scope: "project", target: "/tmp/project/.mendcode/recipes/repair.json", expectedHash: "a".repeat(64), patch, sessionId: ids("session"), confirm: true }

test("B70 additive command accepts bounded typed proposals and causal apply", () => {
  expect(Command.safeParse({ id: ids("command"), clientId: ids("client"), type: "ai.config", directory: "/tmp/project", input: applying }).success).toBe(true)
  expect(AIConfigInput.parse({ action: "plan", intent: "balanced", taskKind: "repair", candidates: [{ role: "small" }] })).toMatchObject({ scope: "project" })
  expect(AIConfigInput.safeParse({ action: "validate", scope: "global", target: applying.target, patch }).success).toBe(true)
})

test("B70 rejects unsafe patches, unbounded candidates, absent confirmations and invalid hashes", () => {
  for (const input of [
    { ...applying, confirm: false }, { ...applying, sessionId: undefined }, { ...applying, expectedHash: "old" },
    { ...applying, patch: { ...patch, apiKey: "secret" } }, { ...applying, patch: { ...patch, roles: { advisor: { model: "local:main" } } } },
    { action: "plan", intent: "quality", taskKind: "review", candidates: Array(31).fill({ model: "local:main" }) },
    { action: "plan", intent: "quality", taskKind: "review", profileName: "../escape" },
  ]) expect(AIConfigInput.safeParse(input).success).toBe(false)
  expect(AIConfigInput.safeParse({ ...applying, patch: JSON.parse('{"description":"x","roles":{"main":{"model":"x"}},"__proto__":{}}') }).success).toBe(false)
})

test("B70 mixed config operations never enter the remote read-only allowlist", () => {
  expect(isReadOnlyCommand("ai.config")).toBe(false)
})
