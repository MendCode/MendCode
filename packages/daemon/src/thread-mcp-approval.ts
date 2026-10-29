import { agentAllows, matchingRule, policyRules, projectRulesOf, toolDisabled, type AgentProfile } from "@mendcode/engine-native"
import { effectiveSettings, type PermissionRule, type Settings } from "@mendcode/protocol"
import type { TurnInput } from "@mendcode/kernel"

/** The bridge uses the same host, project, agent and session rules as native tools; it never trusts engine-side consent. */
export function bridgeAuthorizer(input: {
  turn: TurnInput
  directory: string
  settings(): Settings
  profile(): AgentProfile | undefined
  sessionRules(): readonly PermissionRule[]
  allowed(): boolean
  mask(text: string): string
}) {
  const approved = new Set<string>()
  return async (name: string, args: Record<string, unknown>, read: boolean) => {
    const family = name === "delegate_task" ? "task" : "threads"
    const individual = !read && ["thread_read", "thread_search", "thread_wait"].includes(name)
    const key = `${name}:${JSON.stringify(args)}`
    const decision = () => {
      const profile = input.profile()
      const rules = policyRules(effectiveSettings(input.settings()), profile?.permissionRules, input.sessionRules(), projectRulesOf(input.settings(), input.directory))
      if (!input.allowed() || (profile && !agentAllows(profile, family)) || toolDisabled(family, rules) || toolDisabled(name, rules)) return "deny"
      if (input.turn.permissionMode() === "plan" && !read && !individual) return "deny"
      const specific = matchingRule(name, String(args.sessionId ?? "*"), rules)
      const general = matchingRule(family, String(args.sessionId ?? "*"), rules)
      if (specific?.action === "deny" || general?.action === "deny") return "deny"
      return specific?.action ?? general?.action
    }
    const action = decision()
    if (action === "deny") return false
    if (!individual && (action === "allow" || approved.has(key) || (action !== "ask" && (read || input.turn.permissionMode() === "full")))) return true
    const answer = await input.turn.ask({ kind: "approval", title: name, detail: input.mask(JSON.stringify(args)) })
    if (answer.kind !== "approve" || decision() === "deny" || input.turn.signal.aborted) return false
    if (!individual && answer.scope === "session") approved.add(key)
    return true
  }
}
