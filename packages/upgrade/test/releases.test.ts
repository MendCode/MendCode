import { describe, expect, test } from "bun:test"
import { UpgradeError } from "../src/errors"
import { channelOf, compareSemver, decide, parseReleases, parseVersion, pickRelease, platformAsset, type Release } from "../src/releases"

const make = (tag: string, prerelease: boolean, publishedAt = 0, draft = false): Release => ({ tag, prerelease, draft, publishedAt, assets: [] })

describe("channels", () => {
  const releases = [
    make("v1.0.0", false),
    make("v1.2.0", false),
    make("v1.10.0", false),
    make("v1.12.0-beta.2", true),
    make("v1.12.0-beta.10", true),
    make("v1.12.0-beta.9", true),
    make("v1.11.0-beta.1", true),
    make("dev-aaaaaaa", true, 100),
    make("dev-bbbbbbb", true, 300),
    make("dev-ccccccc", true, 200),
    make("v3.0.0", false, 0, true),
    make("v9.9.9", true),
    make("v9.9.9-beta.1", false),
    make("nightly", true),
  ]

  test("stable picks the newest vX.Y.Z by semver, not by string or list order", () => {
    expect(pickRelease(releases, "stable")?.tag).toBe("v1.10.0")
  })

  test("beta picks the newest beta by number (10 beats 9), ignoring stable releases", () => {
    expect(pickRelease(releases, "beta")?.tag).toBe("v1.12.0-beta.10")
  })

  test("dev picks the most recently published dev-<sha> tag", () => {
    expect(pickRelease(releases, "dev")?.tag).toBe("dev-bbbbbbb")
  })

  test("drafts, mislabelled prerelease flags and unknown tags belong to no channel", () => {
    expect(channelOf(make("v3.0.0", false, 0, true))).toBeUndefined()
    expect(channelOf(make("v9.9.9", true))).toBeUndefined()
    expect(channelOf(make("v9.9.9-beta.1", false))).toBeUndefined()
    expect(channelOf(make("nightly", true))).toBeUndefined()
    expect(channelOf(make("dev-xyz", true))).toBeUndefined()
  })

  test("an empty channel has no release", () => {
    expect(pickRelease([make("v1.0.0", false)], "beta")).toBeUndefined()
  })
})

describe("versions", () => {
  test("a release is newer than its betas, betas order by number", () => {
    const v = (text: string) => parseVersion(text)!
    expect(compareSemver(v("1.12.0"), v("1.12.0-beta.5"))).toBeGreaterThan(0)
    expect(compareSemver(v("1.12.0-beta.2"), v("1.12.0-beta.10"))).toBeLessThan(0)
    expect(compareSemver(v("1.9.9"), v("1.12.0-beta.1"))).toBeLessThan(0)
    expect(compareSemver(v("v1.2.3"), v("1.2.3"))).toBe(0)
  })

  test("a checkout version such as 0.0.1-dev has no comparable version", () => {
    expect(parseVersion("0.0.1-dev")).toBeUndefined()
    expect(parseVersion("dev-abc1234")).toBeUndefined()
  })
})

describe("update decision", () => {
  const stable = make("v1.2.0", false)
  test("newer release is an update, same is up to date, older is ahead (never a downgrade)", () => {
    expect(decide({ current: "1.1.0", release: stable, channel: "stable" })).toBe("update")
    expect(decide({ current: "1.2.0", release: stable, channel: "stable" })).toBe("up-to-date")
    expect(decide({ current: "1.3.0", release: stable, channel: "stable" })).toBe("ahead")
  })

  test("a beta of a newer version is an update for a stable user who switched channel, but a running newer beta is ahead of the stable release", () => {
    expect(decide({ current: "1.2.0", release: make("v1.12.0-beta.1", true), channel: "beta" })).toBe("update")
    expect(decide({ current: "1.12.0-beta.3", release: stable, channel: "stable" })).toBe("ahead")
  })

  test("an uncomparable running version is offered the update", () => {
    expect(decide({ current: "0.0.1-dev", release: stable, channel: "stable" })).toBe("update")
  })

  test("dev builds are identified by tag, allowing a short sha", () => {
    const dev = make("dev-abcdef1234", true)
    expect(decide({ current: "dev-abcdef1", release: dev, channel: "dev" })).toBe("up-to-date")
    expect(decide({ current: "dev-1111111", release: dev, channel: "dev" })).toBe("update")
    expect(decide({ current: "1.0.0", release: dev, channel: "dev" })).toBe("update")
  })
})

describe("platform assets", () => {
  test("names versioned direct binaries for every upgrade platform", () => {
    expect(platformAsset({ os: "darwin", arch: "arm64" }, "v1.2.3")).toBe("mendcode-1.2.3-darwin-arm64")
    expect(platformAsset({ os: "darwin", arch: "x64" }, "v1.2.3-beta.4")).toBe("mendcode-1.2.3-beta.4-darwin-x64")
    expect(platformAsset({ os: "linux", arch: "x64" }, "v1.2.3")).toBe("mendcode-1.2.3-linux-x64")
    expect(platformAsset({ os: "linux", arch: "arm64" }, "dev-abc1234")).toBe("mendcode-dev-abc1234-linux-arm64")
  })

  test("refuses platforms the pipeline does not build", () => {
    for (const platform of [{ os: "win32", arch: "x64" }, { os: "linux", arch: "ia32" }]) {
      try {
        platformAsset(platform, "v1.2.3")
        throw new Error("should have thrown")
      } catch (error) {
        expect(error).toBeInstanceOf(UpgradeError)
        expect((error as UpgradeError).code).toBe("unsupported-platform")
      }
    }
  })

  test("rejects a tag that could escape the asset path", () => {
    expect(() => platformAsset({ os: "linux", arch: "x64" }, "v1.2.3/../../x")).toThrow("unsupported release tag")
  })
})

describe("release list parsing", () => {
  test("keeps well-formed releases, skips malformed entries and non-https assets", () => {
    const parsed = parseReleases([
      { tag_name: "v1.0.0", prerelease: false, published_at: "2026-02-01T00:00:00Z", assets: [{ name: "a", browser_download_url: "https://x.test/a" }, { name: "b", browser_download_url: "http://x.test/b" }, { name: 5 }] },
      { no_tag: true },
      "junk",
      null,
    ])
    expect(parsed).toHaveLength(1)
    expect(parsed[0]!.assets).toEqual([{ name: "a", url: "https://x.test/a" }])
    expect(parsed[0]!.publishedAt).toBe(Date.parse("2026-02-01T00:00:00Z"))
  })

  test("a response that is not an array is an error", () => {
    expect(() => parseReleases({ message: "rate limited" })).toThrow("[UPGRADE]")
  })
})
