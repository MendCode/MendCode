import { appHarness, scratch } from "./extensions-harness"

export async function b38Harness(width = 100, height = 30) {
  const files = scratch()
  const module = files.write("data/review.ts", `export default { id: "review", server: async () => ({ auth: { provider: "fake", methods: [{type:"api", label:"Local key"}] } }), async activate(api, options) {
    const snapshot = await api.metadata.getCurrent()
    api.route.register([{ name: "plugin-review", title: "Review", render: () => [
      [{text: "Provider  ", fg: "accent"}, {text: options.provider}],
      [{text: "State     ", fg: "accent"}, {text: snapshot.data.state}],
      [{text: "Session   ", fg: "accent"}, {text: api.metadata.current()}]
    ] }])
    api.command.register(() => [{ title: "Review", value: "plugin-review", slash: { name: "plugin-review", aliases: ["review-plugin"] }, keybind: "ctrl+g", onSelect() { api.route.navigate("plugin-review") } }])
    api.slots.register({slots: {home_bottom: () => [[{text: options.provider + " · " + snapshot.data.state, fg: "muted"}]]}})
  } }`)
  files.write("data/mendcode.json", JSON.stringify({ pluginCompatibility: true, plugin: [[module, { provider: "Fake local", label: "Review" }]] }))
  let metadata: Record<string, unknown> = { state: "review" }
  const h = await appHarness({ width, height, dataDir: files.dataDir, directory: files.project, version: "0.4.2", reply: (command) => {
    if (command.type === "plugins.metadata") {
      if (command.operation === "patch") metadata = { ...metadata, ...command.patch as Record<string, unknown> }
      return { ok: true, result: command.operation === "list" ? { entries: [] } : { metadata } }
    }
    if (command.type === "extensions.list") return { ok: true, result: { extensions: [{ name: "review", pluginId: "review", abi: "v1-adapter", authProvider: "fake", file: module, source: "user", trusted: true, daemon: true, tui: true, tools: [], commands: [], hooks: [], errors: [] }] } }
    if (command.type === "models.list") return { ok: true, result: { engine: "faux", selectable: false, models: [], defaults: { model: "fake-local" }, roles: {} } }
    return { ok: true }
  } })
  await h.start({ onboarded: true })
  return { ...h, files, cleanup: async () => { await h.key("\x03"); files.cleanup() } }
}
