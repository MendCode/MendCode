/**
 * The prompt a run submits, as one text and an image count: what a child's higher-permission card shows and the one
 * submission the approval lets through. Undefined for a submission that also picks a model or an agent of its own.
 * Its own module, imported where a run asks for a higher mode, so a terminal that never does carries none of it.
 */
export function launchOf(command: { type: string; text?: string; name?: string; args?: string; contextText?: string | undefined; attachments?: readonly unknown[] | undefined; selection?: unknown }): { text: string; images: number } | undefined {
  if (command.selection !== undefined) return undefined
  const images = command.attachments?.length ?? 0
  if (command.type === "user.submit" && typeof command.text === "string") return { text: command.text, images }
  if (command.type === "commands.execute" && typeof command.name === "string") return { text: `/${command.name}${command.args ? ` ${command.args}` : ""}${command.contextText ?? ""}`, images }
  return undefined
}
