import { describe, expect, test } from "bun:test"
import type { Tier } from "@mendcode/protocol/wire"
import { applyTierBundle } from "../src/ui/app/tier"
import type { TuiProfile } from "../src/view/tui-profile"

/** `applyTierBundle` against a daemon that accepts everything, recording the profile patches it writes. */
async function apply(from: Tier | undefined, to: Tier) {
  const patches: Array<Partial<TuiProfile>> = []
  const ctx = {
    input: { directory: ".", send: async () => ({ ok: true, result: {} }) },
    state: { settingsNow: from ? { tier: from } : {} },
    fail: (message: string) => { throw new Error(message) },
  }
  await applyTierBundle(ctx as never, { tier: to, changeProfile: (patch) => void patches.push(patch) })
  return patches[0]!
}

describe("the tier and the process setting", () => {
  test("minimalist selects auto, the others leave the setting alone", async () => {
    expect((await apply(undefined, "minimalist")).processMode).toBe("auto")
    expect((await apply("full", "minimalist")).processMode).toBe("auto")
    expect(await apply(undefined, "balanced")).not.toHaveProperty("processMode")
    expect(await apply("balanced", "full")).not.toHaveProperty("processMode")
  })

  test("leaving minimalist keeps one process: every tier's bundle is auto", async () => {
    expect((await apply("minimalist", "balanced")).processMode).toBe("auto")
    expect((await apply("minimalist", "full")).processMode).toBe("auto")
  })
})
