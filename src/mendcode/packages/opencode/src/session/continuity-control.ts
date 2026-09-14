import { Effect } from "effect"
type Disable = { directory?: string; tools: boolean; questions: boolean }
const listeners = new Set<(event: Disable) => void>()
export function notifyDisabled(input: {
  directory?: string
  experimental?: { async_tools?: boolean; async_questions?: boolean }
}) {
  const event = {
    directory: input.directory,
    tools: input.experimental?.async_tools === false,
    questions: input.experimental?.async_questions === false,
  }
  if (event.tools || event.questions) for (const listener of listeners) listener(event)
}
export function waitForDisable(directory: string, kind: "tools" | "questions") {
  return Effect.callback<void>((resume) => {
    const listener = (event: Disable) => {
      if (event[kind] && (!event.directory || event.directory === directory)) resume(Effect.void)
    }
    listeners.add(listener)
    return Effect.sync(() => listeners.delete(listener))
  })
}
