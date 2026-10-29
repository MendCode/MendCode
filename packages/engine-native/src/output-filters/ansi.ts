import type { OutputFilter } from "./types"

const CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g

/** Colour codes and progress redraws (`\r` overwrites) carry no information for the model. */
export const ansi: OutputFilter = {
  id: "ansi",
  matches: () => true,
  apply(text) {
    const clean = text.replace(OSC, "").replace(CSI, "")
    if (!clean.includes("\r")) return clean
    return clean.split("\n").map((line) => {
      const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line
      const at = trimmed.lastIndexOf("\r")
      return at === -1 ? trimmed : trimmed.slice(at + 1)
    }).join("\n")
  },
}
