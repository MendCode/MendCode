import type { ColorName } from "../theme"
import type { AppState } from "./context"

/** What a chat with a bot wears: the bot's face glyph and name, and its colour role (so every theme, light or dark, draws it). */
export type BotAccent = { name: string; glyph: string; color: ColorName }

type BotIconModule = typeof import("../../view/bot-icon")
let icons: BotIconModule | undefined
let loading: Promise<void> | undefined

/** Loads the bot faces once, off the start-up path (they pull the wire schemas); the frame after the load wears the accent. */
function loadIcons(requestFrame: () => void): void {
  loading ??= import("../../view/bot-icon").then((module) => { icons = module; requestFrame() }, () => { loading = undefined })
}

/**
 * The bot the open session is a chat of: the bot list's answer (a bot's chat, a blank one just started from the sidebar, an external
 * bot's chat) or, with no bot list, the agent the session runs as when that agent is a bot. Undefined for every other session.
 */
export function botAccent(state: AppState, requestFrame: () => void): BotAccent | undefined {
  const agent = state.agentReport?.agents.find((candidate) => candidate.name === state.agentReport?.current)
  const look = state.sidebarBots?.chatLook(state.sessionId) ?? (agent?.bot ? { name: agent.name, shape: agent.bot.shape, color: agent.bot.color } : undefined)
  if (!look) return undefined
  if (!icons) { loadIcons(requestFrame); return undefined }
  const icon = icons.botIcon({ name: look.name, shape: look.shape, color: look.color, ascii: state.glyphMode === "ascii" })
  return { name: look.name, glyph: icon.text.trim(), color: icon.fg }
}
