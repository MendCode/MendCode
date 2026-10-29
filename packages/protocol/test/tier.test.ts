import { describe, expect, test } from "bun:test"
import { EXPERIMENTAL_FLAGS } from "../src/constants"
import { Settings } from "../src/queries"
import { FEATURES, FEATURE_IDS, MINIMALIST_SLASH, TIERS, TIER_BUNDLES, effectiveSettings, slashTier, featureOn, featureState, tierDiff, tierIncludes, tierRows, type TierSettings } from "../src/tier-data"

test("lossless storage maintenance is available in every tier but runs only by its explicit command", () => {
  expect(FEATURES.storage_compact).toMatchObject({ tier: "minimalist", mode: "permit", cost: [], own: "storage --compact --offline --dir DATA" })
  for (const tier of TIERS) expect(featureOn({ tier }, "storage_compact")).toBe(true)
})

describe("feature manifest", () => {
  test("unverified optional adapters cannot be listed or enabled in any tier", () => {
    for (const id of ["opencode", "cursor"]) {
      expect(FEATURE_IDS).not.toContain(id)
      expect(Object.hasOwn(FEATURES, id)).toBe(false)
      expect(Settings.safeParse({ features: { [id]: true } }).success).toBe(false)
      for (const tier of TIERS) expect(tierRows({ tier }).some((row) => row.id === id)).toBe(false)
    }
  })

  test("every feature declares a tier, a cost list, its own switch and a doc", () => {
    expect(Object.keys(FEATURES).sort()).toEqual([...FEATURE_IDS].sort())
    for (const id of FEATURE_IDS) {
      const spec = FEATURES[id]
      expect(TIERS).toContain(spec.tier)
      expect(spec.label.length).toBeGreaterThan(2)
      expect(spec.own.length).toBeGreaterThan(2)
      expect(spec.doc).toMatch(/^docs\/.+\.md$/)
    }
  })

  test("a feature's experimental flag is a real flag, and kernel features are minimalist and safe-mode gated", () => {
    const flags = new Set<string>(EXPERIMENTAL_FLAGS.map((flag) => flag.id))
    for (const id of FEATURE_IDS) {
      const spec = FEATURES[id]
      if (spec.flag) expect(flags.has(spec.flag)).toBe(true)
      if (spec.mode === "kernel") {
        expect(spec.tier).toBe("minimalist")
        expect(spec.safe).toBe(true)
      }
    }
  })

  test("the user's tiers: minimalist has no MCP, graph, sub-agents, JEV or pets; balanced adds the savings tools; full adds the rest", () => {
    const rows = Object.fromEntries(tierRows({}).map((row) => [row.id, row.perTier]))
    expect(rows.mcp).toEqual([false, false, true])
    expect(rows.jev).toEqual([false, false, true])
    expect(rows.codegraph).toEqual([false, true, true])
    expect(rows.subagents).toEqual([false, true, true])
    expect(rows.pets).toEqual([false, false, true])
    expect(rows.extensions).toEqual([true, true, true])
    // Auto-resume at a usage limit is an essential: armed in every tier (and with no tier), and a user override can still turn it off.
    expect(rows.usage_resume).toEqual([true, true, true])
    expect(featureOn({}, "usage_resume")).toBe(true)
    expect(featureOn({ tier: "minimalist" }, "usage_resume")).toBe(true)
    expect(featureOn({ tier: "minimalist", features: { usage_resume: false } }, "usage_resume")).toBe(false)
    expect(rows.threads).toEqual([false, true, true])
    expect(tierDiff("minimalist", "balanced")).toEqual({ added: ["package_tools", "codegraph", "subagents", "script_workflows", "computer", "threads", "pr_watch", "pr_review", "output_filters", "forecast", "review_order", "session_meta", "limit_checkpoint", "graph_context", "handoff", "instruction_includes", "package_capabilities", "caveman", "webfetch_modes", "official_packages", "web_routing", "panel", "panel_models", "file_viewer", "aux_tools", "harness_tools", "ui_tool", "orientation", "git_hub", "git_actions", "compact_notice", "cheap_subagents", "claude_compact", "one_tree"], removed: [] })
    // The project backlog is the full tier's alone: no tool and no prompt text, so it costs a request nothing.
    expect(tierDiff("balanced", "full").added).toContain("backlog")
    expect(tierDiff("balanced", "full").added).toContain("voice")
    expect(rows.backlog).toEqual([false, false, true])
    expect(rows.compact_notice).toEqual([false, true, true])
    expect(tierDiff("full", "balanced").removed).toContain("mcp")
    expect(tierDiff("balanced", "balanced")).toEqual({ added: [], removed: [] })
  })

  test("the pi engine is allowed by the full tier only, safe mode and features.pi decide the rest", () => {
    const rows = Object.fromEntries(tierRows({}).map((row) => [row.id, row.perTier]))
    expect(rows.pi).toEqual([false, false, true])
    expect(FEATURES.pi.mode).toBe("permit")
    expect(featureOn({ tier: "balanced" }, "pi")).toBe(false)
    expect(featureOn({ tier: "full" }, "pi")).toBe(true)
    expect(featureOn({ tier: "full" }, "pi", { safeMode: true })).toBe(false)
    expect(featureOn({ tier: "minimalist", features: { pi: true } }, "pi")).toBe(true)
    expect(featureOn({ tier: "full", features: { pi: false } }, "pi")).toBe(false)
    // Allowing it adds no tool and no setting; listing its models needs the user's pi.json or features.pi.
    expect(Object.keys(effectiveSettings<TierSettings>({ tier: "balanced" }).tools ?? {}).filter((tool) => tool.includes("pi"))).toEqual([])
  })

  test("bundles reuse the existing names: chat view, prompt mode and density are values those settings already take", () => {
    expect(TIER_BUNDLES.minimalist).toMatchObject({ view: "minimal", promptMode: "minimal", density: "compact", hideRightSidebar: true, processMode: "auto" })
    expect(TIER_BUNDLES.balanced).toMatchObject({ view: "balanced", promptMode: "focus", processMode: "auto" })
    expect(TIER_BUNDLES.full).toMatchObject({ view: "full", promptMode: "full", processMode: "auto" })
    expect(Settings.safeParse({ view: TIER_BUNDLES.balanced.view }).success).toBe(true)
  })
})

describe("featureState", () => {
  test("panel presets require balanced; galaxy is a full-tier permission with its own opt-in command", () => {
    expect(FEATURES.panel).toMatchObject({ tier: "balanced", mode: "permit", own: "/panel" })
    expect(FEATURES.panel_orbit).toMatchObject({ label: "Session galaxy", tier: "full", mode: "permit", own: "/panel galaxy" })
    for (const tier of TIERS) {
      expect(featureOn({ tier }, "panel")).toBe(tier !== "minimalist")
      expect(featureOn({ tier }, "panel_orbit")).toBe(tier === "full")
    }
    expect(featureOn({ tier: "full", features: { panel_orbit: false } }, "panel_orbit")).toBe(false)
  })
  test("without a tier every feature keeps today's default and nothing changes", () => {
    const settings: TierSettings = {}
    for (const id of FEATURE_IDS) if (!FEATURES[id].optIn) expect(featureState(settings, id)).toEqual({ on: FEATURES[id].legacy, why: "legacy" })
    // An opt-in feature is the exception: off in every tier until `features.<id>` is true; its tools stay out. Without a tier it keeps today's default.
    for (const id of FEATURE_IDS) if (FEATURES[id].optIn) {
      for (const tier of [undefined, "minimalist", "balanced", "full"] as const) expect(featureOn({ tier }, id)).toBe(tier === undefined && FEATURES[id].legacy)
      expect(featureState({ tier: "minimalist", features: { [id]: true } }, id)).toEqual({ on: true, why: "override" })
    }
    expect(effectiveSettings(settings)).toEqual({ tools: { "computer_*": false } })
    expect(effectiveSettings({ features: { computer: true } } as TierSettings).tools).toBeUndefined()
    expect(tierIncludes(undefined, "full")).toBe(true)
  })

  test("precedence: safe mode, then features override, then the feature's own flag, then the tier", () => {
    expect(featureState({ tier: "full" }, "mcp")).toEqual({ on: true, why: "tier" })
    expect(featureState({ tier: "balanced" }, "mcp")).toEqual({ on: false, why: "tier" })
    expect(featureState({ tier: "balanced", features: { mcp: true } }, "mcp")).toEqual({ on: true, why: "override" })
    expect(featureState({ tier: "full", features: { mcp: false } }, "mcp")).toEqual({ on: false, why: "override" })
    expect(featureState({ tier: "full", features: { mcp: true } }, "mcp", { safeMode: true })).toEqual({ on: false, why: "safe-mode" })
    expect(featureState({ tier: "full", experimental: { reasoning_auto: false } }, "jev")).toEqual({ on: false, why: "setting" })
    expect(featureState({ tier: "minimalist", experimental: { reasoning_auto: true } }, "jev")).toEqual({ on: true, why: "setting" })
    expect(featureState({}, "jev")).toEqual({ on: false, why: "legacy" })
    expect(featureState({ tier: "full" }, "jev")).toEqual({ on: true, why: "tier" })
  })

  test("kernel features ignore overrides and follow only safe mode", () => {
    expect(featureOn({ tier: "minimalist", features: { hooks: false } }, "hooks")).toBe(true)
    expect(featureOn({}, "hooks", { safeMode: true })).toBe(false)
    expect(featureOn({}, "extensions", { safeMode: true })).toBe(false)
    expect(featureOn({}, "packages", { safeMode: true })).toBe(false)
    expect(featureOn({}, "mcp", { safeMode: true })).toBe(false)
    expect(featureOn({}, "codegraph", { safeMode: true })).toBe(true)
  })
})

describe("effectiveSettings", () => {
  test("a tier below a feature denies its tools; the user's own tools entry still wins", () => {
    const minimal = effectiveSettings({ tier: "minimalist", tools: { "graph_map": true } } as TierSettings)
    expect(minimal.tools).toMatchObject({ "mcp__*": false, "task": false, "graph_*": false, "code_search": false, "computer_*": false, "browser": false, "graph_map": true })
    const balanced = effectiveSettings({ tier: "balanced" } as TierSettings)
    expect(balanced.tools?.["graph_*"]).toBeUndefined()
    expect(balanced.tools?.["mcp__*"]).toBe(false)
    const full = effectiveSettings({ tier: "full" } as TierSettings)
    expect(full.tools).toEqual({ "computer_*": false })
  })

  test("flags follow the feature: JEV on in full, opt-in flags off below their tier, nothing is written back", () => {
    const input = { tier: "full", experimental: { code_mode: true } } as TierSettings
    const full = effectiveSettings(input)
    expect(full.experimental).toEqual({ code_mode: true, reasoning_auto: true, thread_tools: true, tool_discovery: true })
    expect(input.experimental).toEqual({ code_mode: true })
    const balanced = effectiveSettings({ tier: "balanced", experimental: { code_mode: true, snip: true } } as TierSettings)
    expect(balanced.experimental).toMatchObject({ code_mode: false, snip: false, reasoning_auto: false })
    const forced = effectiveSettings({ tier: "balanced", features: { code_mode: true }, experimental: { code_mode: true } } as TierSettings)
    expect(forced.experimental?.code_mode).toBe(true)
  })

  test("thread tools are off without a tier, on from balanced, and off again in minimalist unless the flag says otherwise", () => {
    expect(featureState({}, "threads")).toEqual({ on: false, why: "legacy" })
    expect(effectiveSettings({} as TierSettings).experimental).toBeUndefined()
    expect(effectiveSettings({ tier: "balanced" } as TierSettings).experimental).toMatchObject({ thread_tools: true })
    expect(effectiveSettings({ tier: "minimalist" } as TierSettings).experimental).toMatchObject({ thread_tools: false })
    expect(effectiveSettings({ tier: "minimalist" } as TierSettings).tools).toMatchObject({ threads: false })
    expect(featureState({ tier: "minimalist", experimental: { thread_tools: true } }, "threads")).toEqual({ on: true, why: "setting" })
    expect(featureState({ tier: "full", experimental: { thread_tools: false } }, "threads")).toEqual({ on: false, why: "setting" })
  })

  test("voice and pet settings are switched off only where they exist", () => {
    const withVoice = effectiveSettings({ tier: "minimalist", voice: { enabled: true, language: "es" }, pet: "user:fox" } as TierSettings & Record<string, unknown>) as Record<string, unknown>
    expect(withVoice.voice).toEqual({ enabled: false, language: "es" })
    expect("pet" in withVoice).toBe(false)
    const bare = effectiveSettings({ tier: "minimalist" } as TierSettings) as Record<string, unknown>
    expect("voice" in bare).toBe(false)
    expect("pet" in bare).toBe(false)
  })

  test("safe mode alone turns MCP off without a tier", () => {
    const safe = effectiveSettings({} as TierSettings, { safeMode: true })
    // Safe mode keeps the chat-side package manager off too: it installs and enables code the session would then load.
    expect(safe.tools).toEqual({ "mcp__*": false, "mcp_resource_*": false, packages: false, session_meta: false, "computer_*": false })
  })
})

describe("settings schema", () => {
  test("MCP discovery is a full-tier default with authoritative opt-outs", () => {
    expect(effectiveSettings({ tier: "full" } as TierSettings).experimental?.tool_discovery).toBe(true)
    for (const settings of [{ tier: "balanced" }, { tier: "minimalist" }, {}, { tier: "full", features: { mcp: false } }, { tier: "full", features: { tool_discovery: false } }]) expect(effectiveSettings(settings as TierSettings).experimental?.tool_discovery).not.toBe(true)
    expect(effectiveSettings({ tier: "full", experimental: { tool_discovery: false } } as TierSettings).experimental?.tool_discovery).toBe(false)
    expect(effectiveSettings({ tier: "full" } as TierSettings, { safeMode: true }).experimental?.tool_discovery).not.toBe(true)
  })
  test("tier and features are accepted, unknown values are not", () => {
    expect(Settings.safeParse({ tier: "balanced", features: { mcp: true, jev: false } }).success).toBe(true)
    expect(Settings.safeParse({ tier: "tiny" }).success).toBe(false)
    expect(Settings.safeParse({ features: { nonsense: true } }).success).toBe(false)
    expect(Settings.safeParse({ features: { mcp: "yes" } }).success).toBe(false)
  })
})

describe("slash commands by tier", () => {
  test("minimalist lists twenty-one commands, fewer than pi's twenty-four; every other one is balanced", () => {
    expect(MINIMALIST_SLASH).toHaveLength(21)
    expect(new Set(MINIMALIST_SLASH).size).toBe(21)
    for (const name of MINIMALIST_SLASH) expect(slashTier(name)).toBe("minimalist")
    expect(slashTier("review")).toBe("balanced")
  })
})

describe("a guessed profile key", () => {
  test("is refused with the nearest real names, so a model that guessed hideTopbar or panel_header can retry", async () => {
    const { tuiProblems } = await import("../src/tui-data")
    expect(tuiProblems({ hideTopbar: false })[0]).toContain("did you mean showTopbar")
    expect(tuiProblems({ panel_header: false })[0]).toContain("did you mean panelHeader")
    expect(tuiProblems({ zzzz: 1 })[0]).toBe('unknown field: zzzz (find the key: customize_ui {"action":"keys","query":"<words>"}; every part and its key: mendcode docs screen-parts)')
    expect(tuiProblems({ showTopbar: false, panelHeader: false })).toEqual([])
  })
})
