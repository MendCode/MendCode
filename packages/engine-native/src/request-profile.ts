import { estimateTokens } from "@mendcode/protocol/wire"
import type { RequestProfile } from "@mendcode/protocol"
import type { ModelMessage } from "./provider"

/** Text estimates only: images are counted separately, never assigned a guessed token price. */
export function requestEstimates(system: string, memory: string[], messages: ModelMessage[], tools: unknown[]): RequestProfile["estimatedTokens"] {
  const memoryChars = memory.filter((text) => text && system.includes(text)).reduce((sum, text) => sum + text.length, 0)
  const chars = (message: ModelMessage) => message.role === "tool" ? message.output.length : message.content.length + (message.role === "assistant" ? JSON.stringify(message.toolCalls).length : 0)
  const estimated = {
    instructions: estimateTokens(Math.max(0, system.length - memoryChars)),
    memory: estimateTokens(memoryChars),
    history: estimateTokens(messages.filter((message) => message.role !== "tool").reduce((sum, message) => sum + chars(message), 0)),
    toolResults: estimateTokens(messages.filter((message) => message.role === "tool").reduce((sum, message) => sum + chars(message), 0)),
    toolSchemas: estimateTokens(JSON.stringify(tools).length),
    media: 0,
  }
  return { ...estimated, total: Object.values(estimated).reduce((sum, value) => sum + value, 0) }
}
