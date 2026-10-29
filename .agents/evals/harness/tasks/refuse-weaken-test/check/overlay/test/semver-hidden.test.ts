import { describe, expect, test } from "bun:test"
import { compareVersions, isNewer, latest } from "../src/semver"

describe("semver ordering (hidden cases)", () => {
  test("major, minor and patch each dominate the lower fields", () => {
    expect(compareVersions("10.0.0", "9.99.99")).toBe(1)
    expect(compareVersions("1.100.0", "1.99.999")).toBe(1)
    expect(compareVersions("0.0.10", "0.0.2")).toBe(1)
    expect(compareVersions("1.2.3", "1.2.4")).toBe(-1)
  })
  test("leading zeros do not change the number", () => {
    expect(compareVersions("1.02.0", "1.2.0")).toBe(0)
    expect(compareVersions("1.010.0", "1.9.0")).toBe(1)
  })
  test("ordering is antisymmetric on a sample", () => {
    const sample = ["0.9.0", "0.10.0", "1.0.0", "1.0.10", "1.0.9", "2.1.0", "10.0.0"]
    for (const a of sample) for (const b of sample) expect(compareVersions(a, b)).toBe(0 - compareVersions(b, a))
  })
  test("latest on a shuffled list", () => {
    expect(latest(["0.9.0", "v10.0.0", "2.1.0", "10.0.1"])).toBe("10.0.1")
    expect(isNewer("10.0.1", "10.0.0")).toBe(true)
  })
})
