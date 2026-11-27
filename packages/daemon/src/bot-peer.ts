import type { Command } from "@mendcode/protocol"

/**
 * What a `scope: "bot"` token may do (docs/remote.md, "Bot bridge"): the token of a chat bot on another machine that sends each of
 * its turns to this daemon. It creates and talks to sessions inside its own `root` folder, answers their approvals, cancels, and
 * lists models. It cannot read or change settings, secrets, other folders' sessions, memory, shell or anything else, and the
 * daemon's broadcasts (global events) never reach it.
 */
export const BOT_COMMANDS: ReadonlySet<string> = new Set([
  "hello", "session.create", "session.get", "session.delete", "client.subscribe", "client.unsubscribe",
  "user.submit", "queue.remove", "turn.cancel", "request.resolve", "session.run.configure", "session.permission.set", "models.list",
])

/** Whether `directory` is `root` or lies inside it (both already canonical). */
export const insideRoot = (root: string, directory: string) => directory === root || directory.startsWith(root.endsWith("/") ? root : `${root}/`)

/**
 * The reason a bot token may not send `command`, or undefined. `sessionDirectory` answers the folder of an existing session and
 * `canonical` resolves a folder the way the daemon keys projects (symlinks followed), so a link inside the root cannot lead out.
 */
export function botPeerRefusal(input: { command: Command; root: string; sessionDirectory(sessionId: string): string | undefined; canonical(directory: string): string }): string | undefined {
  const { command, root, sessionDirectory, canonical } = input
  if (!BOT_COMMANDS.has(command.type)) return "[BOT]: a bot token only runs turns in its own folder"
  if (command.type === "session.create") {
    if (command.parentId || command.agent) return "[BOT]: a bot session has no parent and no custom agent"
    return insideRoot(root, canonical(command.directory)) ? undefined : "[BOT]: the folder is outside this bot's folder"
  }
  if (command.type === "user.submit" && (command.attachments.length > 0 || command.selection?.agent)) return "[BOT]: a bot message carries text only"
  if ("sessionId" in command && command.sessionId !== undefined) {
    const directory = sessionDirectory(command.sessionId)
    if (!directory || !insideRoot(root, canonical(directory))) return "[BOT]: the session is outside this bot's folder"
  }
  return undefined
}
