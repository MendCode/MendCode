import type { Event } from "@mendcode/sdk/v2"
import { useProject } from "./project"
import { useSDK } from "./sdk"

const forwardedSyncEventTypes = new Set([
  "message.updated",
  "message.removed",
  "message.part.updated",
  "message.part.removed",
])

function eventFromSyncPayload(payload: unknown): Event | undefined {
  if (!payload || typeof payload !== "object") return
  const syncEvent = (payload as { syncEvent?: unknown }).syncEvent
  if (!syncEvent || typeof syncEvent !== "object") return

  const rawType = (syncEvent as { type?: unknown }).type
  const properties = (syncEvent as { data?: unknown }).data
  if (typeof rawType !== "string" || !properties || typeof properties !== "object") return

  const type = rawType.replace(/\.\d+$/, "")
  if (!forwardedSyncEventTypes.has(type)) return

  return {
    id: typeof (syncEvent as { id?: unknown }).id === "string" ? (syncEvent as { id: string }).id : "",
    type,
    properties,
  } as Event
}

export function useEvent() {
  const project = useProject()
  const sdk = useSDK()

  function subscribe(handler: (event: Event) => void) {
    return sdk.event.on("event", (event) => {
      const payload = event.payload.type === "sync" ? eventFromSyncPayload(event.payload) : event.payload
      if (!payload) return

      // Special hack for truly global events
      if (event.directory === "global") {
        handler(payload)
      }

      if (project.workspace.current()) {
        if (event.workspace === project.workspace.current()) {
          handler(payload)
        }

        return
      }

      if (event.directory === project.instance.directory()) {
        handler(payload)
      }
    })
  }

  function on<T extends Event["type"]>(type: T, handler: (event: Extract<Event, { type: T }>) => void) {
    return subscribe((event) => {
      if (event.type !== type) return
      handler(event as Extract<Event, { type: T }>)
    })
  }

  return {
    subscribe,
    on,
  }
}
