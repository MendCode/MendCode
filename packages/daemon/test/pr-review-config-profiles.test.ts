import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createProfileStore, PROFILE_HISTORY_LIMIT, profilePath } from "../src/pr-review/profile-store"

const temps: string[] = []
afterEach(() => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const dataDir = () => { const dir = mkdtempSync(path.join(tmpdir(), "pr-review-profiles-")); temps.push(dir); return dir }
const key = { provider: "github" as const, repo: "acme/widgets", login: "alice" }

describe("personal profile store", () => {
  test("the file lives at <dataDir>/pr-review/profiles/<provider>/<owner>/<repo>/<login>.json, 0600 in 0700 directories", () => {
    const dir = dataDir()
    const store = createProfileStore({ dataDir: dir, now: () => 1_000 })
    store.save(key, { config: { profile: "quiet" }, summary: "quieter" })
    const file = path.join(dir, "pr-review", "profiles", "github", "acme", "widgets", "alice.json")
    expect(store.path(key)).toBe(file)
    expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700)
    expect(readdirSync(path.dirname(file))).toEqual(["alice.json"])
    expect(JSON.parse(readFileSync(file, "utf8")).versions[0]).toEqual({ version: 1, at: 1_000, summary: "quieter", config: { profile: "quiet" } })
  })

  test("every segment is checked so no provider, repository or login leaves the data directory", () => {
    const dir = dataDir()
    for (const bad of [{ ...key, repo: "../etc" }, { ...key, repo: "acme/../x" }, { ...key, repo: "acme" }, { ...key, login: "../root" }, { ...key, login: "a/b" }, { ...key, provider: "bitbucket" as never }]) expect(() => profilePath(dir, bad)).toThrow(RangeError)
    expect(profilePath(dir, { provider: "gitlab", repo: "group/sub/project", login: "bob.smith" })).toBe(path.join(dir, "pr-review", "profiles", "gitlab", "group", "sub", "project", "bob.smith.json"))
  })

  test("each save is a new version; history keeps the newest 50 with summaries and times, newest first", () => {
    let clock = 0
    const store = createProfileStore({ dataDir: dataDir(), now: () => ++clock })
    for (let index = 1; index <= PROFILE_HISTORY_LIMIT + 5; index++) store.save(key, { config: { cap: (index % 30) + 1 }, summary: `cap ${index}` })
    const history = store.history(key)
    expect(history).toHaveLength(PROFILE_HISTORY_LIMIT)
    expect(history[0]).toEqual({ version: 55, at: 55, summary: "cap 55" })
    expect(history.at(-1)!.version).toBe(6)
    expect(store.current(key)).toMatchObject({ exists: true, version: 55, config: { cap: 26 } })
  })

  test("revert makes a new version equal to the old one; a version no longer kept is refused", () => {
    const store = createProfileStore({ dataDir: dataDir(), now: () => 5 })
    store.save(key, { config: { profile: "quiet" }, summary: "one" })
    store.save(key, { config: { profile: "strict", cap: 12 }, summary: "two" })
    const reverted = store.revert(key, 1)
    expect(reverted).toEqual({ version: 3, at: 5, summary: "revert to version 1", config: { profile: "quiet" } })
    expect(store.current(key).config).toEqual({ profile: "quiet" })
    expect(store.history(key).map((entry) => entry.version)).toEqual([3, 2, 1])
    expect(() => store.revert(key, 9)).toThrow(RangeError)
  })

  test("an invalid layer is refused with its key path and nothing is written", () => {
    const dir = dataDir()
    const store = createProfileStore({ dataDir: dir })
    expect(() => store.save(key, { config: { budget: { tokens_per_pr: "lots" }, colour: "red" }, summary: "bad" })).toThrow(/personal budget\.tokens_per_pr:[\s\S]*personal colour: unknown key/)
    expect(existsSync(store.path(key))).toBe(false)
    expect(store.current(key)).toEqual({ exists: false, version: 0, config: {} })
  })

  test("a damaged file is a problem, not an empty profile, and is moved aside before the next save", () => {
    const dir = dataDir()
    const store = createProfileStore({ dataDir: dir, now: () => 77 })
    store.save(key, { config: { cap: 3 }, summary: "first" })
    writeFileSync(store.path(key), "{ not json")
    expect(store.current(key).problem).toContain("cannot be read")
    store.save(key, { config: { cap: 4 }, summary: "again" })
    expect(existsSync(`${store.path(key)}.damaged-77`)).toBe(true)
    expect(store.current(key)).toMatchObject({ version: 1, config: { cap: 4 } })
  })
})
