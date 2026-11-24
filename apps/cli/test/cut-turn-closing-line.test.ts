import { afterAll, expect, test } from "bun:test"
import type { SessionEvent } from "@mendcode/protocol"
import type { WindowReply } from "@mendcode/client"
import { appHarness, cleanTemps, conversation, ids } from "./session-ui-harness"

afterAll(cleanTemps)

function slice(events: SessionEvent[], from: number, to: number, more: boolean): WindowReply {
  const part = events.slice(from, to)
  return { ok: true, window: { events: part, firstSeq: part[0]?.seq ?? 0, lastSeq: part.at(-1)?.seq ?? 0, sessionLastSeq: events.at(-1)?.seq ?? 0, more } }
}

test("a chat opened on a window that begins inside the last turn still closes it with how long it took", async () => {
  const sessionId = ids("session")
  const events: SessionEvent[] = []
  conversation(sessionId, (event) => events.push(event)).exchange("go", Array.from({ length: 60 }, (_, n) => `line ${n}`).join("\n\n"))
  // The newest events only: the turn's `turn.started` and its first message are before the window.
  const cut = 3
  const h = appHarness({
    sessionId,
    width: 100,
    height: 24,
    events: {
      loadWindow: async () => slice(events, cut, events.length, true),
      loadBefore: async (_id, seq) => {
        const to = events.findIndex((event) => event.seq === seq)
        return slice(events, Math.max(0, to - 200), to, to - 200 > 0)
      },
    },
  })
  await h.app.start()
  expect(h.text().join("\n")).toMatch(/took \d+s · ended \d{1,2}:\d{2} [AP]M/)
})
