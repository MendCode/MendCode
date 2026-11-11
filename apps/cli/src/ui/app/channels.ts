import type { ChannelsChange, ChannelsReport } from "@mendcode/protocol"
import type { AppContext } from "./context"

export const REMOTE_CONTROL_USAGE = "usage: /remote-control [discord] [on | off | pair | unpair [chat id]]"

type Service = "telegram" | "discord"
type ServiceReport = ChannelsReport["telegram"]
const SETUP: Record<Service, string> = {
  telegram: "Create a bot with @BotFather, put its token in MENDCODE_TELEGRAM_TOKEN (or a private telegram-token file in the data directory), then /remote-control on",
  discord: "Create a bot in the Discord Developer Portal, turn on its Message Content intent, invite it to your server, put its token in MENDCODE_DISCORD_TOKEN (or a private discord-token file in the data directory), then /remote-control discord on",
}

/**
 * `/remote-control [discord]` manages the opt-in Telegram and Discord bridges: turn one on, make a pair code, list or unpair chats.
 * The daemon owns the bot tokens and the chat lists; this only shows state and sends changes, and never sees a token.
 */
export function createChannels(ctx: AppContext) {
  const { input, say, fail, requestFrame } = ctx

  function describe(report: ServiceReport, service: Service = "telegram") {
    const command = service === "telegram" ? "/remote-control" : "/remote-control discord"
    const name = service === "telegram" ? "remote control" : "Discord remote control"
    if (!report.enabled) return report.tokenConfigured ? `${name} off; ${command} on starts the ${service === "telegram" ? "Telegram" : "Discord"} bridge` : `${name} off. ${SETUP[service]}`
    const chats = report.chats.length ? `${report.chats.length} paired: ${report.chats.map((chat) => chat.name ? `${chat.name} (${chat.id})` : chat.id).join(", ")}` : `no ${service === "telegram" ? "chat" : "channel"} paired; ${command} pair`
    if (report.running) return `${name} on${report.botName ? ` as @${report.botName}` : ""} · ${chats}`
    return `${name} enabled but not connected${report.error ? `: ${report.error}` : ""}`
  }
  const reportOf = (report: ChannelsReport, service: Service): ServiceReport | undefined => service === "telegram" ? report.telegram : report.discord

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
    const named = /^(telegram|discord)$/i.test(words[0] ?? "") ? words.shift()!.toLowerCase() as Service : undefined
    const service: Service = named ?? "telegram"
    const channel = named === "discord" ? { channel: "discord" as const } : {}
    const head = (words[0] ?? "").toLowerCase()
    if (head === "") {
      const reply = await input.send({ type: "channels.status" })
      if (!reply.ok) { fail(reply.error.message); return true }
      const full = reply.result as unknown as ChannelsReport
      // Bare: Telegram's state, and Discord's too once it is set up.
      const shown: Service[] = named ? [named] : full.discord && (full.discord.enabled || full.discord.tokenConfigured) ? ["telegram", "discord"] : ["telegram"]
      const reports = shown.map((entry) => ({ entry, report: reportOf(full, entry) }))
      const lines = reports.map(({ entry, report }) => (report ? describe(report, entry) : "this daemon has no Discord bridge yet; update MendCode"))
      const warn = reports.some(({ report }) => !report || (report.enabled && !report.running))
      // One notice: the notice row shows a single message, so both bridges share it.
      say(lines.join(" · "), warn ? "warning" : "info")
      return true
    }
    if (head === "on" || head === "off") {
      const result = await change({ action: head === "on" ? "enable" : "disable", ...channel })
      const report = result && reportOf(result, service)
      if (report) say(describe(report, service), head === "on" && !report.running ? "warning" : "success")
      requestFrame()
      return true
    }
    if (head === "pair") {
      // The chat follows this session: what is typed here shows there, and the phone continues it.
      const result = await change({ action: "pair", directory: input.directory ?? ".", ...(ctx.state.sessionId ? { sessionId: ctx.state.sessionId } : {}), ...channel })
      if (result?.pairing) {
        const botName = reportOf(result, service)?.botName
        const bot = service === "discord" ? "your Discord channel" : botName ? `@${botName}` : "your bot"
        const left = Math.max(60_000, result.pairing.expiresAt - Date.now())
        const minutes = Math.round(left / 60_000)
        // Short enough to fit the notice row whole, on screen until the code expires, and the whole /pair command on the clipboard.
        ctx.copyText(`/pair ${result.pairing.code}`, `/pair ${result.pairing.code}`, { hint: `paste to ${bot} · ${minutes} min`, ms: left })
      }
      return true
    }
    if (head === "unpair") {
      const result = await change({ action: "unpair", ...(words[1] ? { chatId: words[1] } : {}), ...channel })
      if (result) say(words[1] ? `unpaired ${words[1]}` : `unpaired all ${service === "discord" ? "Discord channels" : "chats"}`, "success")
      return true
    }
    say(REMOTE_CONTROL_USAGE, "warning")
    return true
  }

  return { remoteControlCommand }
}
