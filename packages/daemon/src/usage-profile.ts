import { homedir } from "node:os"
import path from "node:path"
import type { UsageProfile } from "@mendcode/protocol"

const PLAN_LABELS: Record<string, string> = { free: "Free", plus: "Plus", pro: "Pro", team: "Team", business: "Business", enterprise: "Enterprise", edu: "Edu" }

type IdClaims = { name?: unknown; email?: unknown; "https://api.openai.com/auth"?: { chatgpt_plan_type?: unknown } }

/** "pro" → "Pro"; unknown plan ids are title-cased as they come. */
export function planLabel(plan: string) {
  return PLAN_LABELS[plan.toLowerCase()] ?? plan.charAt(0).toUpperCase() + plan.slice(1)
}

/** Identity claims of a JWT, without verifying it (display only); undefined when it does not parse. */
export function jwtClaims(token: string): IdClaims | undefined {
  try {
    const claims = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as unknown
    return claims && typeof claims === "object" ? (claims as IdClaims) : undefined
  } catch {
    return undefined
  }
}

const text = (value: unknown, max: number) => (typeof value === "string" && value.trim() ? value.trim().slice(0, max) : undefined)

/**
 * The account behind the Codex login (name, email, plan) for the usage page, read from the id_token's
 * claims. Read-only; the tokens themselves are never kept, logged or returned. `{}` when there is no login.
 */
export async function readUsageProfile(authFile = path.join(process.env.CODEX_HOME ?? path.join(homedir(), ".codex"), "auth.json")): Promise<UsageProfile> {
  let idToken: unknown
  try {
    idToken = ((await Bun.file(authFile).json()) as { tokens?: { id_token?: unknown } }).tokens?.id_token
  } catch {
    return {}
  }
  const claims = typeof idToken === "string" ? jwtClaims(idToken) : undefined
  if (!claims) return {}
  const name = text(claims.name, 200)
  const email = text(claims.email, 320)
  const plan = text(claims["https://api.openai.com/auth"]?.chatgpt_plan_type, 60)
  return { ...(name ? { name } : {}), ...(email ? { email } : {}), ...(plan ? { plan: planLabel(plan) } : {}) }
}
