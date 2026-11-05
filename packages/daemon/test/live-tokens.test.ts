import { describe, expect, test } from "bun:test"
import { createVirtualClock } from "@mendcode/kernel"
import { createIdFactory, GlobalEvent } from "@mendcode/protocol"
import { createLiveTokens, type TurnTokensEvent } from "../src/live-tokens"

const ids = createIdFactory()

function live() {
  const clock = createVirtualClock(1_000)
  const events: TurnTokensEvent[] = []
  const sessionId = ids("session")
  const turnId = ids("turn")
  const tokens = createLiveTokens({ clock, emit: (event) => void events.push(event) })
  return { clock, events, tokens, sessionId, turnId }
}
const figures = (events: TurnTokensEvent[]) => events.map((event) => event.output)

describe("live tokens throttle", () => {
  test("the first figure goes out at once and is a valid wire event", () => {
    const { events, tokens, sessionId, turnId } = live()
    tokens.push(sessionId, turnId, 120)
    expect(events).toEqual([{ type: "turn.tokens", gseq: 0, at: 1_000, sessionId, turnId, output: 120 }])
    expect(GlobalEvent.safeParse(events[0]).success).toBe(true)
  })

  test("figures inside 250 ms are coalesced into the newest one at the end of the window", () => {
    const { clock, events, tokens, sessionId, turnId } = live()
    tokens.push(sessionId, turnId, 10)
    clock.advance(10)
    tokens.push(sessionId, turnId, 20)
    clock.advance(10)
    tokens.push(sessionId, turnId, 30)
    expect(figures(events)).toEqual([10])
    clock.advance(240)
    expect(figures(events)).toEqual([10, 30])
  })

  test("a repeated figure sends nothing", () => {
    const { clock, events, tokens, sessionId, turnId } = live()
    tokens.push(sessionId, turnId, 10)
    clock.advance(1_000)
    tokens.push(sessionId, turnId, 10)
    expect(figures(events)).toEqual([10])
  })

  test("a 0 (a usage record took the figures) goes out at once and drops a figure still waiting", () => {
    const { clock, events, tokens, sessionId, turnId } = live()
    tokens.push(sessionId, turnId, 10)
    clock.advance(10)
    tokens.push(sessionId, turnId, 25)
    tokens.push(sessionId, turnId, 0)
    clock.advance(1_000)
    expect(figures(events)).toEqual([10, 0])
  })

  test("a 0 for a session that showed nothing sends nothing", () => {
    const { events, tokens, sessionId, turnId } = live()
    tokens.push(sessionId, turnId, 0)
    expect(events).toEqual([])
  })
})
