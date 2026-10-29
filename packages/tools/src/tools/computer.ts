import { ComputerCaptureInput, ComputerKeyInput } from "@mendcode/protocol"
import { defineTool, type ToolResult } from "../tool"
import { fail } from "../util"
import { createComputerSessionTools, type ComputerActivation } from "./computer-session"

export type ComputerPort = {
  capture(input: ComputerCaptureInput, signal: AbortSignal): Promise<ToolResult>
  key(input: ComputerKeyInput, signal: AbortSignal): Promise<ToolResult>
  session?(input: import("@mendcode/protocol").ComputerSessionInput, signal: AbortSignal, activation?: ComputerActivation): Promise<ToolResult>
  observe?(input: import("@mendcode/protocol").ComputerObserveInput, signal: AbortSignal): Promise<ToolResult>
  code?(input: import("@mendcode/protocol").ComputerCodeInput, signal: AbortSignal): Promise<ToolResult>
}

/** The daemon owns observations and native effects; the engine supplies the session-scoped port after approval. */
export function createComputerTools() {
  return [
    defineTool({
      name: "computer_capture",
      description: "Capture and view the main display, a known positive macOS windowID, or an integer region. Use null or omit absent selectors; never combine a region and windowID. Returns a private PNG path, captureID and lineage. Preview is at most 1600 pixels. Requires Screen Recording permission.",
      permission: "execute",
      args: ComputerCaptureInput,
      async execute(input, context) {
        return context.computer ? context.computer.capture(input, context.signal) : fail({ title: "Computer screenshot", message: "Computer capture is disabled" })
      },
    }),
    defineTool({
      name: "computer_key",
      description: "Press one navigation key in the foreground app observed by computer_capture. A real key press, so it needs that app in front (computer_session press/setValue/observe do not, and work in the background). Supply a captureID from this session, valid for 30 seconds and one action. Requires Accessibility permission. Capture again after each key. Never activates another app; no pointer control or arbitrary text entry.",
      permission: "execute",
      args: ComputerKeyInput,
      async execute(input, context) {
        return context.computer ? context.computer.key(input, context.signal) : fail({ title: "Computer key", message: "Computer keyboard control is disabled" })
      },
    }),
    ...createComputerSessionTools(),
  ]
}
