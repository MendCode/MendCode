import type { Settings } from "@mendcode/protocol"
import type { Line } from "../ui/theme"
import { keyText, preferChord } from "../ui/key-labels"
import { fit, lineWidth, panelGrid, spread } from "./deck"
import { onColor } from "./panel-box"
import { truncateEnd } from "./session-list"

export const QUEUE_SHOWN = 3
const QUEUED = " QUEUED "
const STEER = " STEERING "
const SEND = " ↗ SEND "
const HELD_INDENT = "  "

/** v1's queued previews and send chip, inside the shared panel grid. Chip coordinates are local to these rows. */
export function renderQueuePanel(input: { width: number; previews: readonly string[]; /** Per-message delivery (steer, wait, next), by position. */ delivery?: ReadonlyArray<"queue" | "steer" | "restart" | undefined>; held: boolean; paused?: boolean; mode?: NonNullable<Settings["queue"]>["mode"]; shell?: ReadonlySet<number>; /** Positions that are system notices (a background task ended). */ notices?: ReadonlySet<number> }): { rows: Line[]; sendChip?: { row: number; from: number; to: number } } {
  const { width, previews } = input
  if (previews.length === 0) return { rows: [] }
  // Nothing of the user's is waiting, only notices of the session's own background work: one muted line, not a box of messages to send.
  // Held after a cancel they go with the next message; while a turn runs the model reads them at its next step, with nothing to do here.
  if (!input.paused && previews.every((_, index) => input.notices?.has(index))) {
    const count = `${previews.length} background ${previews.length === 1 ? "result" : "results"}`
    // Under the transcript's text and over the prompt's rule (two cells in, where the box puts its text), in the longest form that fits whole.
    const forms = (input.held
      ? [`${count} · sent with your next message · ctrl+s sends now · ctrl+k drops`, `${count} · with your next message · ctrl+s sends · ctrl+k drops`, `${count} · with your next message`]
      : [`${count} · the model reads ${previews.length === 1 ? "it" : "them"} at its next step · ctrl+k drops`, `${count} · read at the next step · ctrl+k drops`, `${count} · read at the next step`]
    ).map((form) => `${HELD_INDENT}${keyText(form)}`)
    return { rows: [fit([{ text: forms.find((form) => lineWidth([{ text: form }]) <= width) ?? forms.at(-1)!, fg: "muted" }], width)] }
  }
  const body: Line[] = []
  let sendChip: { row: number; from: number; to: number } | undefined
  const padded = width >= 70
  const room = Math.max(1, width - 4)
  previews.slice(0, QUEUE_SHOWN).forEach((preview, index) => {
    const chips: Line = [
      ...(index === 0 ? [{ text: SEND, bold: true, ...onColor("primary") }, { text: " " }] : []),
      { text: input.delivery?.[index] === "steer" ? STEER : QUEUED, bold: true, ...onColor("accent") },
    ]
    const text = truncateEnd(`${input.shell?.has(index) ? "$ " : ""}${preview.replace(/\s+/g, " ")}`, Math.max(1, room - lineWidth(chips) - 4))
    const left: Line = [{ text: "… ", fg: "muted" }, { text, fg: "body" }]
    const gap = Math.max(1, room - lineWidth(left) - lineWidth(chips))
    if (index === 0) {
      const from = 2 + lineWidth(left) + gap
      sendChip = { row: 2 + (padded ? 1 : 0), from, to: from + SEND.length }
    }
    body.push([...left, { text: " ".repeat(gap) }, ...chips])
  })
  if (previews.length > QUEUE_SHOWN) body.push([{ text: `+${previews.length - QUEUE_SHOWN} more`, fg: "muted" }])
  const mode = input.mode ?? "after-response"
  // Held says why: a cancel stops the queue too, so a message of another session or a task does not restart what the user stopped.
  const label = input.paused ? "Paused" : input.held ? "Held since your cancel" : mode === "after-tools" ? "After tools" : mode === "immediate" ? "Sending" : "After response"
  const hints = keyText(input.paused ? padded ? "/unpause to continue · ctrl+k drop last" : "/unpause · ctrl+k drop" : padded ? `ctrl+s ${input.held ? "sends them" : "send now"} · ctrl+k drop last · ${preferChord() ? "ctrl+x ^" : "alt+↑"} edit` : "ctrl+s send · ctrl+k drop")
  const header = fit(spread([{ text: "Queue", fg: "primary" }], [{ text: hints, fg: "muted" }], width), width)
  const rows = [header, ...panelGrid({ rows: [[{ title: `${previews.length} queued · ${label}`, body }]], width, compact: false, maxColumns: 1, padding: padded })]
  return { rows, ...(sendChip ? { sendChip } : {}) }
}
