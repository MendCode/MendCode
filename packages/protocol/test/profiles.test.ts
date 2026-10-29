import { describe, expect, test } from "bun:test"
import { Settings } from "../src"
import { profileFor } from "../src/wire"

const profiles = [
  { name: "company", directories: ["~/Code/acme/*"] },
  { name: "oss", directories: ["/src/oss", "~/Code/acme/public/"] },
]

describe("profileFor", () => {
  test("a directory takes the profile of the most specific folder containing it; the rest is personal", () => {
    expect(profileFor("/home/o/Code/acme/api", profiles, "/home/o")).toBe("company")
    expect(profileFor("/home/o/Code/acme", profiles, "/home/o")).toBe("company")
    expect(profileFor("/home/o/Code/acme/public/site", profiles, "/home/o")).toBe("oss")
    expect(profileFor("/home/o/Code/acmeish", profiles, "/home/o")).toBe("personal")
    expect(profileFor("/src/oss/", profiles, "/home/o")).toBe("oss")
    expect(profileFor("/home/o/Code/MendCode", profiles, "/home/o")).toBe("personal")
    expect(profileFor(undefined, profiles, "/home/o")).toBe("personal")
    expect(profileFor("/x", undefined)).toBe("personal")
  })

  test("settings refuse a profile named personal, duplicate names and more than 8 profiles", () => {
    expect(Settings.safeParse({ profiles }).success).toBe(true)
    expect(Settings.safeParse({ profiles: [{ name: "personal", directories: ["/a"] }] }).success).toBe(false)
    expect(Settings.safeParse({ profiles: [profiles[0], profiles[0]] }).success).toBe(false)
    expect(Settings.safeParse({ profiles: [{ name: "Company", directories: ["/a"] }] }).success).toBe(false)
    expect(Settings.safeParse({ profiles: [{ name: "x", directories: [] }] }).success).toBe(false)
    expect(Settings.safeParse({ profiles: Array.from({ length: 9 }, (_, i) => ({ name: `p${i}`, directories: ["/a"] })) }).success).toBe(false)
  })
})
