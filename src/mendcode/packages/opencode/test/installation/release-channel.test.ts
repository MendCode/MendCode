import { expect, test } from "bun:test"
import { parseChannel, selectRelease } from "../../src/installation/release-channel"

const releases = [
  { tag_name: "v0.2.0-nightly.20260905.1", prerelease: true },
  { tag_name: "v0.2.0-beta.2", prerelease: true },
  { tag_name: "v0.2.0-beta.10", prerelease: true },
  { tag_name: "v0.1.43", prerelease: false },
  { tag_name: "v9.0.0", draft: true },
  { tag_name: "invalid" },
]

test("channels never select another prerelease track or a draft", () => {
  expect(selectRelease(releases, "stable")).toBe("0.1.43")
  expect(selectRelease(releases, "beta")).toBe("0.2.0-beta.10")
  expect(selectRelease(releases, "nightly")).toBe("0.2.0-nightly.20260905.1")
  expect(selectRelease([{ tag_name: "v0.1.43" }], "beta")).toBeUndefined()
  expect(selectRelease([{ tag_name: "v0.2.0-beta.1", prerelease: false }], "stable")).toBeUndefined()
})

test("invalid channel cannot silently select stable", () => {
  expect(() => parseChannel("preview")).toThrow("stable, beta, or nightly")
})
