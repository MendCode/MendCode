import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { startDaemon } from "../src"
import { packageTierAllows, tierDisabledPackages } from "../src/package-tier"

const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const temp = () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mend-package-tier-")))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test("official data packages follow their declared tiers and independent feature switches", () => {
  expect(packageTierAllows({}, "mendcode-review")).toBe(true)
  expect(packageTierAllows({ tier: "minimalist" }, "mendcode-review")).toBe(false)
  expect(packageTierAllows({ tier: "balanced" }, "mendcode-review")).toBe(true)
  expect(packageTierAllows({ tier: "balanced" }, "mendcode-web-routing")).toBe(true)
  expect(packageTierAllows({ tier: "balanced" }, "mendcode-autoresearch")).toBe(false)
  expect(packageTierAllows({ tier: "full" }, "mendcode-autoresearch")).toBe(true)
  expect(packageTierAllows({ tier: "full", features: { autoresearch: false } }, "mendcode-autoresearch")).toBe(false)
  expect(packageTierAllows({ tier: "full", features: { web_routing: false } }, "mendcode-web-routing")).toBe(false)
  expect(packageTierAllows({ tier: "full", features: { official_packages: false } }, "mendcode-review")).toBe(false)
  expect(packageTierAllows({ tier: "minimalist" }, "user-package")).toBe(true)
  expect(tierDisabledPackages({ tier: "balanced" })).toEqual(["user:mendcode-autoresearch", "project:mendcode-autoresearch"])
})

test("a live tier change removes/restores an installed command without changing stored package/resource preferences", async () => {
  const dir = temp(), project = temp()
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "d.sock"), engine: ({ clock }) => createFauxEngine({ clock }) })
  cleanup.push(() => daemon.stop())
  const client = createClient({ socketPath: daemon.socketPath, name: "package-tier" })
  await client.connect()
  cleanup.push(() => client.close())
  const source = path.resolve(import.meta.dir, "../../../examples/official-packages/mendcode-review")
  expect(await client.send({ type: "packages.install", directory: project, source, scope: "project" })).toMatchObject({ ok: true })
  const command = async () => {
    const reply = await client.send({ type: "commands.list", directory: project })
    if (!reply.ok) throw new Error(reply.error.message)
    return (reply.result!.commands as Array<{ name: string }>).some((item) => item.name === "focused-review")
  }
  expect(await command()).toBe(true)
  expect(await client.send({ type: "settings.set", patch: { tier: "minimalist", disabledPackageResources: ["project:mendcode-review/skills/example"] } })).toMatchObject({ ok: true })
  expect(await command()).toBe(false)
  expect(await client.send({ type: "packages.list", directory: project })).toMatchObject({ ok: true, result: { packages: [{ enabled: false }] } })
  await client.send({ type: "settings.set", patch: { tier: "balanced" } })
  expect(await command()).toBe(true)
  await client.send({ type: "settings.set", patch: { features: { official_packages: false } } })
  expect(await command()).toBe(false)
  const settings = await client.send({ type: "settings.get" })
  expect(settings).toMatchObject({ ok: true, result: { settings: { disabledPackageResources: ["project:mendcode-review/skills/example"] } } })
  if (settings.ok) expect(settings.result!.settings).not.toHaveProperty("disabledPackages")
})
