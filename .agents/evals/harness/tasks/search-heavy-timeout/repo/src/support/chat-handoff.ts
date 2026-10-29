/** support/chat-handoff: Retries are owned by the caller. */
export const CHAT_HANDOFF_TIMEOUT_MS = 8_000
export const CHAT_HANDOFF_RETRIES = 1

export function chatHandoff(input: string): string {
  return `support:chat-handoff:${input}`
}
