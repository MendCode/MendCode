import { describe, expect, test } from "bun:test"
import { createIdFactory } from "@mendcode/protocol"
import type { PackageInfo, PackagesReport } from "@mendcode/protocol"
import { createApp } from "../src/ui/app"
import { parseSlash } from "../src/view/commands"
import { glyphs, type Line } from "../src/ui/theme"

const ids = createIdFactory()
const NOW = 1_800_000_000_000
const DIRECTORY = "/repo/app"

function pkg(name: string, patch: Partial<PackageInfo> = {}): PackageInfo {
  return { name, source: "user", key: `user:${name}`, dir: `/home/me/.mendcode/packages/${name}`, enabled: true, manifest: { name, version: "1.0.0", description: `The ${name} package` }, contents: { tools: 1, skills: 0, commands: 0, themes: 0, mcp: false }, ...patch }
}

async function harness(options: { failList?: boolean; lookOwner?: string } = {}) {
  let packages = [pkg("alpha"), pkg("beta", { source: "project", key: "project:beta" })]
  const sent: Array<Record<string, unknown>> = []
  const frames: Line[][] = []
  const screen = { size: { width: 100, height: 30 }, draw: (rows: Line[]) => void frames.push(rows) } as unknown as Parameters<typeof createApp>[0]["screen"]
  const report = (): PackagesReport => ({ directory: DIRECTORY, packages })
  const app = createApp({
    sessionId: ids("session"),
    screen,
    directory: DIRECTORY,
    send: async (command: Record<string, unknown>) => {
      sent.push(command)
      if (command.type === "packages.list") return options.failList ? { ok: false, error: { message: "daemon unavailable" } } : { ok: true, result: report() }
      if (command.type === "packages.enable") {
        // The daemon's refusal when another package owns the look and the request does not say to switch.
        if (options.lookOwner && command.enabled && !command.switch) return { ok: false, error: { message: `[PACKAGES]: ${options.lookOwner} owns the look; enabling ${command.key} replaces it. Run again with --switch to replace it` } }
        if (options.lookOwner && command.switch) packages = packages.map((item) => (item.key === options.lookOwner ? { ...item, enabled: false } : item))
        packages = packages.map((item) => (item.key === command.key ? { ...item, enabled: command.enabled as boolean } : item))
        return { ok: true, result: report() }
      }
      if (command.type === "packages.remove") {
        packages = packages.filter((item) => !(item.name === command.name && item.source === command.scope))
        return { ok: true, result: report() }
      }
      return { ok: true }
    },
    exit() {},
    schedule: (fn: () => void) => fn(),
    glyphs: glyphs({}),
    now: () => NOW,
  } as never)
  for (const key of "/packages") await app.onKey(key)
  await app.onKey("\r")
  const text = () => frames.at(-1)!.map((row) => row.map((s) => s.text).join(""))
  const tick = () => Bun.sleep(5)
  return { app, sent, text, tick }
}

describe("packages page in the app", () => {
  test("/packages and /pkg are commands", () => {
    expect(parseSlash("/packages")?.command.name).toBe("packages")
    expect(parseSlash("/pkg")?.command.name).toBe("packages")
  })

  test("typing /packages and Enter lists the packages of the directory and shows them", async () => {
    const { sent, text } = await harness()
    expect(sent.filter((command) => String(command.type).startsWith("packages."))).toEqual([{ type: "packages.list", directory: DIRECTORY }])
    expect(text().some((line) => line.trimStart().startsWith("Packages · "))).toBe(true)
    expect(text().some((line) => line.includes("user:alpha"))).toBe(true)
    expect(text().some((line) => line.includes("2 packages"))).toBe(true)
  })

  test("space toggles the selected package and the page re-renders from the returned report", async () => {
    const { app, sent, text, tick } = await harness()
    await app.onKey(" ")
    await tick()
    expect(sent.at(-1)).toEqual({ type: "packages.enable", directory: DIRECTORY, key: "user:alpha", enabled: false })
    expect(text().some((line) => line.includes("2 packages · 1 off"))).toBe(true)
    await app.onKey("j")
    await app.onKey("e")
    await tick()
    expect(sent.at(-1)).toEqual({ type: "packages.enable", directory: DIRECTORY, key: "project:beta", enabled: false })
    await app.onKey(" ")
    await tick()
    expect(sent.at(-1)).toEqual({ type: "packages.enable", directory: DIRECTORY, key: "project:beta", enabled: true })
  })

  test("turning on a package while another owns the look switches at once, with no question, and says which one went off", async () => {
    const { app, sent, text, tick } = await harness({ lookOwner: "project:beta" })
    await app.onKey(" ")
    await tick()
    await app.onKey(" ")
    await tick()
    expect(sent.slice(-2)).toEqual([
      { type: "packages.enable", directory: DIRECTORY, key: "user:alpha", enabled: true },
      { type: "packages.enable", directory: DIRECTORY, key: "user:alpha", enabled: true, switch: true },
    ])
    expect(text().join("\n")).not.toMatch(/y switch|Switch the look/)
    expect(text().some((line) => line.includes("2 packages · 1 off"))).toBe(true)
  })

  test("d asks, then d or y removes by name and scope", async () => {
    const { app, sent, text, tick } = await harness()
    await app.onKey("j")
    await app.onKey("d")
    expect(text().some((line) => line.includes("Confirm remove"))).toBe(true)
    expect(sent.some((command) => command.type === "packages.remove")).toBe(false)
    await app.onKey("y")
    await tick()
    expect(sent.at(-1)).toEqual({ type: "packages.remove", directory: DIRECTORY, name: "beta", scope: "project" })
    expect(text().some((line) => line.includes("● project:beta"))).toBe(false)
    expect(text().some((line) => line.includes("removed project:beta"))).toBe(true)
    expect(text().some((line) => line.includes("1 package") && !line.includes("2 packages"))).toBe(true)
  })

  test("any other key at the confirmation cancels without removing", async () => {
    const { app, sent, text, tick } = await harness()
    await app.onKey("d")
    await app.onKey("n")
    await tick()
    expect(sent.some((command) => command.type === "packages.remove")).toBe(false)
    expect(text().some((line) => line.includes("Confirm remove"))).toBe(false)
    expect(text().some((line) => line.trimStart().startsWith("Packages · "))).toBe(true)
  })

  test("r reloads", async () => {
    const { app, sent, tick } = await harness()
    await app.onKey("r")
    await tick()
    expect(sent.filter((command) => command.type === "packages.list")).toHaveLength(2)
  })

  test("a failed load shows Error with the message, and esc leaves the page", async () => {
    const { app, text } = await harness({ failList: true })
    expect(text().some((line) => line.includes("Error") && line.includes("daemon unavailable"))).toBe(true)
    expect(text().some((line) => line.includes("daemon unavailable"))).toBe(true)
    await app.onKey("\x1b")
    expect(text().some((line) => line.trimStart().startsWith("Packages · "))).toBe(false)
  })

  test("esc leaves the page", async () => {
    const { app, text } = await harness()
    await app.onKey("\x1b")
    expect(text().some((line) => line.trimStart().startsWith("Packages · "))).toBe(false)
  })
})
