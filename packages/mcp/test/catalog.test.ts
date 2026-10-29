import { afterEach, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { catalogList, catalogName, createMcpClient, createMcpManager, createRemoteMcpClient, promptText, type McpClient } from "../src"
import { resourceContents, promptResult, parseResource } from "../src/catalog"
import { tempDir } from "./helpers"
import { startFakeRemote } from "./fixtures/fake-remote"

const cleanups: Array<() => unknown> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

function local(env: Record<string, string> = {}) {
  const client = createMcpClient({ name: "docs", config: { command: process.execPath, args: [join(import.meta.dir, "fixtures/fake-catalog.ts")], env } })
  cleanups.push(() => client.close())
  return client
}

async function verify(client: McpClient) {
  const catalog = await client.catalog!()
  expect(catalog.resources.map((item) => item.name)).toEqual(["Project guide", "Release notes"])
  expect(catalog.templates[0]?.uriTemplate).toBe("issues://{id}")
  expect(catalog.prompts.map((item) => item.name)).toEqual(["Review code", "Standup"])
  expect(await client.readResource!("docs://guide")).toHaveLength(2)
  expect(promptText(await client.getPrompt!("Review code", { target: "src/app.ts", focus: "security" }))).toBe("Review src/app.ts\nFocus: security")
  await expect(client.readResource!("docs://missing")).rejects.toThrow("resource not found")
}

test("stdio catalog paginates, reads text/blob and gets ordered prompt messages", async () => { await verify(local()) })

for (const transport of ["http", "stream", "legacy"] as const) test(`remote ${transport} catalog uses the negotiated transport`, async () => {
  const fake = await startFakeRemote({ protectedServer: false, catalog: true, streamResponses: transport === "stream", legacyOnly: transport === "legacy" })
  cleanups.push(() => fake.stop())
  const client = createRemoteMcpClient({ name: "docs", config: { url: transport === "legacy" ? fake.sseUrl : fake.url, oauth: false } })
  cleanups.push(() => client.close())
  await verify(client)
})

test("list-changed invalidates only catalog caches; repeated loads otherwise reuse them", async () => {
  const log = join(tempDir(), "requests.log")
  const client = local({ CATALOG_LOG: log })
  await client.catalog!()
  const first = readFileSync(log, "utf8")
  await client.catalog!()
  expect(readFileSync(log, "utf8")).toBe(first)
  await client.readResource!("docs://refresh")
  expect((await client.catalog!()).resources[0]?.name).toBe("Updated guide")
  expect(readFileSync(log, "utf8").match(/prompts\/list/g)).toHaveLength(4)
})

test("capabilities gate discovery and unsupported templates are cached as empty", async () => {
  const log = join(tempDir(), "requests.log")
  expect(await local({ CATALOG_LOG: log, NO_CATALOG: "1" }).catalog!()).toEqual({ resources: [], templates: [], prompts: [] })
  expect(readFileSync(log, "utf8")).not.toContain("resources/list")
  const missing = local({ CATALOG_LOG: log, NO_TEMPLATES: "1" })
  expect((await missing.catalog!()).templates).toEqual([])
  await missing.catalog!()
  expect(readFileSync(log, "utf8").match(/resources\/templates\/list/g)).toHaveLength(1)
})

test("manager names catalogs deterministically, isolates failures and rejects disabled reads", async () => {
  const manager = createMcpManager({ configLoader: () => ({ servers: { "docs.site": { command: process.execPath, args: [join(import.meta.dir, "fixtures/fake-catalog.ts")] }, broken: { command: "/not/a/program" }, disabled: { command: "unused", enabled: false } }, errors: [] }) })
  cleanups.push(() => manager.stop())
  const directory = tempDir()
  const result = await manager.catalog(directory)
  expect(result.resources.map((item) => item.id)).toEqual(["docs_site:Project_guide", "docs_site:Release_notes"])
  expect(result.issues[0]?.server).toBe("broken")
  expect(catalogName("docs.site", "Review code")).toBe("docs_site:Review_code")
  expect(await manager.readResource({ directory, server: "docs.site", uri: "docs://guide" })).toHaveLength(2)
  await expect(manager.getPrompt({ directory, server: "disabled", name: "x", args: {} })).rejects.toThrow("disabled")
})

test("catalog traversal rejects malformed pages and repeated cursors", async () => {
  await expect(catalogList(async () => ({ resources: [], nextCursor: "repeat" }), "resources", parseResource)).rejects.toThrow("cursor")
  await expect(catalogList(async () => ({ resources: "bad" }), "resources", parseResource)).rejects.toThrow("invalid")
  expect(resourceContents({ contents: [{ uri: "x", text: "hello" }, { invalid: true }] })).toEqual([{ uri: "x", text: "hello" }])
  expect(() => resourceContents({ contents: [{ uri: "x", text: "x".repeat(1_048_576) }] })).toThrow("1 MiB")
  expect(() => promptResult({ messages: "bad" })).toThrow("invalid")
})

test("a failing catalog category preserves other categories and manager diagnostics", async () => {
  const catalog = await local({ FAIL_METHOD: "resources/list" }).catalog!()
  expect(catalog.resources).toEqual([])
  expect(catalog.templates).toHaveLength(1)
  expect(catalog.prompts).toHaveLength(2)
  expect(catalog.issues?.[0]).toContain("resources/list")
  const manager = createMcpManager({ configLoader: () => ({ servers: { docs: { command: process.execPath, args: [join(import.meta.dir, "fixtures/fake-catalog.ts")], env: { FAIL_METHOD: "prompts/list" } } }, errors: [] }) })
  cleanups.push(() => manager.stop())
  const report = await manager.catalog(tempDir())
  expect(report.resources).toHaveLength(2)
  expect(report.prompts).toEqual([])
  expect(report.issues[0]).toMatchObject({ server: "docs", source: "runtime" })
  expect(report.issues[0]?.message).toContain("prompts/list")
})
