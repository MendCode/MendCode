import type { ChannelsChange, ChannelsReport } from "@mendcode/protocol"
import type { AppContext } from "./context"

export const REMOTE_CONTROL_USAGE = "usage: /remote-control [on | off | pair | unpair [chat id]]"

/**
 * `/remote-control` manages the opt-in Telegram bridge: turn it on, make a pair code, list or unpair chats.
 * The daemon owns the bot token and the chat list; this only shows state and sends changes, and never sees the token.
 */
export function createChannels(ctx: AppContext) {
  const { input, say, fail, requestFrame } = ctx

  function describe(report: ChannelsReport["telegram"]) {
    if (!report.enabled) return report.tokenConfigured ? "remote control off; /remote-control on starts the Telegram bridge" : "remote control off. Create a bot with @BotFather, put its token in MENDCODE_TELEGRAM_TOKEN (or a private telegram-token file in the data directory), then /remote-control on"
    const chats = report.chats.length ? `${report.chats.length} paired: ${report.chats.map((chat) => chat.name ? `${chat.name} (${chat.id})` : chat.id).join(", ")}` : "no chat paired; /remote-control pair"
    if (report.running) return `remote control on${report.botName ? ` as @${report.botName}` : ""} · ${chats}`
    return `remote control enabled but not connected${report.error ? `: ${report.error}` : ""}`
  }

  async function change(change: ChannelsChange) {
    const reply = await input.send({ type: "channels.change", change })
    if (!reply.ok) { fail(reply.error.message); return undefined }
    return reply.result as unknown as ChannelsReport & { pairing?: { code: string; expiresAt: number } }
  }

  async function remoteControlCommand(text: string): Promise<boolean> {
    const match = /^\/remote-control(?:\s+(.*))?$/s.exec(text.trim())
    if (!match) return false
    if (input.remote) { fail("Remote control is set up on the machine that runs the daemon"); return true }
    const words = (match[1] ?? "").trim().split(/\s+/).filter(Boolean)
    const head = (words[0] ?? "").toLowerCase()
    if (head === "") {
      const reply = await input.send({ type: "channels.status" })
      if (!reply.ok) { fail(reply.error.message); return true }
      const report = (reply.result as unknown as ChannelsReport).telegram
      say(describe(report), report.enabled && !report.running ? "warning" : "info")
      return true
    }
    if (head === "on" || head === "off") {
      const result = await change({ action: head === "on" ? "enable" : "disable" })
      if (result) say(describe(result.telegram), head === "on" && !result.telegram.running ? "warning" : "success")
      requestFrame()
      return true
    }
    if (head === "pair") {
      const result = await change({ action: "pair", directory: input.directory ?? "." })
      if (result?.pairing) {
        const bot = result.telegram.botName ? `@${result.telegram.botName}` : "your bot"
        const minutes = Math.max(1, Math.round((result.pairing.expiresAt - Date.now()) / 60_000))
        say(`pair code ${result.pairing.code}: send /pair ${result.pairing.code} to ${bot} within ${minutes} min. That chat will then run turns in this project.`, "success")
      }
      return true
    }
    if (head === "unpair") {
      const result = await change({ action: "unpair", ...(words[1] ? { chatId: words[1] } : {}) })
      if (result) say(words[1] ? `unpaired ${words[1]}` : "unpaired all chats", "success")
      return true
    }
    say(REMOTE_CONTROL_USAGE, "warning")
    return true
  }

  return { remoteControlCommand }
}
