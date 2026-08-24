/**
 * Keep provider/event payloads from leaking non-string values into TUI text
 * renderers. The SDK types are optimistic, but a partial or malformed event
 * can still arrive while a message is being updated.
 */
export function tuiText(value: unknown): string {
  return typeof value === "string" ? value : ""
}
