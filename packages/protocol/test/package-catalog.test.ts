import { expect, test } from "bun:test"
import { Command, createIdFactory, isReadOnlyCommand, PackageAssetsReport, PackageCatalogReport, PackagePreviewReport } from "../src"

const ids = createIdFactory()
test("package catalog schemas are additive and strict; mutations and local metadata require full-access peers", () => {
  const base = { id: ids("command"), clientId: ids("client"), directory: "/tmp/project" }
  for (const command of [{ type: "packages.search", query: "review" }, { type: "packages.sources" }, { type: "packages.preview", sourceId: "local", scope: "user" }, { type: "packages.disable-all" }, { type: "packages.assets" }]) {
    expect(Command.safeParse({ ...base, ...command }).success).toBe(true)
    expect(isReadOnlyCommand(command.type as never)).toBe(false)
    expect(Command.safeParse({ ...base, ...command, extra: true }).success).toBe(false)
  }
  expect(Command.safeParse({ ...base, type: "packages.add-source", sourceId: "../escape", location: "/tmp" }).success).toBe(false)
  expect(Command.safeParse({ ...base, type: "packages.install-catalog", name: "ok", scope: "system" }).success).toBe(false)
  const entry = { name: "review", version: "1", description: "Review", tags: [], sourceId: "local", location: "/tmp/review", state: "available", contents: { tools: 0, skills: 0, commands: 1, themes: 0, mcp: false } }
  expect(PackageCatalogReport.safeParse({ entries: [entry], issues: [], query: "" }).success).toBe(true)
  expect(PackagePreviewReport.safeParse({ entry, scope: "user", action: "install", problems: [] }).success).toBe(true)
  expect(PackageAssetsReport.safeParse({ layers: [{ source: "user", contents: entry.contents, prompts: 1, templates: 2 }], totals: { ...entry.contents, prompts: 1, templates: 2 }, promptMode: "focus" }).success).toBe(true)
})
