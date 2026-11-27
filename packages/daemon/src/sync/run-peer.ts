import type { Command } from "@mendcode/protocol"

export const SYNC_TOKEN_REFUSAL = "[SYNC]: a sync token only syncs sessions; to run turns on this machine from a device, make the token with `remote token create --sync --run`"

/**
 * What a `scope: "sync-run"` token may send besides `hello` and `sync.peer` (docs/sync.md, "Running on the hub"): start a chat in a
 * folder this daemon already works in, send a prompt to one of its root sessions, cancel the turn, answer its approvals, move one of its
 * root sessions to another folder inside the ones it works in (`session.cd`) and list the subfolders of such a folder (`session.dirs`, names
 * only). The device sees the result through the mirror. Nothing else: no shell, no files, settings, permission changes, sub-agents or memory.
 */
const RUN_COMMANDS: ReadonlySet<string> = new Set(["session.create", "user.submit", "turn.cancel", "request.resolve", "session.cd", "session.dirs"])

export function syncRunRefusal(input: { command: Command; sessionDirectory(sessionId: string): string | undefined; isRoot(sessionId: string): boolean; knownFolder(directory: string): boolean }): string | undefined {
  const { command } = input
  if (!RUN_COMMANDS.has(command.type)) return SYNC_TOKEN_REFUSAL
  if (command.type === "session.create") {
    if (command.parentId || command.agent || command.choice || command.title) return "[SYNC]: a chat started from a device has no parent, agent, model or title of its own"
    return input.knownFolder(command.directory) ? undefined : "[SYNC]: that folder is not a project of this machine"
  }
  if ("sessionId" in command && command.sessionId !== undefined) {
    if (!input.sessionDirectory(command.sessionId) || !input.isRoot(command.sessionId)) return "[SYNC]: no such chat on this machine"
  }
  if (command.type === "user.submit" && (command.attachments.length > 0 || command.selection?.agent)) return "[SYNC]: a prompt from a device carries text only"
  if (command.type === "request.resolve" && command.decision.kind === "approve" && (command.decision.remember || command.decision.memoryText || command.decision.memoryAlways)) return "[SYNC]: an approval from a device cannot save rules or memories"
  return undefined
}

/** Whether a hub's refusal of `/cd` or its folder list means the hub is an older build that does not know them (it takes them for commands a sync token may not send, or answers a protocol error with no `[TAG]:` prefix, which this daemon's own refusals always have). */
export function hubLacksFolders(reply: { code: string; message: string }): boolean {
  return reply.message.includes("a sync token only syncs sessions") || reply.code === "invalid_command" && !reply.message.startsWith("[")
}
