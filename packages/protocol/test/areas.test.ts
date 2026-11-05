import { describe, expect, test } from "bun:test"
import { Settings } from "../src"
import { areaFor } from "../src/wire"

const areas = [
  { name: "company", directories: ["~/Code/acme/*"] },
  { name: "oss", directories: ["/src/oss", "~/Code/acme/public/"] },
]

describe("areaFor", () => {
  test("a directory takes the area of the most specific folder containing it; the rest is personal", () => {
    expect(areaFor("/home/o/Code/acme/api", areas, "/home/o")).toBe("company")
    expect(areaFor("/home/o/Code/acme", areas, "/home/o")).toBe("company")
    expect(areaFor("/home/o/Code/acme/public/site", areas, "/home/o")).toBe("oss")
    expect(areaFor("/home/o/Code/acmeish", areas, "/home/o")).toBe("personal")
    expect(areaFor("/src/oss/", areas, "/home/o")).toBe("oss")
    expect(areaFor("/home/o/Code/MendCode", areas, "/home/o")).toBe("personal")
    expect(areaFor(undefined, areas, "/home/o")).toBe("personal")
    expect(areaFor("/x", undefined)).toBe("personal")
  })

  test("settings refuse a area named personal, duplicate names and more than 8 areas", () => {
    expect(Settings.safeParse({ areas }).success).toBe(true)
    expect(Settings.safeParse({ areas: [{ name: "personal", directories: ["/a"] }] }).success).toBe(false)
    expect(Settings.safeParse({ areas: [areas[0], areas[0]] }).success).toBe(false)
    expect(Settings.safeParse({ areas: [{ name: "Company", directories: ["/a"] }] }).success).toBe(false)
    expect(Settings.safeParse({ areas: [{ name: "x", directories: [] }] }).success).toBe(false)
    expect(Settings.safeParse({ areas: Array.from({ length: 9 }, (_, i) => ({ name: `p${i}`, directories: ["/a"] })) }).success).toBe(false)
  })
})
