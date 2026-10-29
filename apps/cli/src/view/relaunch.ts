import type { AgentThread } from "./transcript"

/** What `/relaunch` needs of a sub-agent the user stopped: what it was asked, its type and how far it got. */
export type StoppedAgent = Pick<AgentThread, "description" | "agent" | "background" | "tools" | "last">

/** The stopped sub-agents `/relaunch <words>` names: those whose description holds the words, or every one without words. */
export function relaunchTargets<T extends StoppedAgent>(stopped: readonly T[], words: string): T[] {
  const query = words.trim().toLowerCase()
  return query ? stopped.filter((agent) => agent.description.toLowerCase().includes(query)) : [...stopped]
}

/**
 * The message `/relaunch` sends as the user. Claude Code refuses to resume an agent stopped by an interrupt and starts a new one
 * only when the user asks, so the message asks plainly: the same type and prompt, told what the stopped one had already done.
 */
export function relaunchMessage(stopped: readonly StoppedAgent[]): string {
  const lines = stopped.map((agent) => {
    const progress = agent.tools ? `it had run ${agent.tools} tool${agent.tools === 1 ? "" : "s"}${agent.last ? `, the last one ${agent.last}` : ""}` : "it had not run a tool yet"
    return `- "${agent.description}" (${agent.agent}${agent.background ? ", in the background" : ""}): ${progress}`
  })
  const one = stopped.length === 1
  return [
    `Relaunch the sub-agent${one ? "" : "s"} I stopped with esc. Start ${one ? "it" : "each"} again as a new agent with the same agent type and the same prompt you gave it, in the background if it ran there, and tell it what it had already done so it does not repeat that work:`,
    ...lines,
  ].join("\n")
}
