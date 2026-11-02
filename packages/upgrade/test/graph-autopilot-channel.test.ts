import { afterEach, describe, expect, test } from "bun:test"
import { FEATURES, featureOn, featureState, setBuildChannel, tierDiff, type BuildChannel } from "../../protocol/src/tier-data"
import { buildChannelOf } from "../src/releases"

afterEach(() => setBuildChannel(undefined))

const VERSIONS: Record<string, BuildChannel> = {
  "1.4.0": "stable",
  "1.4.0-beta.2": "beta",
  "1.4.0-nightly.20261101.3": "nightly",
  "dev-1a2b3c4d": "dev",
  "0.0.1-dev": "local",
}

describe("graph_autopilot is on by default only in nightly, dev and local builds", () => {
  test("the channel comes from the binary's version", () => {
    for (const [version, channel] of Object.entries(VERSIONS)) expect(buildChannelOf(version)).toBe(channel)
  })

  test("full tier: on in nightly, dev and local; off in beta and stable", () => {
    for (const [version, channel] of Object.entries(VERSIONS)) {
      const on = channel === "nightly" || channel === "dev" || channel === "local"
      expect(featureOn({ tier: "full" }, "graph_autopilot", { channel: buildChannelOf(version) })).toBe(on)
      setBuildChannel(buildChannelOf(version))
      expect(featureOn({ tier: "full" }, "graph_autopilot")).toBe(on)
    }
  })

  test("a process that never told its channel leaves it off", () => {
    expect(featureOn({ tier: "full" }, "graph_autopilot")).toBe(false)
  })

  test("minimalist, balanced and no tier get nothing in any channel", () => {
    for (const channel of ["nightly", "dev", "local", "beta", "stable"] as const) {
      expect(featureOn({ tier: "minimalist" }, "graph_autopilot", { channel })).toBe(false)
      expect(featureOn({ tier: "balanced" }, "graph_autopilot", { channel })).toBe(false)
      expect(featureOn({}, "graph_autopilot", { channel })).toBe(false)
    }
  })

  test("/tier graph_autopilot on turns it on in beta and stable, and off turns it off in nightly", () => {
    expect(featureState({ tier: "full", features: { graph_autopilot: true } }, "graph_autopilot", { channel: "stable" })).toEqual({ on: true, why: "override" })
    expect(featureOn({ tier: "full", features: { graph_autopilot: true } }, "graph_autopilot", { channel: "beta" })).toBe(true)
    expect(featureOn({ tier: "full", features: { graph_autopilot: false } }, "graph_autopilot", { channel: "nightly" })).toBe(false)
  })

  test("it costs one prompt line, is declared for full, and a tier change only reports it where it applies", () => {
    expect(FEATURES.graph_autopilot).toMatchObject({ tier: "full", mode: "tier", cost: ["prompt"], channels: ["nightly", "dev", "local"] })
    setBuildChannel("stable")
    expect(tierDiff("balanced", "full").added).not.toContain("graph_autopilot")
    setBuildChannel("nightly")
    expect(tierDiff("balanced", "full").added).toContain("graph_autopilot")
  })
})
