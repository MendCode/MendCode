import { expect, test } from "bun:test"
import { Command, CompoundConfig, CompoundProfile, CompoundRunInput, createIdFactory } from "../src"
import { isReadOnlyCommand } from "../src/wire"

const limits = { maxModelRequests: 3, maxTotalTokens: 20_000, maxRuntimeMs: 30_000 }
test("compound config is additive, off by default and unknown prices block", () => {
  const config = CompoundConfig.parse({ version: 1, orchestration: { profiles: { safe: { strategy: "single", primary: { role: "main" }, limits } } } })
  expect(config.orchestration.enabled).toBe(false)
  expect(config.orchestration.profiles.safe!.limits.unknownCost).toBe("block")
})
test("compound profiles require bounded requests and strategy routes", () => {
  for (const strategy of ["cascade", "critic"] as const) {
    expect(CompoundProfile.safeParse({ strategy, primary: { role: "main" }, limits }).success).toBe(false)
    expect(CompoundProfile.safeParse({ strategy, primary: { role: "main" }, [strategy === "cascade" ? "escalation" : "critic"]: { providerID: "openai", modelID: "big" }, limits: { ...limits, maxModelRequests: 1 } }).success).toBe(false)
  }
  for (const patch of [{ maxModelRequests: 33 }, { maxTotalTokens: 0 }, { maxRuntimeMs: 999 }, { maxRuntimeMs: 3_600_001 }, { maxCostUsd: -1 }]) expect(CompoundProfile.safeParse({ strategy: "single", primary: { role: "main" }, limits: { ...limits, ...patch } }).success).toBe(false)
  expect(CompoundProfile.safeParse({ strategy: "single", primary: { role: "main", providerID: "openai", modelID: "big" }, limits }).success).toBe(false)
})
test("compound commands require explicit checks, CAS and keep content out of read-only peers", () => {
  const ids = createIdFactory()
  const base = { id: ids("command"), clientId: ids("client") }
  expect(Command.safeParse({ ...base, type: "compound.get" }).success).toBe(true)
  expect(Command.safeParse({ ...base, type: "compound.cancel", runId: crypto.randomUUID() }).success).toBe(true)
  expect(Command.safeParse({ ...base, type: "compound.configure", config: { version: 1, orchestration: { enabled: false, profiles: {} } } }).success).toBe(false)
  expect(CompoundRunInput.safeParse({ directory: "/tmp/project", profile: "safe", prompt: "work", checks: [] }).success).toBe(false)
  for (const type of ["compound.get", "compound.configure", "compound.start", "compound.cancel"] as const) expect(isReadOnlyCommand(type)).toBe(false)
})
