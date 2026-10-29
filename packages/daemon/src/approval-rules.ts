import { approvalRuleOffer, withApprovalRules } from "@mendcode/protocol"
import type { ApprovalRule, ApprovalRuleLevel, SessionEvent, Settings } from "@mendcode/protocol"

type PendingRequest = Extract<SessionEvent, { type: "server.request" }>

/** The rule "always allow" would save for a pending approval; the daemon derives it, a client never names the pattern. */
export function offerFor(request: PendingRequest | undefined) {
  if (!request || request.kind !== "approval" || request.planReview || !request.permissionContext) return undefined
  return approvalRuleOffer({ name: request.permissionContext.name, ...(request.permission ? { permission: request.permission } : {}), patterns: request.permissionContext.patterns })
}

/**
 * The settings patch that saves `rules` as allow rules: for one project (`projectConfig[directory].permission`, kept in the
 * daemon's own settings, never in the repository) or for every project (`permission`).
 */
export function approvalRulePatch(input: { settings: Settings; level: ApprovalRuleLevel; directory: string; rules: readonly ApprovalRule[] }): Partial<Record<keyof Settings, unknown>> {
  if (input.level === "user") return { permission: withApprovalRules(input.settings.permission, input.rules) }
  const current = input.settings.projectConfig?.[input.directory]
  return { projectConfig: { ...input.settings.projectConfig, [input.directory]: { ...current, permission: withApprovalRules(current?.permission, input.rules) } } }
}
