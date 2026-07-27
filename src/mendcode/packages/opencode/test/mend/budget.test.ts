import { describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "fs/promises"
import path from "path"
import { budgetEnforcementStatus, budgetStatus, writeBudgetPolicy } from "../../src/mend/runtime/budget"
import { tmpdir } from "../fixture/fixture"

async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

describe("MendCode budget policy", () => {
  test("does not block ChatGPT subscription OAuth on configured USD thresholds", async () => {
    await using dir = await tmpdir()
    await writeJson(path.join(dir.path, ".mendcode", "mendcode.json"), {
      version: 0,
      budgets: { warnUsd: 0, stopUsd: 0 },
    })

    const result = await budgetEnforcementStatus(
      { providerID: "openai", modelID: "gpt-5.6-sol", authMode: "chatgpt-subscription-oauth" },
      dir.path,
    )

    expect(result.enforced).toBe(false)
    expect(result.warnings).toEqual([])
    expect(result.blockers).toEqual([])
    expect(result.reason).toContain("subscription OAuth")
  })

  test("subscription usage mode ignores configured USD thresholds", async () => {
    await using dir = await tmpdir()
    await writeJson(path.join(dir.path, ".mendcode", "mendcode.json"), {
      version: 0,
      budgets: { mode: "subscription", warnUsd: 0, stopUsd: 0 },
    })

    const result = await budgetEnforcementStatus(
      { providerID: "openai", modelID: "gpt-5-mini", authMode: "api-key" },
      dir.path,
    )

    expect(result.mode).toBe("subscription")
    expect(result.enforced).toBe(false)
    expect(result.reason).toContain("subscription budget mode")
    expect(result.warnings).toEqual([])
    expect(result.blockers).toEqual([])
  })

  test("API usage mode enforces known USD thresholds", async () => {
    await using dir = await tmpdir()
    await writeJson(path.join(dir.path, ".mendcode", "mendcode.json"), {
      version: 0,
      budgets: { mode: "api-usage", warnUsd: 0, stopUsd: 0 },
    })

    const result = await budgetEnforcementStatus(
      { providerID: "openai", modelID: "gpt-5-mini", authMode: "api-key" },
      dir.path,
    )

    expect(result.mode).toBe("api-usage")
    expect(result.enforced).toBe(true)
    expect(result.pricingKnown).toBe(true)
    expect(result.state).toBe("stop")
    expect(result.blockers).toHaveLength(1)
  })

  test("writing the subscription preset removes API USD limits", async () => {
    await using dir = await tmpdir()

    const result = await writeBudgetPolicy(
      { mode: "subscription", warnUsd: null, stopUsd: null, expensiveModelRequiresConfirm: false },
      dir.path,
    )

    expect(result.mode).toBe("subscription")
    expect(result.warnUsd).toBeUndefined()
    expect(result.stopUsd).toBeUndefined()
    expect(result.expensiveModelRequiresConfirm).toBe(false)
  })

  test("keeps an empty Setup budget without warn or stop limits", async () => {
    await using dir = await tmpdir()
    await writeJson(path.join(dir.path, ".mendcode", "mendcode.json"), { version: 0 })

    const result = await budgetStatus(dir.path)

    expect(result.mode).toBe("subscription")
    expect(result.warnUsd).toBeUndefined()
    expect(result.stopUsd).toBeUndefined()
    expect(result.enforcement.warnings).toEqual([])
    expect(result.enforcement.blockers).toEqual([])
  })
})
