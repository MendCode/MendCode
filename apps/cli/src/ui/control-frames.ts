import type { Client } from "@mendcode/client"
import type { SessionSummary, SessionEvent, Settings } from "@mendcode/protocol"
import { createIdFactory } from "@mendcode/protocol/wire"
import { createApp } from "./app"
import { glyphs, type Line } from "./theme"
import { normalizeTuiProfile } from "../view/tui-profile"
import { fit } from "../view/deck"

/** Native app rendering from daemon state; no sample messages and no terminal side effects. */
export async function controlFrames(client: Pick<Client, "send" | "subscribe">, directory: string, profile: Record<string, unknown>, state: "home" | "session", session?: string) {
  const listed = await client.send({ type: "session.list", directory, limit: 1 })
  if (!listed.ok) throw new Error(listed.error.message)
  const selected = session ?? (listed.result?.sessions as SessionSummary[] | undefined)?.[0]?.sessionId
  if (state === "session" && !selected) throw new Error("No session to render")
  const sessionId = (selected ?? createIdFactory()("session")) as SessionSummary["sessionId"]
  const settings = await client.send({ type: "settings.get" })
  if (!settings.ok) throw new Error(settings.error.message)
  const window = state === "session" ? await client.send({ type: "session.events", sessionId, limit: 1000 }) : undefined
  if (window && !window.ok) throw new Error(window.error.message)
  const frames = []
  for (const [width, height] of [[100, 30], [180, 50]]) {
    let rows: Line[] = []
    const pending = new Set<Promise<unknown>>()
    const app = createApp({
      sessionId, directory, profile: normalizeTuiProfile(profile),
      screen: { size: { width: width!, height: height! }, draw: (frame: Line[]) => { rows = frame } } as Parameters<typeof createApp>[0]["screen"],
      send: (command) => {
        const request = client.send(command)
        pending.add(request)
        void request.finally(() => pending.delete(request)).catch(() => {})
        return request
      }, subscribe: (id, after) => client.subscribe(id, after),
      glyphs: glyphs({}), exit() {}, schedule: (fn) => fn(), now: () => Date.now(), random: () => 0,
    })
    if (window?.ok) for (const event of window.result?.events as SessionEvent[] ?? []) app.onEvent(event)
    app.applySettings(settings.result?.settings as Settings ?? {})
    await app.extensionsReady
    while (pending.size) await Promise.all([...pending])
    app.render()
    frames.push({ name: `${state}-${width}x${height}`, lines: rows.map((row) => fit(row, width!).map((span) => span.text).join("")) })
    await app.onKey("\x03")
    await app.onKey("\x03")
  }
  return frames
}
