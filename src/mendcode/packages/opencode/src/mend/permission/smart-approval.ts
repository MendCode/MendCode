import type { PermissionRequest } from "@mendcode/sdk/v2"
import { ShellID } from "@/tool/shell/id"
import { resolveModelRoles } from "@/mend/config/models"
import { readPermissionsConfig } from "@/mend/config/permissions"
import { runProviderAdapter } from "@/mend/runtime/provider-adapters"
import { errorMessage } from "@/util/error"

export type SmartPermissionDecision = {
  triggered: boolean
  decision: "allow" | "reject" | "ask"
  reason: string
}

const DANGEROUS_COMMAND_RE = /\b(rm|unlink|rmdir|del|erase|remove-item|rd|chmod|chown|sudo|su|curl|wget|bash|sh|zsh|python|python3|node|bun|npm|pnpm|yarn|npx|docker|kubectl|osascript|dd|mkfs|diskutil)\b/i
const SCRIPT_RE = /(^|\s)(\.\/|\/|~\/)?[^\s;&|]+\.(sh|bash|zsh|py|js|ts|mjs|cjs|rb|pl|ps1)(\s|$)/i
const DESTRUCTIVE_FLAG_RE = /\s(-rf|-fr|--force|--recursive|-recurse)\b/i
const SMART_APPROVAL_TIMEOUT_MS = 20_000

function commandFromRequest(request: PermissionRequest) {
  const metadataCommand = request.metadata?.command
  if (typeof metadataCommand === "string" && metadataCommand.trim()) return metadataCommand.trim()
  return request.patterns.join(" && ").trim()
}

export function shouldTriggerSmartApproval(request: PermissionRequest) {
  if (request.permission !== ShellID.ToolID && request.permission !== "bash") return false
  const command = commandFromRequest(request)
  if (!command) return false
  return DANGEROUS_COMMAND_RE.test(command) || SCRIPT_RE.test(command) || DESTRUCTIVE_FLAG_RE.test(command)
}

function parseDecision(text: string): SmartPermissionDecision {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "")
  try {
    const parsed = JSON.parse(cleaned)
    const decision = parsed?.decision === "allow" || parsed?.decision === "reject" ? parsed.decision : "ask"
    const reason = typeof parsed?.reason === "string" && parsed.reason.trim() ? parsed.reason.trim().slice(0, 180) : "No usable reason returned."
    return { triggered: true, decision, reason }
  } catch {
    return { triggered: true, decision: "ask", reason: "Reviewer model did not return strict JSON." }
  }
}

export async function reviewPermissionRequestWithModel(request: PermissionRequest, root: string): Promise<SmartPermissionDecision> {
  if (!shouldTriggerSmartApproval(request)) return { triggered: false, decision: "ask", reason: "Not a risky shell permission." }

  const config = await readPermissionsConfig()
  const resolved = await resolveModelRoles(root)
  const role = (resolved.roles as Record<string, any>)[config.reviewerRole]
  if (!resolved.enabled || !role?.configured || !role.providerID || !role.modelID) {
    return { triggered: true, decision: "ask", reason: `Permission reviewer role is not configured: ${config.reviewerRole}.` }
  }

  const command = commandFromRequest(request)
  const result = await Promise.race([
    runProviderAdapter(root, {
      providerID: role.providerID,
      modelID: role.modelID,
      authMode: role.authMode || "api-key",
      instructions: [
        "You are a strict local terminal permission reviewer.",
        "Return only JSON: {\"decision\":\"allow|reject|ask\",\"reason\":\"short reason\"}.",
        "Allow only commands that are clearly bounded, non-destructive, and scoped to the current project.",
        "Reject destructive deletes, privilege escalation, disk formatting, broad chmod/chown, secret exfiltration, or commands that download and execute remote code.",
        "Use ask when context is insufficient.",
      ].join("\n"),
      messages: [{
        role: "user",
        content: [
          `permission=${request.permission}`,
          `patterns=${request.patterns.join(" | ")}`,
          `command=${command}`,
          `metadata=${JSON.stringify(request.metadata || {})}`,
        ].join("\n"),
      }],
    }),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Smart Approval timed out after ${SMART_APPROVAL_TIMEOUT_MS / 1000}s.`)), SMART_APPROVAL_TIMEOUT_MS)
    }),
  ]).catch((error): { ok: false; errorPreview: string } => ({
    ok: false,
    errorPreview: errorMessage(error),
  }))

  if (!result.ok) return { triggered: true, decision: "ask", reason: result.errorPreview || "Permission reviewer model failed." }
  return parseDecision(result.outputText || "")
}
