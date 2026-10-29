import { describe, expect, test } from "bun:test"
import type { PackageInfo, PackagesReport } from "@mendcode/protocol"
import type { Line } from "../src/ui/theme"
import { createPackagesPageState, describeContents, packagesPageKey, renderPackagesPage, type PackagesPageState } from "../src/view/packages-page"
import { textWidth } from "../src/view/wrap"

const plain = (lines: Line[]) => lines.map((line) => line.map((span) => span.text).join(""))

const NOW = 1_800_000_000_000

function pkg(name: string, patch: Partial<PackageInfo> = {}, source: PackageInfo["source"] = "user"): PackageInfo {
  return {
    name,
    source,
    key: `${source}:${name}`,
    dir: `/home/me/.mendcode/packages/${name}`,
    enabled: true,
    manifest: { name, version: "1.2.0", description: `The ${name} package` },
    install: { source: `github:acme/${name}`, commit: "0123456789abcdef", installedAt: NOW - 3 * 24 * 3600 * 1000 },
    contents: { tools: 2, skills: 1, commands: 3, themes: 1, mcp: true },
    ...patch,
  }
}

const PACKAGES: PackageInfo[] = [
  pkg("toolbox", { manifest: { name: "toolbox", version: "1.2.0", description: "Handy tools for everyday work", author: "Acme", homepage: "https://example.com/toolbox", license: "MIT" } }),
  pkg("quiet", { enabled: false, contents: { tools: 0, skills: 2, commands: 0, themes: 0, mcp: false } }, "project"),
  pkg("broken", { problem: "manifest.json: version must be a string; the folder cannot be loaded until it is fixed", manifest: undefined, install: undefined, contents: { tools: 0, skills: 0, commands: 0, themes: 0, mcp: false } } as Partial<PackageInfo>),
]
const report = (packages = PACKAGES): PackagesReport => ({ directory: "/repo/app", packages })
const render = (state: PackagesPageState, width = 100, height = 30, value: PackagesReport | "loading" = report(), error?: string) =>
  renderPackagesPage({ report: value === "loading" ? undefined : value, ...(error ? { error } : {}), state, width, height, now: NOW })

const press = (state: PackagesPageState, ...keys: string[]) => {
  let current = state
  let action: ReturnType<typeof packagesPageKey>["action"] = { type: "none" }
  for (const key of keys) ({ state: current, action } = packagesPageKey(current, key, PACKAGES))
  return { state: current, action }
}

describe("packages page rendering", () => {
  test("context cost distinguishes idle metadata, on-demand text and unknown estimates at narrow/wide widths", () => {
    const value = report([pkg("review", { contextCost: { idleTokens: 0, onDemandTokens: 90, method: "chars/4" } })])
    for (const width of [60, 140]) {
      const rows = plain(render(createPackagesPageState(), width, 35, value))
      expect(rows.join("\n")).toContain("idle ~0 tokens")
      expect(rows.join("\n")).toContain("~90 tokens (total)")
      expect(rows.every((row) => textWidth(row) <= width)).toBe(true)
    }
    expect(plain(render(createPackagesPageState(), 140, 35)).join("\n")).toContain("context   unknown")
  })
  test("title and key hints share the header; summary and panel grid fill the body", () => {
    const rows = plain(render(createPackagesPageState()))
    expect(rows[0]!.trimStart()).toStartWith("Packages · /repo/app")
    expect(rows[1]!.trimEnd()).toEndWith("3 packages · 1 off · 1 problem")
    expect(rows.join("\n")).not.toMatch(/MENDCODE|LIVE/)
    expect(rows[0]).toContain("esc back")
    expect(rows[2]).toContain("┌─ Installed")
  })
  test("bordered panels use the available width, including compact single-column mode", () => {
    for (const [width, height] of [[60, 20], [100, 35], [140, 40]] as const) {
      const rows = plain(render(createPackagesPageState(), width, height))
      expect(rows.join("")).toMatch(/[┌┐└┘│]/)
      expect(rows[2]!.trimEnd()).toEndWith("┐")
    }
  })
  test("rows show key, version, what it adds and a semantic state color", () => {
    const lines = render(createPackagesPageState())
    const text = plain(lines).join("\n")
    expect(text).toContain("user:toolbox")
    expect(text).toContain("project:quiet")
    expect(text).toContain("1.2.0")
    expect(text).toContain("2 tools, 1 skill, 3 commands, 1 theme, mcp")
    expect(text).toContain("2 skills")
    const dots = lines.flatMap((line) => line.filter((span) => span.text.startsWith("● ")).map((span) => span.fg))
    expect(dots).toEqual(["success", "muted", "error"])
  })
  test("zero counts are omitted and an empty package shows a dash", () => {
    expect(describeContents({ tools: 0, skills: 1, commands: 0, themes: 0, mcp: false })).toBe("1 skill")
    expect(describeContents({ tools: 1, skills: 0, commands: 0, themes: 0, mcp: true })).toBe("1 tool, mcp")
    expect(describeContents({ tools: 0, skills: 0, commands: 0, themes: 0, mcp: false })).toBe("—")
  })
  test("the detail shows description, author, homepage, license, source, short commit, install time and folder", () => {
    const text = plain(render(createPackagesPageState(), 140, 35)).join("\n")
    expect(text).toContain("Handy tools for everyday work")
    expect(text).toContain("Acme")
    expect(text).toContain("https://example.com/toolbox")
    expect(text).toContain("MIT")
    expect(text).toContain("github:acme/toolbox")
    expect(text).toContain("0123456")
    expect(text).not.toContain("0123456789")
    expect(text).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2} · 3d ago/)
    expect(text).toContain("/home/me/.mendcode/packages/toolbox")
  })
  test("a problem package shows its problem text in full", () => {
    const text = plain(render({ selected: 2 }, 140, 35)).join("\n")
    expect(text).toContain("problem")
    expect(text).toContain("manifest.json: version must be a string")
    expect(text).toContain("it is fixed")
  })
  test("an off package says off in its detail", () => {
    const text = plain(render({ selected: 1 }, 140, 35)).join("\n")
    expect(text).toContain("project:quiet")
    expect(text).toContain("· off")
  })
  test("empty state says how to install", () => {
    const text = plain(render(createPackagesPageState(), 100, 20, report([]))).join("\n")
    expect(text).toContain("no packages · install with: mendcode package install <folder|github:owner/repo>")
    const narrow = plain(render(createPackagesPageState(), 60, 20, report([]))).join("\n")
    expect(narrow).toContain("<folder|github:owner/repo>")
  })
  test("loading and failed loading are shown with the right status", () => {
    const loading = plain(render(createPackagesPageState(), 100, 20, "loading")).join("\n")
    expect(loading).toContain("loading packages…")
    expect(loading.split("\n")[1]).not.toMatch(/Error/)
    const failed = render(createPackagesPageState(), 100, 20, "loading", "daemon not reachable")
    expect(plain(failed).join("\n")).toContain("daemon not reachable")
    expect(plain(failed)[1]).toContain("Error")
  })
  test("a failed action keeps the list and shows the error", () => {
    const lines = render(createPackagesPageState(), 100, 30, report(), "cannot write settings")
    const text = plain(lines).join("\n")
    expect(plain(lines)[1]).toContain("Error")
    expect(text).toContain("cannot write settings")
    expect(text).toContain("user:toolbox")
  })
  test("a pending remove names the package and swaps the header hints", () => {
    const lines = render({ selected: 1, confirm: { key: "project:quiet" } })
    const text = plain(lines).join("\n")
    expect(plain(lines)[1]).toContain("Confirm remove")
    expect(text).toContain("remove project:quiet? d or y confirms")
    expect(text).toContain("any key cancels")
    expect(plain(lines)[0]).toContain("d/y remove · esc cancel")
    expect(text).not.toContain("select")
  })
  test("is exactly width x height at 60x20, 80x30, 120x40 and 160x50, in every state", () => {
    for (const [width, height] of [[60, 20], [80, 30], [120, 40], [160, 50]] as const) {
      for (const state of [{ selected: 0 }, { selected: 2 }, { selected: 1, confirm: { key: "project:quiet" } }] as PackagesPageState[]) {
        for (const value of [report(), report([]), "loading" as const]) {
          const lines = render(state, width, height, value)
          expect(lines).toHaveLength(height)
          for (const row of plain(lines)) expect(textWidth(row)).toBe(width)
        }
      }
    }
  })
  test("exact height and no overflow at the other sizes", () => {
    for (const width of [90, 119, 121]) {
      for (const height of [20, 23, 24, 35]) {
        for (const state of [{ selected: 0 }, { selected: 2 }, { selected: 1, confirm: { key: "project:quiet" } }] as PackagesPageState[]) {
          const lines = render(state, width, height)
          expect(lines).toHaveLength(height)
          for (const row of plain(lines)) expect(textWidth(row)).toBeLessThanOrEqual(width)
        }
      }
    }
  })
  test("tiers: the detail is under the list below 110 columns or 24 rows, beside it from there", () => {
    const beside = (width: number, height: number) => plain(render(createPackagesPageState(), width, height)).some((row) => row.includes("❯ ● user:toolbox") && row.includes("user:toolbox · 1.2.0 · on"))
    expect(beside(60, 35)).toBe(false)
    expect(beside(100, 35)).toBe(false)
    expect(beside(109, 35)).toBe(false)
    expect(beside(110, 23)).toBe(false)
    expect(beside(110, 35)).toBe(true)
    expect(beside(160, 35)).toBe(true)
  })
  test("the selected row stays visible with more packages than fit", () => {
    const many = Array.from({ length: 40 }, (_, i) => pkg(`pkg-${String(i).padStart(2, "0")}`))
    for (const [width, height] of [[60, 20], [100, 35], [160, 35]] as const) {
      for (const selected of [0, 17, 39]) {
        const rows = plain(render({ selected }, width, height, report(many)))
        const marked = rows.filter((row) => row.includes("❯"))
        expect(marked).toHaveLength(1)
        expect(marked[0]).toContain(`pkg-${String(selected).padStart(2, "0")}`)
      }
    }
  })
  test("long keys, versions and paths are clipped rather than overflowing", () => {
    const long = pkg("a-very-long-package-name-that-keeps-going-and-going", { dir: `/${"deep/".repeat(30)}folder`, manifest: { name: "x", version: "1.2.3-beta.4+build.5678", description: "word ".repeat(80) } })
    for (const width of [60, 120, 160]) {
      const lines = render(createPackagesPageState(), width, 35, report([long]))
      for (const line of lines) expect(textWidth(plain([line])[0]!)).toBeLessThanOrEqual(width)
    }
  })
})

describe("packages page keys", () => {
  test("arrows and j/k move the selection within bounds", () => {
    expect(press(createPackagesPageState(), "\x1b[B").state.selected).toBe(1)
    expect(press(createPackagesPageState(), "j", "j", "\x1b[A").state.selected).toBe(1)
    expect(press(createPackagesPageState(), "k").state.selected).toBe(0)
    expect(press(createPackagesPageState(), ...Array(20).fill("\x1b[B")).state.selected).toBe(PACKAGES.length - 1)
    const state = createPackagesPageState()
    expect(packagesPageKey(state, "\x1b[A", PACKAGES).state).toBe(state)
  })
  test("space and e toggle the selected package with the opposite of its current state", () => {
    expect(press(createPackagesPageState(), " ").action).toEqual({ type: "enable", key: "user:toolbox", enabled: false })
    expect(press(createPackagesPageState(), "e").action).toEqual({ type: "enable", key: "user:toolbox", enabled: false })
    expect(press(createPackagesPageState(), "j", " ").action).toEqual({ type: "enable", key: "project:quiet", enabled: true })
  })
  test("d asks first; d or y then removes by name and scope", () => {
    const asked = press(createPackagesPageState(), "j", "d")
    expect(asked.action).toEqual({ type: "none" })
    expect(asked.state.confirm).toEqual({ key: "project:quiet" })
    expect(press(asked.state, "d").action).toEqual({ type: "remove", name: "quiet", scope: "project" })
    expect(press(asked.state, "y").action).toEqual({ type: "remove", name: "quiet", scope: "project" })
    expect(press(asked.state, "y").state.confirm).toBeUndefined()
  })
  test("any other key cancels a pending remove without closing or acting", () => {
    const asked = press(createPackagesPageState(), "d")
    for (const key of ["n", "\x1b", "q", " ", "j", "r"]) {
      const result = packagesPageKey(asked.state, key, PACKAGES)
      expect(result.action).toEqual({ type: "none" })
      expect(result.state.confirm).toBeUndefined()
    }
  })
  test("a pending remove is dropped when the selection no longer points at it", () => {
    expect(packagesPageKey({ selected: 1, confirm: { key: "user:toolbox" } }, "d", PACKAGES).action).toEqual({ type: "none" })
  })
  test("r reloads, escape and q close, other keys do nothing", () => {
    expect(press(createPackagesPageState(), "r").action).toEqual({ type: "reload" })
    expect(press(createPackagesPageState(), "\x1b").action).toEqual({ type: "close" })
    expect(press(createPackagesPageState(), "q").action).toEqual({ type: "close" })
    expect(press(createPackagesPageState(), "z").action).toEqual({ type: "none" })
  })
  test("c opens the resource switches of the selected package; keys move, toggle and leave", () => {
    const opened = press(createPackagesPageState(), "j", "c")
    expect(opened.action).toEqual({ type: "config", key: "project:quiet" })
    expect(opened.state.config).toEqual({ key: "project:quiet", selected: 0 })
    const loaded: PackagesPageState = { ...opened.state, config: { ...opened.state.config!, resources: [{ id: "skills/a", kind: "skills", name: "a", enabled: true }, { id: "commands/b", kind: "commands", name: "b", enabled: false }] } }
    expect(packagesPageKey(loaded, " ", PACKAGES).action).toEqual({ type: "resource", key: "project:quiet", resource: "skills/a", enabled: false })
    const down = packagesPageKey(loaded, "j", PACKAGES)
    expect(down.state.config!.selected).toBe(1)
    expect(packagesPageKey(down.state, "e", PACKAGES).action).toEqual({ type: "resource", key: "project:quiet", resource: "commands/b", enabled: true })
    expect(packagesPageKey(down.state, "j", PACKAGES).state.config!.selected).toBe(1)
    expect(packagesPageKey(down.state, "d", PACKAGES).action).toEqual({ type: "none" })
    const closed = packagesPageKey(down.state, "\x1b", PACKAGES)
    expect(closed.action).toEqual({ type: "none" })
    expect(closed.state.config).toBeUndefined()
  })
  test("the resource view shows on/off rows, a loading state and an empty state at every width", () => {
    const base: PackagesPageState = { selected: 0, config: { key: "user:toolbox", selected: 1 } }
    expect(plain(render(base)).join("\n")).toContain("loading resources")
    const resources = [{ id: "skills/a", kind: "skills", name: "a", enabled: true }, { id: "commands/b", kind: "commands", name: "b", enabled: false }]
    for (const width of [60, 100, 140]) {
      const rows = render({ ...base, config: { ...base.config!, resources } }, width, 20)
      const text = plain(rows).join("\n")
      expect(rows).toHaveLength(20)
      expect(text).toContain("2 resources · 1 off")
      expect(text).toMatch(/› .*commands\/b\s+off/)
      expect(text).toMatch(/skills\/a\s+on/)
      for (const row of rows) expect(textWidth(row.map((span) => span.text).join(""))).toBeLessThanOrEqual(width)
    }
    expect(plain(render({ ...base, config: { ...base.config!, resources: [] } })).join("\n")).toContain("no switchable resources")
  })
  test("with no packages only r and close do anything", () => {
    for (const key of [" ", "e", "d", "j", "k"]) expect(packagesPageKey(createPackagesPageState(), key, []).action).toEqual({ type: "none" })
    expect(packagesPageKey(createPackagesPageState(), "r", []).action).toEqual({ type: "reload" })
    expect(packagesPageKey(createPackagesPageState(), "q", []).action).toEqual({ type: "close" })
  })
})
