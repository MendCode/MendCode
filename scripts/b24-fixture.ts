import type { CompoundConfig, CompoundReport, CompoundRun, ResolvedCompoundProfile, SessionId } from "@mendcode/protocol"

const at = 1_790_891_200_000
export function b24Report(state: CompoundRun["state"] | "off" = "accepted", sessionId = "ses_frame" as SessionId): CompoundReport {
  const limits = { maxModelRequests: 4, maxTotalTokens: 30_000, maxRuntimeMs: 120_000, maxCostUsd: 1, unknownCost: "allow-with-token-cap" as const }
  const profiles: ResolvedCompoundProfile[] = ["single", "cascade", "critic"].map((strategy) => ({ name: strategy, strategy: strategy as ResolvedCompoundProfile["strategy"], primary: { model: "gpt-6-luna", effort: "medium" }, ...(strategy === "cascade" ? { escalation: { model: "gpt-6-sol", effort: "high" as const } } : strategy === "critic" ? { critic: { model: "gpt-6-sol", effort: "high" as const } } : {}), limits: { ...limits }, configHash: "a".repeat(64), pricing: {} }))
  const config: CompoundConfig = { version: 1, orchestration: { enabled: state !== "off", profiles: Object.fromEntries(profiles.map((profile) => [profile.name, { strategy: profile.strategy, primary: { role: "main" }, ...(profile.escalation ? { escalation: { providerID: "openai", modelID: "gpt-6-sol" } } : {}), ...(profile.critic ? { critic: { providerID: "openai", modelID: "gpt-6-sol" } } : {}), limits }])) } }
  if (state === "off") return { config, configHash: "a".repeat(64), profiles, issues: [], runs: [] }
  const roles = state === "unreviewed-revision" ? ["primary", "critic", "revision"] : state === "running" || state === "blocked" ? ["primary"] : ["primary", "critic"]
  const run: CompoundRun = {
    runId: "12345678-1234-1234-1234-123456789abc", directory: "/work/mendcode", profile: profiles[2]!, state, phase: state === "running" ? "critic" : state,
    startedAt: at, ...(state === "running" ? {} : { endedAt: at + 11_240 }), workspace: "/tmp/mendcode-b24/compound-worktrees/12345678-1234-1234-1234-123456789abc", base: "b".repeat(40),
    ...(state === "blocked" ? { reason: "Compound request blocked: unknown_cost" } : state === "unreviewed-revision" ? { reason: "Passed deterministic checks; final revision was not independently reviewed again" } : {}),
    ...(state === "accepted" || state === "unreviewed-revision" ? { fingerprint: "d".repeat(64), result: "Parser handles empty input and preserves Unicode identifiers.", review: { verdict: state === "unreviewed-revision" ? "revise" : "accept", findings: [], summary: "Host checks pass; candidate stays within the parser boundary." } } : {}),
    legs: roles.map((role) => ({ role, sessionId, model: role === "critic" ? "gpt-6-sol" : "gpt-6-luna", state: "completed" })),
    validation: state === "blocked" ? [] : [{ id: "diff", status: "pass", detail: "" }, { id: "parser", status: "pass", detail: "12 tests passed" }],
    ledger: { limits, startedAt: at, requests: roles.map((leg) => ({ requestId: crypto.randomUUID(), leg, model: leg === "critic" ? "gpt-6-sol" : "gpt-6-luna", provider: "local-fake", state: "completed", reservedTokens: 4_500, reservedCostUsd: null, inputTokens: 600, outputTokens: 300, costSource: "unknown", startedAt: at, endedAt: at + 1_000 })), tokens: roles.length * 4_500, costUsd: 0, unknownCosts: roles.length },
  }
  if (state === "running") { run.startedAt = Date.now() - 5_000; run.ledger.startedAt = run.startedAt }
  return { config, configHash: "a".repeat(64), profiles, issues: [], runs: [run], activeRun: run }
}
