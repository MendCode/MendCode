import type { CommandReply } from "@mendcode/client"

const inFlight = new WeakMap<object, Promise<CommandReply>>()

/**
 * One `bot.list` at a time per terminal: the left list and the home's Bots block both ask in their first frames, in either order,
 * and a second request while one is on its way takes the same answer instead of making the daemon do the work twice.
 */
export function askBotList(input: { send(command: { type: "bot.list" }): Promise<CommandReply> }): Promise<CommandReply> {
  const held = inFlight.get(input)
  if (held) return held
  const asked = input.send({ type: "bot.list" }).finally(() => inFlight.delete(input))
  inFlight.set(input, asked)
  return asked
}
