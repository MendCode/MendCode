import { describe, expect, test } from "bun:test"
import { parseLoopCommand } from "../src/view/loop-command"

function spec(args: string) {
  const result = parseLoopCommand(args)
  if (!result.ok) throw new Error(result.error)
  return result.spec
}

const error = (args: string) => {
  const result = parseLoopCommand(args)
  return result.ok ? undefined : result.error
}

describe("parseLoopCommand triggers", () => {
  test("every N minutes, hours and days", () => {
    expect(spec("every 30m check ci").trigger).toEqual({ kind: "interval", everyMs: 30 * 60_000 })
    expect(spec("every 2h check ci").trigger).toEqual({ kind: "interval", everyMs: 2 * 3_600_000 })
    expect(spec("every 1d check ci").trigger).toEqual({ kind: "interval", everyMs: 86_400_000 })
    expect(spec("every 5 min check ci").trigger).toEqual({ kind: "interval", everyMs: 5 * 60_000 })
  })
  test("daily HH:MM, with or without a leading zero", () => {
    expect(spec("daily 09:00 review").trigger).toEqual({ kind: "daily", at: "09:00" })
    expect(spec("daily 9:05 review").trigger).toEqual({ kind: "daily", at: "09:05" })
  })
  test("now is a manual loop that runs immediately", () => {
    const now = spec("now say hi")
    expect(now.trigger).toEqual({ kind: "manual" })
    expect(now.runNow).toBe(true)
    expect(spec("every 1h say hi").runNow).toBe(false)
  })
  test("triggers are case-insensitive", () => expect(spec("EVERY 2H go").trigger.kind).toBe("interval"))
})

describe("parseLoopCommand budgets", () => {
  test("monitor is the default", () => expect(spec("every 1h watch prod").budget).toEqual({ mode: "monitor" }))
  test("--runs N makes a fixed budget", () => expect(spec("now --runs 2 say hi").budget).toEqual({ mode: "fixed", maxRuns: 2 }))
  test("--goal makes a goal budget and until: becomes the criteria", () => {
    const parsed = spec("every 1h --goal fix flaky tests until: bun test passes 3 times")
    expect(parsed.budget).toEqual({ mode: "goal" })
    expect(parsed.objective).toBe("fix flaky tests")
    expect(parsed.criteria).toBe("bun test passes 3 times")
  })
  test("--goal with --runs caps the goal", () => {
    expect(spec("every 1h --goal --runs 5 ship it").budget).toEqual({ mode: "goal", maxRuns: 5 })
    expect(spec("every 1h --runs 5 --goal ship it").budget).toEqual({ mode: "goal", maxRuns: 5 })
  })
  test("until: stays in the objective without --goal", () => {
    const parsed = spec("every 1h keep going until: tomorrow")
    expect(parsed.objective).toBe("keep going until: tomorrow")
    expect(parsed.criteria).toBeUndefined()
  })
  test("a goal without until: has no criteria", () => expect(spec("now --goal do it").criteria).toBeUndefined())
})

describe("parseLoopCommand naming and summary", () => {
  test("name is the first six words of the objective", () => {
    expect(spec("every 1h one two three four five six seven eight").name).toBe("one two three four five six")
    expect(spec("every 1h short").name).toBe("short")
    expect(spec("every 1h --goal fix flaky tests until: green").name).toBe("fix flaky tests")
  })
  test("extra whitespace is normalised", () => expect(spec("  every   1h   --goal   a   b  ").objective).toBe("a   b"))
  test("summary describes trigger and budget", () => {
    const summary = (args: string) => {
      const result = parseLoopCommand(args)
      return result.ok ? result.summary : ""
    }
    expect(summary("every 1h watch")).toBe("loop: every 1h · monitor")
    expect(summary("now --runs 2 hi")).toBe("loop: now · 2 runs")
    expect(summary("daily 09:00 --goal x")).toBe("loop: daily 09:00 · goal · audit")
    expect(summary("every 2h --goal --runs 4 x")).toBe("loop: every 2h · goal ≤4 · audit")
    expect(summary(`now --goal --check "bun test" --check lint --no-audit x`)).toBe("loop: now · goal · 2 checks")
  })

  test("--check takes quoted or single-word commands; shell syntax, too many checks and non-goal loops are refused", () => {
    const parsed = parseLoopCommand(`now --goal --check "bun test packages" --check 'tsc -b' fix it until: green`)
    expect(parsed.ok && parsed.spec).toMatchObject({ checks: ["bun test packages", "tsc -b"], objective: "fix it", criteria: "green" })
    expect(parsed.ok && parsed.spec.audit).toBeUndefined()
    const error = (args: string) => {
      const result = parseLoopCommand(args)
      return result.ok ? "" : result.error
    }
    expect(error(`now --goal --check "bun test && rm -rf ." x`)).toContain("shell syntax")
    expect(error("now --goal --check")).toContain("--check needs a command")
    expect(error(`now --goal ${"--check a ".repeat(6)}x`)).toBe("at most 5 checks")
    expect(error("now --check lint x")).toBe("--check and --no-audit need --goal")
    expect(error("now --no-audit x")).toBe("--check and --no-audit need --goal")
  })
})

describe("parseLoopCommand errors", () => {
  test("empty input shows usage", () => expect(error("")).toStartWith("usage: /loop"))
  test("unknown trigger", () => {
    expect(error("sometimes do it")).toContain("trigger must be")
    expect(error("30m do it")).toContain("trigger must be")
  })
  test("interval problems", () => {
    expect(error("every do it")).toContain("interval needs")
    expect(error("every 30s do it")).toContain("interval needs")
    expect(error("every 0m do it")).toContain("1m to 30d")
    expect(error("every 31d do it")).toContain("1m to 30d")
  })
  test("daily problems", () => {
    expect(error("daily do it")).toContain("daily needs")
    expect(error("daily 25:00 do it")).toContain("HH:MM")
    expect(error("daily 09:60 do it")).toContain("HH:MM")
  })
  test("missing objective", () => {
    expect(error("every 1h")).toBe("/loop needs an objective")
    expect(error("now --goal")).toBe("/loop needs an objective")
    expect(error("now --runs 2")).toBe("/loop needs an objective")
  })
  test("bad flags", () => {
    expect(error("now --runs x go")).toContain("--runs needs")
    expect(error("now --runs 0 go")).toContain("--runs needs")
    expect(error("now --runs 5000 go")).toContain("--runs needs")
    expect(error("now --runs")).toContain("--runs needs")
    expect(error("now --fast go")).toContain("unknown flag --fast")
  })
  test("empty criteria and oversized objective", () => {
    expect(error("now --goal fix it until:")).toContain("until:")
    expect(error(`now ${"x".repeat(9_000)}`)).toBe("objective is too long")
  })
})
