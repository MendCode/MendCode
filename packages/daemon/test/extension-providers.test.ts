import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { extensionLayers } from "@mendcode/packages"
import { createExtensions } from "../src/extensions"
import { createProviderService } from "../src/providers"

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const tmp = (label: string) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), `extprov-${label}-`)))
  dirs.push(dir)
  return dir
}
function put(root: string, relative: string, text: string) {
  const file = path.join(root, relative)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, text)
}
const extension = (name: string, body: string) => `export default { name: ${JSON.stringify(name)}, daemon(api) { ${body} } }\n`
const ACME = `api.registerProvider({ id: "acme", type: "openai-compatible", baseUrl: "https://llm.acme.test/v1/", apiKeyEnv: "ACME_API_KEY", models: [{ id: "acme-coder-1", name: "Acme Coder", context: 128000 }] })`

function setup() {
  const user = tmp("user")
  const project = tmp("project")
  const ext = createExtensions({ dataDir: user, layersFor: (directory) => extensionLayers({ userDir: user, directory }), isTrusted: () => true, notify: () => {}, hookTimeoutMs: 200 })
  return { user, project, ext }
}

describe("a user extension registers a whole model provider", () => {
  test("registerProvider with a baseUrl becomes a providers.json-shaped entry once the extension loaded", async () => {
    const { user, project, ext } = setup()
    put(user, "extensions/acme.ts", extension("acme", ACME))
    expect(ext.transportProviders()).toEqual({})
    const [info] = await ext.list(project)
    expect(info).toMatchObject({ name: "acme", provider: "acme", errors: [] })
    expect(ext.transportProviders()).toEqual({ acme: { type: "openai-compatible", baseUrl: "https://llm.acme.test/v1", enabled: true, apiKeyEnv: "ACME_API_KEY", models: [{ id: "acme-coder-1", name: "Acme Coder", context: 128000 }] } })
    // The catalog hook path (models as a function) does not list it a second time.
    expect(await ext.providerModels(project)).toEqual([])
  })

  test("a literal key, a built-in id, a missing model list and a project extension are refused with the reason", async () => {
    const { user, project, ext } = setup()
    put(user, "extensions/a.ts", extension("a", `api.registerProvider({ id: "keyed", baseUrl: "https://x.test/v1", apiKey: "sk-123", models: [{ id: "m" }] })`))
    put(user, "extensions/b.ts", extension("b", `api.registerProvider({ id: "anthropic", baseUrl: "https://x.test/v1", models: [{ id: "m" }] })`))
    put(user, "extensions/c.ts", extension("c", `api.registerProvider({ id: "empty", baseUrl: "https://x.test/v1" })`))
    put(project, ".mendcode/extensions/d.ts", extension("d", `api.registerProvider({ id: "local", baseUrl: "https://x.test/v1", models: [{ id: "m" }] })`))
    const errors = Object.fromEntries((await ext.list(project)).map((entry) => [entry.name, entry.errors.join(" ")]))
    expect(errors.a).toContain("apiKeyEnv")
    expect(errors.b).toContain("built-in provider")
    expect(errors.c).toContain("models lists")
    expect(errors.d).toContain("user extension")
    expect(ext.transportProviders()).toEqual({})
  })

  test("the provider service lists, routes and reports it as source extension; the user's own entry of the same id wins", async () => {
    const { user, project, ext } = setup()
    put(user, "extensions/acme.ts", extension("acme", ACME))
    await ext.list(project)
    const service = createProviderService({ dir: user, env: { ACME_API_KEY: "sk-test-acme" }, extensions: () => ext.transportProviders() })
    expect(service.models().map((model) => model.id)).toContain("acme:acme-coder-1")
    expect(service.list().find((provider) => provider.id === "acme")).toMatchObject({ source: "extension", baseUrl: "https://llm.acme.test/v1", enabled: true, hasKey: true })
    expect(Object.keys(service.runtime())).toContain("acme")
    put(user, "providers.json", JSON.stringify({ providers: { acme: { type: "openai-compatible", baseUrl: "https://mine.test/v1", models: [{ id: "mine-1" }] } } }))
    const mine = service.list().find((provider) => provider.id === "acme")
    expect(mine).toMatchObject({ source: "config", baseUrl: "https://mine.test/v1" })
    expect(service.models().map((model) => model.id)).toEqual(expect.arrayContaining(["acme:mine-1"]))
    expect(service.models().map((model) => model.id)).not.toContain("acme:acme-coder-1")
  })

  test("disabling the extension takes the provider away", async () => {
    const { user, project } = setup()
    put(user, "extensions/acme.ts", extension("acme", ACME))
    const off = createExtensions({ dataDir: user, layersFor: (directory) => extensionLayers({ userDir: user, directory }), isTrusted: () => true, notify: () => {}, isDisabled: (name) => name === "acme" })
    await off.list(project)
    expect(off.transportProviders()).toEqual({})
  })
})
