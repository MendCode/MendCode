import { EventEmitter } from "events"
import { Identifier } from "@/id/id"
import { appendGlobalEvent, startGlobalEventRelay } from "./global-relay"

export type GlobalEvent = {
  directory?: string
  project?: string
  workspace?: string
  payload: any
}

class GlobalBusEmitter extends EventEmitter<{
  event: [GlobalEvent]
}> {
  #relaying = false

  constructor() {
    super()
    startGlobalEventRelay((event) => this.emitFromRelay(event))
  }

  override emit(eventName: "event", event: GlobalEvent): boolean {
    if (event.payload && typeof event.payload === "object" && !("id" in event.payload)) {
      event.payload.id = event.payload.syncEvent?.id ?? Identifier.create("evt", "ascending")
    }
    if (!this.#relaying) appendGlobalEvent(event)
    return super.emit(eventName, event)
  }

  emitFromRelay(event: GlobalEvent) {
    this.#relaying = true
    try {
      return this.emit("event", event)
    } finally {
      this.#relaying = false
    }
  }
}

export const GlobalBus = new GlobalBusEmitter()
