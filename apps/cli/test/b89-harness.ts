import { realpathSync } from "node:fs"
import { createPtyService } from "../../../packages/daemon/src/pty"
import { fakePtyDriver } from "../../../packages/daemon/test/pty-fake"
import { appHarness, conversation, tempDir } from "./session-ui-harness"

/** B89 adds API traffic, not a terminal page. Frames exercise its existing remote chat host. */
export async function ptyChatHarness(width: number, height: number) {
  const directory = realpathSync(tempDir()), fake = fakePtyDriver()
  const service = createPtyService({ enabled: true, driver: fake.driver })
  const scope = { directory }
  const pty = service.create(scope, { title: "Tests" })
  const h = appHarness({ width, height, dataDir: tempDir(), directory, version: "0.0.1-dev", remote: { host: "127.0.0.1", readOnly: false }, reply: (command) => {
    if (command.type === "models.list") return { ok: true, result: { selectable: true, engine: "native", defaults: { model: "alpha" }, effective: { model: "alpha" }, roles: {}, models: [{ id: "alpha", name: "Alpha", provider: "openai", efforts: [] }] } }
    if (command.type === "session.list") return { ok: true, result: { sessions: [] } }
    if (command.type === "settings.get") return { ok: true, result: { settings: { onboarded: true, pet: "off" } } }
    return undefined
  } })
  h.app.applySettings({ onboarded: true, pet: "off" })
  await h.app.start()
  const chat = conversation(h.sessionId, (event) => h.app.onEvent(event))
  chat.exchange("Open a terminal for tests.", `${pty.title} · ${pty.status}\n${pty.command} ${pty.args.join(" ")}`)
  const resize = () => {
    service.update(scope, pty.id, { size: { cols: width, rows: height } })
    const [cols, rows] = fake.processes[0]!.sizes.at(-1)!
    chat.exchange(`Resize the terminal to ${cols} × ${rows}.`, `Tests resized to ${cols} × ${rows}.`)
  }
  return { ...h, fake, resize, close: () => service.dispose() }
}
