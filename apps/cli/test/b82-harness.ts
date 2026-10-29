import { appHarness, conversation, NOW, tempDir } from "./session-ui-harness"

export async function serverRestHarness(width: number, height: number) {
  const directory = "/work/project"
  const h = appHarness({ width, height, dataDir: tempDir(), directory, version: "0.0.1-dev", remote: { host: "127.0.0.1", readOnly: false }, reply: (command) => {
    if (command.type === "models.list") return { ok: true, result: { selectable: true, engine: "native", defaults: { model: "alpha" }, effective: { model: "alpha" }, roles: {}, models: [{ id: "alpha", name: "Alpha", provider: "openai", efforts: [] }] } }
    if (command.type === "session.list") return { ok: true, result: { sessions: [] } }
    if (command.type === "settings.get") return { ok: true, result: { settings: { onboarded: true, pet: "off" } } }
    return undefined
  } })
  h.app.applySettings({ onboarded: true, pet: "off" })
  await h.app.start()
  conversation(h.sessionId, (event) => h.app.onEvent(event)).exchange("Keep the server listening after disposal.", "The session stays in durable storage. Its actor is recreated on the next request.")
  const configChanged = () => h.app.onGlobal({ type: "settings.changed", gseq: 1, at: NOW, settings: { onboarded: true, pet: "off", models: { main: { model: "alpha" } }, projectConfig: { [directory]: { defaultAgent: "plan" } } } })
  const disposed = () => h.app.onGlobal({ type: "server.lifecycle", change: "disposed", directory, gseq: 2, at: NOW })
  return { ...h, configChanged, disposed }
}
