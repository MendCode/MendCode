import type { AgentsReport, ModelsReport } from "@mendcode/protocol"
import { appHarness, tempDir } from "./session-ui-harness"

/** The actual app factories, with local catalog and agent replies; no daemon or real user directory. */
export async function b42Harness(width = 100, height = 30) {
  const directory = tempDir("b42-project-")
  const agents: AgentsReport = { directory, current: "build", problems: [], agents: [
    { name: "build", description: "Build and verify changes", source: "user", trusted: true, mode: "primary", color: "#22cc88" },
    { name: "plan", description: "Investigate and propose a plan", source: "user", trusted: true, mode: "primary", color: "warning" },
    { name: "reviewer", description: "Review code with focused checks", source: "user", trusted: true, mode: "primary", color: "#60a5fa" },
    { name: "hidden-agent", description: "Hidden helper", source: "user", trusted: true, mode: "all", hidden: true },
    { name: "disabled-agent", description: "Disabled helper", source: "user", trusted: true, mode: "primary", disable: true },
  ] }
  const models: ModelsReport = { engine: "native", selectable: true, defaults: { model: "local:fast" }, effective: { model: "local:large", variant: "careful", effort: "high" }, roles: { main: { model: "local:large", variant: "careful" }, small: { model: "local:fast" }, title: { model: "local:fast" }, summary: { model: "local:large", effort: "low" }, memoryExtractor: { model: "local:fast" }, memoryAssistant: { model: "local:large" } }, models: [
    { id: "local:fast", name: "Fast · Local", provider: "local", efforts: ["low", "high"], contextWindow: 64000, modalities: { input: ["text"], output: ["text"] }, cost: { input: 1, output: 3 } },
    { id: "local:large", name: "Large · Local", provider: "local", efforts: ["low", "high"], contextWindow: 200000, variants: { careful: { effort: "high", parameters: { temperature: 0.2 } } } },
  ] }
  const h = appHarness({ width, height, directory, dataDir: tempDir("b42-ui-"), reply: (command) => {
    if (command.type === "agents.list") return { ok: true, result: agents }
    if (command.type === "session.agent.set") { agents.current = command.agent ?? "build"; return { ok: true, result: agents } }
    if (command.type === "models.list") return { ok: true, result: models }
    if (command.type === "settings.set" && command.patch.models) { models.roles = command.patch.models; return { ok: true, result: { settings: { models: models.roles } } } }
    if (command.type === "recipes.list") return { ok: true, result: { directory, recipes: [] } }
    return undefined
  } })
  await h.app.start()
  h.app.applySettings({ onboarded: true })
  await Bun.sleep(5)
  return { ...h, agents, models }
}
