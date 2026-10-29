import { matchingRule, policyRules, projectRulesOf } from "@mendcode/engine-native"
import type { PermissionRule, Settings } from "@mendcode/protocol"

/** What the daemon answers while the switch is off: no git or gh process has been started. */
export const GIT_ACTIONS_OFF = "[GIT]: push and pull requests are off: they reach the network through git and gh, so turn them on with /experimental git_actions on"

/**
 * The user's `permission.bash` deny rules (docs/permissions.md) applied to the commands the Git page is about to run. The page is not the model, so it asks
 * no one and honours no allow rule; but a command the user denied is refused here too, with the rule named. The rules are the ones the engine reads
 * for a shell call (settings, the project's saved rules, the session's own) and they are matched the same way, last match wins, on each command line given.
 */
export function denyingRule(input: { settings: Settings; directory: string; session?: readonly PermissionRule[] | undefined }): (lines: string[]) => string | undefined {
  const rules = policyRules({ permission: input.settings.permission }, undefined, input.session, projectRulesOf(input.settings, input.directory))
  return (lines) => {
    for (const line of lines) {
      const rule = matchingRule("bash", line, rules)
      if (rule?.action === "deny") return `your permission rule bash "${rule.pattern}" denies ${line.length > 80 ? `${line.slice(0, 77)}...` : line}`
    }
    return undefined
  }
}
