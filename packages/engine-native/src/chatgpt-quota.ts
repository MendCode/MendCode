import type { GlobalEventDraft } from "@mendcode/kernel"

type QuotaDraft = Extract<GlobalEventDraft, { type: "quota.snapshot" }>

function windowLabel(minutes: number) {
  if (minutes % 1_440 === 0) return `${minutes / 1_440}d`
  if (minutes % 60 === 0) return `${minutes / 60}h`
  return `${minutes}m`
}

function number(headers: Headers, name: string) {
  const raw = headers.get(name)
  if (raw === null || raw.trim() === "") return undefined
  const value = Number(raw)
  return Number.isFinite(value) ? value : undefined
}

/**
 * Subscription quota from the ChatGPT backend's own response headers (x-codex-primary-*, -secondary-*),
 * the same numbers Codex shows (P9: official source, pushed with every response, no polling).
 * Windows with a zero length are absent on the plan and are skipped. Reported as provider "codex"
 * because it is the same subscription the Codex engine reports.
 */
export function chatgptQuota(headers: Headers, fetchedAt: number): QuotaDraft | undefined {
  const windows = (["primary", "secondary"] as const).flatMap((id) => {
    const used = number(headers, `x-codex-${id}-used-percent`)
    const minutes = number(headers, `x-codex-${id}-window-minutes`)
    if (used === undefined || !minutes) return []
    const resetAt = number(headers, `x-codex-${id}-reset-at`)
    return [
      {
        id,
        label: windowLabel(minutes),
        usedPercent: Math.min(100, Math.max(0, used)),
        windowMinutes: Math.round(minutes),
        ...(resetAt ? { resetsAt: Math.round(resetAt * 1_000) } : {}),
      },
    ]
  })
  if (windows.length === 0) return undefined
  const plan = headers.get("x-codex-plan-type")
  const reached = headers.get("x-codex-rate-limit-reached-type")
  return {
    type: "quota.snapshot",
    provider: "codex",
    ...(plan ? { plan } : {}),
    windows,
    status: reached ? "rejected" : windows.some((w) => w.usedPercent >= 90) ? "warning" : "allowed",
    fetchedAt,
    source: "chatgpt backend response headers",
  }
}
