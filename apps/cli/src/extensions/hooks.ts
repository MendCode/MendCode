import type { MessageData, MessageStyle } from "@mendcode/extension-api"
import type { Line } from "../ui/theme"

/** One tool call as the transcript knows it, handed to a tool renderer extension. */
export type ToolView = {
  /** Tool name ("shell", "edit", "custom__x", "mcp__s__t"). */
  tool: string
  /** What follows the name in the card title ("src/a.ts", a command…). */
  detail: string
  /** The call's whole arguments once it finished (bounded, frozen); absent while it runs or when the daemon cut them. */
  input?: import("./tool-args").ToolArgs
  output: string
  status: "running" | "ok" | "error" | "cancelled" | "interrupted" | "unknown" | undefined
  /** Cells available to the card body. */
  width: number
  expanded: boolean
}

/**
 * The transcript's two extension points, injected per app (never module state, so two apps in one process stay
 * apart). Without extensions the app passes nothing and the transcript does no extra work.
 */
export type TranscriptHooks = {
  /** Assistant markdown before it is drawn (extensions' `markdown` transforms, in load order). */
  markdown(text: string, message?: MessageData, width?: number): string
  message?(message: MessageData, width: number): Line[] | undefined
  messageStyle?(role: "user" | "assistant" | "tool" | "meta"): MessageStyle | undefined
  /** A replacement card body, or undefined for the default card. */
  tool(view: ToolView): Line[] | undefined
  /** Changes whenever the answers of `markdown`/`tool` may differ; part of the cached block's key. */
  generation(): number
}
