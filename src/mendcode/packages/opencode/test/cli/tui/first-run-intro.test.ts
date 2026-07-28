import { describe, expect, test } from "bun:test"
import {
  FIRST_RUN_INTRO_TOTAL_MS,
  firstRunIntroLayout,
  firstRunIntroPhaseAt,
  firstRunIntroWordmarkProgress,
  shouldShowFirstRunIntro,
} from "../../../src/cli/cmd/tui/util/first-run-intro"

describe("first-run intro", () => {
  test("only shows for an interactive incomplete setup that has not seen it", () => {
    expect(shouldShowFirstRunIntro({ interactive: true, setupComplete: false, dismissed: false, seen: false })).toBe(true)
    expect(shouldShowFirstRunIntro({ interactive: false, setupComplete: false, dismissed: false, seen: false })).toBe(false)
    expect(shouldShowFirstRunIntro({ interactive: true, setupComplete: true, dismissed: false, seen: false })).toBe(false)
    expect(shouldShowFirstRunIntro({ interactive: true, setupComplete: false, dismissed: true, seen: false })).toBe(false)
    expect(shouldShowFirstRunIntro({ interactive: true, setupComplete: true, dismissed: true, seen: true, force: true })).toBe(true)
  })

  test("moves through signal, mascot, repair, identity, and handoff phases", () => {
    expect(firstRunIntroPhaseAt(0)).toBe("signal")
    expect(firstRunIntroPhaseAt(220)).toBe("mascot")
    expect(firstRunIntroPhaseAt(650)).toBe("mend")
    expect(firstRunIntroPhaseAt(1450)).toBe("identity")
    expect(firstRunIntroPhaseAt(FIRST_RUN_INTRO_TOTAL_MS)).toBe("handoff")
  })

  test("reveals the wordmark with an eased bounded progress", () => {
    expect(firstRunIntroWordmarkProgress(0)).toBe(0)
    expect(firstRunIntroWordmarkProgress(640)).toBe(0)
    expect(firstRunIntroWordmarkProgress(1045)).toBeGreaterThan(0)
    expect(firstRunIntroWordmarkProgress(1045)).toBeLessThan(1)
    expect(firstRunIntroWordmarkProgress(1450)).toBe(1)
    expect(firstRunIntroWordmarkProgress(5000)).toBe(1)
  })

  test("selects full, compact, and plain layouts from terminal dimensions", () => {
    expect(firstRunIntroLayout({ width: 120, height: 30 })).toBe("full")
    expect(firstRunIntroLayout({ width: 80, height: 16 })).toBe("compact")
    expect(firstRunIntroLayout({ width: 40, height: 10 })).toBe("compact")
    expect(firstRunIntroLayout({ width: 35, height: 9 })).toBe("plain")
  })
})
