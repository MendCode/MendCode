import { afterAll, expect, test } from "bun:test"
import { appHarness, cleanTemps, tempDir } from "./session-ui-harness"

/** `/graph`: where the code graph indexes, for this project or every project, saved as daemon settings without a prompt. */
afterAll(cleanTemps)

function harness(initial: Record<string, unknown> = {}) {
  const directory = tempDir()
  let settings: Record<string, unknown> = { onboarded: true, tier: "full", ...initial }
  const h = appHarness({ width: 120, height: 30, directory, dataDir: tempDir(), mode: "full", reply: (command) => {
    if (command.type === "settings.get") return { ok: true, result: { settings } }
    if (command.type === "settings.set") {
      const patch = (command as { patch: Record<string, unknown> }).patch
      settings = Object.fromEntries(Object.entries({ ...settings, ...patch }).filter(([, value]) => value !== null))
      return { ok: true, result: { settings } }
    }
    return undefined
  } })
  h.app.applySettings(settings as never)
  return { ...h, directory, settings: () => settings }
}
const patches = (h: ReturnType<typeof harness>) => h.sentOf("settings.set").map((command) => (command as { patch: unknown }).patch)

test("/graph on|off|auto sets this project's override, /graph default sets every project's, and bare /graph says which applies", async () => {
  const h = harness({ projectConfig: { "/elsewhere": { model: "x" } } })
  await h.type("/graph\r")
  expect(h.text().join("\n")).toContain("graph auto here (default) · default auto")
  await h.type("/graph off\r")
  expect(patches(h).at(-1)).toEqual({ projectConfig: { "/elsewhere": { model: "x" }, [h.directory]: { codegraph_index: "off" } } })
  expect(h.text().join("\n")).toContain("graph off here")
  await h.type("/graph\r")
  expect(h.text().join("\n")).toContain("graph off here · default auto")
  // auto drops the override and keeps the other projects' entries.
  await h.type("/graph auto\r")
  expect(patches(h).at(-1)).toEqual({ projectConfig: { "/elsewhere": { model: "x" } } })
  await h.type("/graph default on\r")
  expect(patches(h).at(-1)).toEqual({ codegraph_index: "on" })
  await h.type("/graph default next\r")
  expect(patches(h).at(-1)).toEqual({ codegraph_index: "off" })
  await h.type("/graph default auto\r")
  expect(patches(h).at(-1)).toEqual({ codegraph_index: null })
  const sent = patches(h).length
  await h.type("/graph sideways\r")
  expect(h.text().join("\n")).toContain("usage: /graph [on|off|auto]")
  expect(patches(h)).toHaveLength(sent)
})

test("/graph refuses quietly when the code graph feature is off, and changes nothing", async () => {
  const h = harness({ features: { codegraph: false } })
  await h.type("/graph on\r")
  expect(h.text().join("\n")).toContain("code graph is off in this tier")
  expect(patches(h)).toEqual([])
})
