import { expect, test } from "bun:test"
import { Schema } from "effect"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"
import { TuiEvent } from "../../src/cli/cmd/tui/event"
import { reportUpgradeOutcome, reportUpgradePhase } from "../../src/server/upgrade-progress"

test("upgrade progress uses the existing TUI contract and failure replaces its long-lived notification", () => {
  const events: GlobalEvent[] = []
  const listener = (event: GlobalEvent) => { events.push(event) }
  GlobalBus.on("event", listener)
  try {
    reportUpgradePhase("0.1.44-beta.1", "downloading")
    reportUpgradeOutcome("0.1.44-beta.1", "Checksum mismatch; installed version preserved")
    expect(events).toHaveLength(2)
    for (const event of events) {
      expect(event.directory).toBe("global")
      expect(event.payload.type).toBe(TuiEvent.ToastShow.type)
      Schema.decodeUnknownSync(TuiEvent.ToastShow.properties)(event.payload.properties)
    }
    expect(events[0].payload.properties.message).toBe("Downloading…")
    expect(events[1].payload.properties.variant).toBe("error")
    expect(events[1].payload.properties.duration).toBe(10_000)
  } finally {
    GlobalBus.off("event", listener)
  }
})
