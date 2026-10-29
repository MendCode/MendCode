import { describe, expect, test } from "bun:test"
import { compareVersions, isNewer, latest, parseVersion } from "../src/semver"

describe("parseVersion", () => {
  test("accepts a leading v", () => {
    expect(parseVersion("v1.2.3")).toEqual([1, 2, 3])
  })
  test("rejects anything that is not three numbers", () => {
    expect(() => parseVersion("1.2")).toThrow(TypeError)
    expect(() => parseVersion("1.2.3-beta")).toThrow(TypeError)
  })
})

describe("compareVersions", () => {
  test("equal versions", () => {
    expect(compareVersions("1.2.3", "v1.2.3")).toBe(0)
  })
  test("compares numerically, not alphabetically", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBe(1)
    expect(compareVersions("1.9.0", "1.10.0")).toBe(-1)
    expect(compareVersions("2.0.0", "10.0.0")).toBe(-1)
  })
  test("patch level matters", () => {
    expect(compareVersions("1.2.10", "1.2.9")).toBe(1)
  })
})

describe("isNewer and latest", () => {
  test("isNewer", () => {
    expect(isNewer("1.10.0", "1.9.9")).toBe(true)
    expect(isNewer("1.0.0", "1.0.0")).toBe(false)
  })
  test("latest picks the newest", () => {
    expect(latest(["1.9.0", "v1.10.0", "1.2.0"])).toBe("v1.10.0")
  })
})
