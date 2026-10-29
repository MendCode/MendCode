import type { EngineEvent, TurnInput } from "./ports"
import type { ItemId } from "@mendcode/protocol"

/** Raw external streams may split the process bearer across deltas. Mask before any event reaches persistence. */
export function processMcpTurn(input: TurnInput): TurnInput & { flushProcessMcp(): void } {
  const mcp = input.externalMcp!
  const streams = new Map<ItemId, { push(text: string): string; flush(): string }>()
  const emit = (event: EngineEvent) => input.emit(JSON.parse(mcp.scrub(JSON.stringify(event))))
  return {
    ...input, externalMcp: undefined,
    flushProcessMcp() {
      for (const [itemId, stream] of streams) {
        const text = stream.flush()
        if (text) emit({ type: "item.delta", itemId, text })
      }
      streams.clear()
    },
    ask: (request) => input.ask(JSON.parse(mcp.scrub(JSON.stringify(request)))),
    emit(event) {
      if (event.type === "item.delta" && mcp.stream) {
        const stream = streams.get(event.itemId) ?? mcp.stream()
        streams.set(event.itemId, stream)
        const text = stream.push(event.text)
        if (text || event.input) emit({ ...event, text })
        return
      }
      if (event.type === "item.completed") {
        const text = streams.get(event.itemId)?.flush()
        streams.delete(event.itemId)
        if (text) emit({ type: "item.delta", itemId: event.itemId, text })
      }
      emit(event)
    },
  }
}
