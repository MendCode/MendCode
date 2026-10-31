import { describe, expect, test } from "bun:test"
import { ReviewConfig } from "../src/pr-review/config"
import type { EligibilityTrigger, PrFacts } from "../src/pr-review/contracts"
import { eligible, isBot, needsFiles } from "../src/pr-review/eligibility"

const facts = (extra: Partial<PrFacts> = {}): PrFacts => ({
  number: 7, head: "a".repeat(40), base: "b".repeat(40), baseRef: "main", headRef: "feature/x", draft: false, labels: [], author: "ana", authorIsBot: false,
  fork: false, requested: [], assignees: [], ...extra,
})
const config = (raw: Record<string, unknown> = {}) => ReviewConfig.parse(raw)
const decide = (pr: Partial<PrFacts>, raw: Record<string, unknown>, trigger: EligibilityTrigger, login?: string) => eligible({ facts: facts(pr), config: config(raw), trigger, ...(login ? { login } : {}) })

describe("eligibility: modes", () => {
  test("auto reviews opened, synchronize and ready_for_review, each with its reason, and each switch can turn its trigger off", () => {
    expect(decide({}, {}, "opened")).toEqual({ ok: true, reason: "auto: opened" })
    expect(decide({}, {}, "synchronize")).toEqual({ ok: true, reason: "auto: synchronize" })
    expect(decide({}, {}, "ready_for_review")).toEqual({ ok: true, reason: "auto: ready for review" })
    expect(decide({}, { triggers: { synchronize: false } }, "synchronize")).toEqual({ ok: false, reason: "triggers.synchronize is off" })
    expect(decide({}, { triggers: { opened: false } }, "opened")).toEqual({ ok: false, reason: "triggers.opened is off" })
  })

  test("on-request skips every automatic event and takes a review requested from (or a PR assigned to) this reviewer's login", () => {
    const onRequest = { mode: "on-request" }
    for (const trigger of ["opened", "synchronize", "ready_for_review", "label"] as const) expect(decide({}, onRequest, trigger)).toEqual({ ok: false, reason: "on-request: not requested" })
    expect(decide({ requested: ["Obed"] }, onRequest, "requested", "obed")).toEqual({ ok: true, reason: "on-request: review requested from @obed" })
    expect(decide({ assignees: ["obed"] }, onRequest, "requested", "obed")).toMatchObject({ ok: true })
    // A requested trigger that does not name this login (someone else was requested) is not this reviewer's work.
    expect(decide({ requested: ["bob"] }, onRequest, "requested", "obed")).toEqual({ ok: false, reason: "requested: @obed is neither a requested reviewer nor an assignee" })
  })

  test("labels mode needs one of filters.labels.include on the PR (any letter case); an empty include list starts nothing", () => {
    const labels = { mode: "labels", filters: { labels: { include: ["review-me", "ai-review"] } } }
    expect(decide({ labels: ["AI-Review"] }, labels, "label")).toEqual({ ok: true, reason: "labels: label `AI-Review`" })
    expect(decide({ labels: ["AI-Review"] }, labels, "synchronize")).toMatchObject({ ok: true })
    expect(decide({ labels: ["bug"] }, labels, "opened")).toEqual({ ok: false, reason: "labels: none of `review-me`, `ai-review` is on the pull request" })
    expect(decide({ labels: ["anything"] }, { mode: "labels" }, "label")).toEqual({ ok: false, reason: "labels: filters.labels.include is empty, so no label starts a review" })
  })
})

describe("eligibility: drafts and filters", () => {
  test("a draft waits for ready for review unless triggers.drafts; ready_for_review on a non-draft passes", () => {
    expect(decide({ draft: true }, {}, "opened")).toEqual({ ok: false, reason: "draft: waits for ready for review" })
    expect(decide({ draft: true }, {}, "synchronize")).toEqual({ ok: false, reason: "draft: waits for ready for review" })
    expect(decide({ draft: true }, { triggers: { drafts: true } }, "opened")).toMatchObject({ ok: true })
    expect(decide({ draft: false }, {}, "ready_for_review")).toMatchObject({ ok: true })
  })

  test("base branch include and exclude are globs on the base branch; the reason names the branch and the rule", () => {
    expect(decide({ baseRef: "release/1.4" }, { filters: { branches: { include: ["main", "develop"] } } }, "opened")).toEqual({ ok: false, reason: "base branch `release/1.4` not included (filters.branches.include: `main`, `develop`)" })
    expect(decide({ baseRef: "release/1.4" }, { filters: { branches: { include: ["release/*"] } } }, "opened")).toMatchObject({ ok: true })
    expect(decide({ baseRef: "release/1.4" }, { filters: { branches: { exclude: ["release/*"] } } }, "opened")).toEqual({ ok: false, reason: "base branch `release/1.4` excluded by `release/*`" })
  })

  test("authors: include narrows, exclude refuses, bots are skipped unless filters.authors.bots or listed by name", () => {
    expect(decide({ author: "mallory" }, { filters: { authors: { include: ["ana", "bob"] } } }, "opened")).toEqual({ ok: false, reason: "author @mallory not included (filters.authors.include)" })
    expect(decide({ author: "Ana" }, { filters: { authors: { include: ["ana"] } } }, "opened")).toMatchObject({ ok: true })
    expect(decide({ author: "intern" }, { filters: { authors: { exclude: ["intern"] } } }, "opened")).toEqual({ ok: false, reason: "author @intern excluded" })
    expect(decide({ author: "dependabot[bot]", authorIsBot: true }, {}, "opened")).toEqual({ ok: false, reason: "author @dependabot[bot] is a bot (filters.authors.bots is off)" })
    // A bot account GitHub does not mark as one is still recognised by its login.
    expect(decide({ author: "renovate", authorIsBot: false }, {}, "opened")).toMatchObject({ ok: false, reason: expect.stringContaining("is a bot") })
    expect(decide({ author: "dependabot[bot]", authorIsBot: true }, { filters: { authors: { bots: true } } }, "opened")).toMatchObject({ ok: true })
    expect(decide({ author: "dependabot[bot]", authorIsBot: true }, { filters: { authors: { include: ["dependabot[bot]"] } } }, "opened")).toMatchObject({ ok: true })
  })

  test("labels.exclude refuses with the label's name, in every mode", () => {
    for (const mode of ["auto", "on-request", "labels"]) expect(decide({ labels: ["skip-review"], requested: ["obed"] }, { mode, filters: { labels: { include: ["skip-review"], exclude: ["skip-review"] } } }, mode === "on-request" ? "requested" : "opened", "obed")).toEqual({ ok: false, reason: "label `skip-review` excluded" })
  })

  test("paths needs the changed files: one matching glob passes, none refuses, files not listed is said rather than guessed", () => {
    const paths = { filters: { paths: ["src/**/*.ts"] } }
    expect(needsFiles(config(paths))).toBe(true)
    expect(needsFiles(config())).toBe(false)
    expect(decide({ files: ["docs/a.md", "src/api/x.ts"] }, paths, "opened")).toMatchObject({ ok: true })
    expect(decide({ files: ["docs/a.md"] }, paths, "opened")).toEqual({ ok: false, reason: "paths: no changed file matches `src/**/*.ts`" })
    expect(decide({}, paths, "opened")).toEqual({ ok: false, reason: "paths: the changed files were not listed, so filters.paths cannot be checked" })
  })
})

describe("eligibility: explicit requests", () => {
  test("/pr review (the daemon owner's own request) bypasses the mode, drafts, triggers and narrowing filters", () => {
    const strict = { mode: "on-request", triggers: { opened: false }, filters: { branches: { include: ["main"] }, authors: { include: ["ana"] }, paths: ["src/**"] } }
    const pr = { draft: true, baseRef: "develop", author: "dependabot[bot]", authorIsBot: true, files: ["README.md"] }
    expect(decide(pr, strict, "manual")).toEqual({ ok: true, reason: "manual: asked with /pr review" })
  })

  test("an @mendcode comment skips the mode and the trigger switches, but not the draft rule or a narrowing filter", () => {
    const quiet = { mode: "on-request", triggers: { opened: false, synchronize: false } }
    expect(decide({ baseRef: "main", author: "ana" }, quiet, "comment")).toEqual({ ok: true, reason: "comment: asked with @mendcode" })
    expect(decide({ draft: true }, {}, "comment")).toEqual({ ok: false, reason: "draft: waits for ready for review" })
    expect(decide({ draft: true }, { triggers: { drafts: true } }, "comment")).toMatchObject({ ok: true })
    expect(decide({ baseRef: "develop" }, { filters: { branches: { include: ["main"] } } }, "comment")).toEqual({ ok: false, reason: "base branch `develop` not included (filters.branches.include: `main`)" })
    expect(decide({ author: "carol" }, { filters: { authors: { include: ["ana"] } } }, "comment")).toEqual({ ok: false, reason: "author @carol not included (filters.authors.include)" })
    expect(decide({ author: "dependabot[bot]", authorIsBot: true }, {}, "comment")).toEqual({ ok: false, reason: "author @dependabot[bot] is a bot (filters.authors.bots is off)" })
    expect(decide({ files: ["README.md"] }, { filters: { paths: ["src/**"] } }, "comment")).toEqual({ ok: false, reason: "paths: no changed file matches `src/**`" })
  })

  test("but not the repository's exclusions: an excluded label, base branch or author stays excluded when asked", () => {
    expect(decide({ labels: ["skip-review"] }, { filters: { labels: { exclude: ["skip-review"] } } }, "comment")).toEqual({ ok: false, reason: "label `skip-review` excluded" })
    expect(decide({ baseRef: "release/2" }, { filters: { branches: { exclude: ["release/*"] } } }, "manual")).toEqual({ ok: false, reason: "base branch `release/2` excluded by `release/*`" })
    expect(decide({ author: "intern" }, { filters: { authors: { exclude: ["INTERN"] } } }, "manual")).toEqual({ ok: false, reason: "author @intern excluded" })
  })

  test("the first reason is the most decisive: an exclusion is named before the mode, the mode before a draft", () => {
    expect(decide({ draft: true, labels: ["skip-review"] }, { mode: "on-request", filters: { labels: { exclude: ["skip-review"] } } }, "opened")).toEqual({ ok: false, reason: "label `skip-review` excluded" })
    expect(decide({ draft: true }, { mode: "on-request" }, "opened")).toEqual({ ok: false, reason: "on-request: not requested" })
  })
})

describe("bots", () => {
  test("GitHub's type Bot, an app login and well-known bot accounts are bots; people and lookalikes are not", () => {
    expect(isBot("anyone", "Bot")).toBe(true)
    expect(isBot("my-app[bot]")).toBe(true)
    expect(isBot("Dependabot")).toBe(true)
    expect(isBot("github-actions")).toBe(true)
    expect(isBot("ana", "User")).toBe(false)
    expect(isBot("robotics-fan")).toBe(false)
    expect(isBot(undefined)).toBe(false)
  })
})
