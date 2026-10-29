import type { ApprovalRuleOffer } from "@mendcode/protocol/wire"

const MAX_PATTERNS = 3
const MODE_REASON: Record<string, string> = {
  ask: "ask mode asks before every change or command",
  edits: "edits mode lets file edits run but asks before commands",
  smart: "smart mode asks when its rules cannot clear the call",
  plan: "plan mode is read-only",
}

/**
 * The "explain this request" text of an approval (`?`): what is being asked, why it asks and what each choice does.
 * Built from what the terminal already holds (no model call), one string per row, to be wrapped by the caller.
 */
export function explainApproval(input: {
  tool?: string | undefined
  permission?: "read" | "write" | "execute" | undefined
  mode: string
  /** The "Why it asks" line the daemon appended in smart mode, when there is one. */
  why?: string | undefined
  context?: { name: string; patterns: readonly string[] } | undefined
  offer?: ApprovalRuleOffer | undefined
  /** The engine's own safety check raised this call although the session is in full access. */
  engineFlagged?: boolean | undefined
}): string[] {
  const { tool, permission, context, offer } = input
  const does = permission === "write" ? "change files" : permission === "execute" ? "run something on this machine" : "read something"
  const rows = [`${tool ?? "the agent"} wants to ${does}.`]
  if (input.engineFlagged) {
    rows.push("Why it asks: the engine's own safety check flagged this call, so full access does not waive it (the engineSafetyPrompts setting turns that off).")
    rows.push("Allow once runs only this call; a call the engine flagged has no session or always choice.")
    rows.push("Reject tells the agent no. Type text to tell it what to do instead.")
    return rows
  }
  rows.push(`Why it asks: ${input.why ?? MODE_REASON[input.mode] ?? `no rule allows it in ${input.mode} mode`}.`)
  if (context?.patterns.length) {
    const shown = context.patterns.slice(0, MAX_PATTERNS).join(", ")
    rows.push(`It matched ${context.name}: ${shown}${context.patterns.length > MAX_PATTERNS ? ` and ${context.patterns.length - MAX_PATTERNS} more` : ""}.`)
  }
  rows.push("Allow once runs only this call. Allow for this session stops asking for it until the session ends.")
  rows.push(offer ? `Always allow saves an allow rule for ${offer.label}, for this project or for all of them; settings hold it and it can be removed there.` : "This request has no safe rule to save, so it can only be allowed once or for the session.")
  rows.push(`Reject tells the agent no. Type text${offer ? ", or pick Reject with a note," : ""} to tell it what to do instead.`)
  return rows
}
