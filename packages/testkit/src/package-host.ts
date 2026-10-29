import { createVirtualClock } from "@mendcode/kernel"

/** Public package fixtures: explicit events, scripted model answers and virtual time. Never calls a provider. */
export function createPackageTestHost<T>(answers: readonly string[] = []) {
  const clock = createVirtualClock()
  const listeners = new Set<(event: T) => void>()
  const events: T[] = [], requests: string[] = []
  let next = 0
  return {
    clock, events, requests,
    on(handler: (event: T) => void) { listeners.add(handler); return () => { listeners.delete(handler) } },
    emit(event: T) { events.push(event); for (const listener of [...listeners]) listener(event) },
    async model(request: string) {
      if (next >= answers.length) throw new Error("No scripted model answer")
      requests.push(request)
      return answers[next++]!
    },
    dispose() { listeners.clear() },
  }
}
