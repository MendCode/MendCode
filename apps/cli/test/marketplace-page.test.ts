import { describe, expect, test } from "bun:test"
import type { PackageCatalogEntry, PackageCatalogReport, PackageInfo } from "@mendcode/protocol"
import { catalogMatches, createMarketplaceState, entryKinds, entryStatus, kindFilters, marketplaceHints, marketplaceKey, newerVersion, renderMarketplacePage, type MarketplaceState } from "../src/view/marketplace-page"
import { textWidth } from "../src/view/wrap"

const plain = (rows: ReturnType<typeof renderMarketplacePage>) => rows.map((line) => line.map((span) => span.text).join(""))
const entry = (name: string, extra: Partial<PackageCatalogEntry> = {}): PackageCatalogEntry => ({ name, version: "1.0.0", description: `${name} profile`, sourceId: "team", location: `/catalog/${name}`, tags: [], state: "available", contents: { tools: 0, skills: 0, commands: 0, themes: 0, mcp: false }, ...extra })
const report = (entries: PackageCatalogEntry[], issues: string[] = []): PackageCatalogReport => ({ entries, issues, query: "" })
const installed = (name: string, version: string, extra: Partial<PackageInfo> = {}): PackageInfo => ({ name, key: `user:${name}`, source: "user", dir: `/data/packages/${name}`, enabled: true, manifest: { name, version, description: name }, contents: { tools: 0, skills: 0, commands: 0, themes: 0, mcp: false }, ...extra })

describe("marketplace states in words", () => {
  test("offline before the first answer says the daemon is offline and fills in on reconnect", () => {
    const text = plain(renderMarketplacePage({ state: createMarketplaceState(), sources: [], error: "", offline: true, width: 100, height: 30 })).join("\n")
    expect(text).toContain("The daemon is offline. The catalog fills in when the terminal reconnects.")
    expect(text).toContain("daemon offline")
  })

  test("an empty catalog says what it lists and how to add a source; nothing invented", () => {
    const text = plain(renderMarketplacePage({ state: createMarketplaceState(), report: report([]), sources: [], error: "", width: 100, height: 30 })).join("\n")
    expect(text).toContain("No profiles in the catalog yet.")
    expect(text).toContain("s opens sources")
    expect(text).toContain("0 profiles")
  })

  test("loading says so, and a source that could not be read is listed under the profiles", () => {
    expect(plain(renderMarketplacePage({ state: createMarketplaceState(), sources: [], error: "", width: 100, height: 30 })).join("\n")).toContain("reading the catalog…")
    const text = plain(renderMarketplacePage({ state: createMarketplaceState(), report: report([entry("one")], ["hub: hub has not been fetched; run refresh"]), sources: [], error: "", width: 100, height: 30 })).join("\n")
    expect(text).toContain("! hub: hub has not been fetched: s, then u fetches it")
  })

  test("a failed action keeps the list and puts the error after the tabs", () => {
    const rows = plain(renderMarketplacePage({ state: createMarketplaceState(), report: report([entry("one")]), sources: [], error: "source is disabled: hub", width: 120, height: 30 }))
    expect(rows[1]).toContain("last action failed · source is disabled: hub")
    expect(rows.join("\n")).toContain("one")
  })
})

describe("marketplace rows", () => {
  test("kinds come from what the profile carries; a remote entry is remote until installed", () => {
    expect(entryKinds(entry("a", { contents: { tools: 1, skills: 2, commands: 0, themes: 1, mcp: true } }))).toEqual(["themes", "tools", "skills", "mcp"])
    expect(entryKinds(entry("r", { remote: true }))).toEqual(["remote"])
    expect(entryKinds(entry("e"))).toEqual([])
    expect(kindFilters(report([entry("a", { contents: { tools: 0, skills: 1, commands: 0, themes: 0, mcp: false } }), entry("b", { remote: true })])).map((filter) => `${filter.id} ${filter.count}`)).toEqual(["all 2", "skills 1", "remote 1"])
  })

  test("the search matches every word in name, title, description, tags, source and author", () => {
    const entries = [entry("review-kit", { title: "Review Kit", tags: ["testing"], author: "Acme" }), entry("terminal-kit", { sourceId: "hub" })]
    expect(catalogMatches(report(entries), "acme testing").map((item) => item.name)).toEqual(["review-kit"])
    expect(catalogMatches(report(entries), "hub").map((item) => item.name)).toEqual(["terminal-kit"])
    expect(catalogMatches(report(entries), "").length).toBe(2)
  })

  test("versions compare by their numbers; anything else is never called newer", () => {
    expect(newerVersion("1.2.0", "1.0.0")).toBe(true)
    expect(newerVersion("1.10.0", "1.9.9")).toBe(true)
    expect(newerVersion("1.0.0", "1.0.0")).toBe(false)
    expect(newerVersion("0.9.0", "1.0.0")).toBe(false)
    expect(newerVersion("next", "1.0.0")).toBe(false)
  })

  test("the badge: update when the catalog is newer, on or off for the installed copy, nothing when not installed", () => {
    expect(entryStatus(entry("kit", { version: "2.0.0" }), [installed("kit", "1.0.0")], "user")).toMatchObject({ badge: "update", update: true, inScope: true })
    expect(entryStatus(entry("kit"), [installed("kit", "1.0.0", { enabled: false })], "user")).toMatchObject({ badge: "off", update: false })
    expect(entryStatus(entry("kit"), [], "user")).toMatchObject({ badge: "", update: false })
    // The local catalog lists the installed copy itself: never an update of itself.
    expect(entryStatus(entry("kit", { version: "2.0.0", sourceId: "local" }), [installed("kit", "1.0.0")], "user").update).toBe(false)
    expect(entryStatus(entry("kit", { problem: "catalog name/version differs" }), [], "user").badge).toBe("problem")
  })
})

describe("marketplace keys and header", () => {
  const data = { report: report([entry("one"), entry("two", { contents: { tools: 0, skills: 0, commands: 0, themes: 1, mcp: false } })]), installed: [] as PackageInfo[], sources: [] }
  const press = (state: MarketplaceState, ...keys: string[]) => keys.reduce((current, key) => marketplaceKey(current, key, data).state, state)

  test("the header is enter install · / search · tab kind · ? keys · esc back, and esc names what it does", () => {
    expect(marketplaceHints(createMarketplaceState(), data)).toBe("enter install · / search · tab kind · ? keys · esc back")
    expect(marketplaceHints({ ...createMarketplaceState(), query: "on" }, data)).toEndWith("esc clear")
    expect(marketplaceHints({ ...createMarketplaceState(), confirm: { kind: "remove", name: "one", scope: "user" } }, data)).toBe("d/y confirm · esc cancel")
  })

  test("enter asks for a preview, never an install; keys never change the state they were given", () => {
    const state = createMarketplaceState()
    const result = marketplaceKey(state, "\r", data)
    expect(result.action).toMatchObject({ type: "preview", entry: { name: "one" } })
    expect(state).toEqual(createMarketplaceState())
  })

  test("the selection follows its profile when the list changes under it", () => {
    const state = press(createMarketplaceState(), "j")
    expect(state.selectedId).toBe("team/two")
    const reordered = { ...data, report: report([entry("zero"), entry("one"), entry("two")]) }
    expect(marketplaceKey(state, "\r", reordered).action).toMatchObject({ type: "preview", entry: { name: "two" } })
  })

  test("tab filters by kind and wraps; a filter with no match says tab shows another kind", () => {
    const themes = press(createMarketplaceState(), "\t")
    expect(themes.kind).toBe("themes")
    expect(press(themes, "\t").kind).toBe("all")
    expect(press(createMarketplaceState(), "\x1b[Z").kind).toBe("themes")
  })

  test("1 and 2 ask for the other tabs; ? opens and closes the keys", () => {
    expect(marketplaceKey(createMarketplaceState(), "1", data).action).toEqual({ type: "tab", tab: 0 })
    expect(marketplaceKey(createMarketplaceState(), "2", data).action).toEqual({ type: "tab", tab: 1 })
    expect(press(createMarketplaceState(), "?").keys).toBe(true)
    expect(press(createMarketplaceState(), "?", "?").keys).toBe(false)
  })

  test("both kind-filter directions close a cancelled install preview", () => {
    const preview = { entry: data.report.entries[0]!, scope: "user" as const, action: "install" as const, problems: [] }
    const inspecting = { ...createMarketplaceState(), confirm: { kind: "install" as const, name: "one", sourceId: "team" } }
    const cancelled = marketplaceKey(inspecting, "\x1b", { ...data, preview }).state
    expect(cancelled.confirm).toBeUndefined()
    for (const key of ["\t", "\x1b[Z"]) {
      const result = marketplaceKey(cancelled, key, { ...data, preview })
      expect(result.state.kind).toBe("themes")
      expect(result.state.selectedId).toBeUndefined()
      expect(result.action).toEqual({ type: "close-preview" })
    }
  })

  test("sources keep the selected row and removal question visible in every layout", () => {
    const sources = Array.from({ length: 30 }, (_, i) => ({ id: `source-${String(i).padStart(2, "0")}`, location: `/catalog/${i}`, enabled: true, builtin: false }))
    for (const [width, height] of [[60, 20], [100, 30], [160, 45]] as const) {
      let state: MarketplaceState = { ...createMarketplaceState(), mode: "sources" }
      for (let i = 0; i < sources.length; i++) {
        const render = () => plain(renderMarketplacePage({ state, sources, error: "", width, height })).join("\n")
        expect(render()).toContain(`› ${sources[i]!.id}`)
        state = marketplaceKey(state, "j", { sources }).state
      }
      state = marketplaceKey(state, "d", { sources }).state
      const text = plain(renderMarketplacePage({ state, sources, error: "", width, height })).join("\n")
      expect(text).toContain("› source-29")
      expect(text).toContain("remove the source source-29?")
      state = marketplaceKey(state, "\x1b", { sources }).state
      for (let i = sources.length - 1; i >= 0; i--) {
        expect(plain(renderMarketplacePage({ state, sources, error: "", width, height })).join("\n")).toContain(`› ${sources[i]!.id}`)
        state = marketplaceKey(state, "k", { sources }).state
      }
    }
  })

  test("is exactly width x height with no overflow at every size, in every state", () => {
    const states: MarketplaceState[] = [
      createMarketplaceState(),
      { ...createMarketplaceState(), keys: true },
      { ...createMarketplaceState(), editing: "query", input: "on", query: "on" },
      { ...createMarketplaceState(), confirm: { kind: "install", name: "one", sourceId: "team" } },
      { ...createMarketplaceState(), mode: "sources" },
      { ...createMarketplaceState(), mode: "sources", editing: "location", draftId: "hub", input: "https://hub.example/index.json" },
    ]
    for (const [width, height] of [[40, 12], [60, 20], [100, 30], [160, 45], [220, 60]] as const) {
      for (const state of states) {
        const rows = plain(renderMarketplacePage({ state, report: data.report, installed: [installed("one", "0.9.0")], sources: [{ id: "local", location: "/work", enabled: true, builtin: true }], error: "", width, height }))
        expect(rows).toHaveLength(height)
        for (const row of rows) expect(textWidth(row)).toBeLessThanOrEqual(width)
      }
    }
  })
})
