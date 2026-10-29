import { z } from "zod"
import { lazySchema } from "./lazy"

export const ConsoleUrl = z.string().url().max(2048).refine((value) => {
  try {
    const url = new URL(value)
    return ["http:", "https:"].includes(url.protocol) && ["127.0.0.1", "[::1]"].includes(url.hostname) && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/"
  } catch { return false }
}, { message: "Console URL must be a literal loopback HTTP(S) origin" })
export const ConsoleAccount = lazySchema(() => z.strictObject({ accountID: z.string().min(1).max(200), accountEmail: z.string().max(200), accountUrl: ConsoleUrl, active: z.boolean(), activeOrgID: z.string().max(200).nullable() }))
export type ConsoleAccount = z.infer<typeof ConsoleAccount>
export const ConsoleOrg = lazySchema(() => z.strictObject({ accountID: z.string().min(1).max(200), accountEmail: z.string().max(200), accountUrl: ConsoleUrl, orgID: z.string().min(1).max(200), orgName: z.string().max(200), active: z.boolean() }))
export type ConsoleOrg = z.infer<typeof ConsoleOrg>
export const ConsoleReport = lazySchema(() => z.strictObject({ enabled: z.boolean(), url: ConsoleUrl.optional(), tokenConfigured: z.boolean(), accounts: z.array(ConsoleAccount).max(100), orgs: z.array(ConsoleOrg).max(1000), consoleManagedProviders: z.array(z.string().max(100)).max(200), activeOrgName: z.string().max(200).optional(), switchableOrgCount: z.number().int().nonnegative(), quota: z.strictObject({ used: z.number().nonnegative(), limit: z.number().positive(), resetAt: z.number().nonnegative().optional() }).optional(), billingUrl: z.string().url().max(2048).optional(), unavailableAccountIDs: z.array(z.string().max(200)).max(100).optional(), metadataError: z.string().max(500).optional() }))
export type ConsoleReport = z.infer<typeof ConsoleReport>
export const ConsoleLogin = lazySchema(() => z.strictObject({ loginID: z.string().max(100), url: z.string().url().max(2048), userCode: z.string().max(100), expiresAt: z.number().nonnegative(), intervalMs: z.number().int().positive() }))
export type ConsoleLogin = z.infer<typeof ConsoleLogin>
export type ConsolePoll = { status: "pending" | "slow" | "expired" | "denied" | "success"; intervalMs?: number; accountEmail?: string }
export const SessionShare = lazySchema(() => z.strictObject({ sessionId: z.string().max(200), policy: z.enum(["disabled", "manual", "auto"]), url: z.string().url().max(2048).optional(), syncedAt: z.number().nonnegative().optional(), pending: z.boolean(), truncated: z.boolean().optional(), error: z.string().max(500).optional() }))
export type SessionShare = z.infer<typeof SessionShare>
/** A Console-free share: a local HTML page (`path`, `url` is `file://`) or a secret gist (`url`, `id`). */
export const StaticShare = lazySchema(() => z.strictObject({ sessionId: z.string().max(200), target: z.enum(["local", "gist"]), shared: z.boolean(), url: z.string().max(2048).optional(), path: z.string().max(4096).optional(), id: z.string().max(200).optional(), at: z.number().nonnegative().optional(), turns: z.number().int().nonnegative().optional(), truncated: z.boolean().optional() }))
export type StaticShare = z.infer<typeof StaticShare>

export const ConsoleState = lazySchema(() => ConsoleReport.pick({ consoleManagedProviders: true, activeOrgName: true, switchableOrgCount: true }))
export type ConsoleState = z.infer<typeof ConsoleState>
export const ConsoleSwitchInput = lazySchema(() => z.strictObject({ accountID: z.string().min(1).max(200), orgID: z.string().min(1).max(200) }))
