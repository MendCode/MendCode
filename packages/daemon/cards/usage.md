---
summary: context, tokens and provider quota windows, and how to show them
docs: usage, usage-limit, sidebar, budgets
aliases: quota, quotas, limits, rate-limits, context, tokens
---
MendCode's own readings are the only source of usage and quota. Never read another program's cache or login files (~/.codex, ~/.claude, ~/.pi) for it. A window MendCode has no reading for is unknown: show n/a, never 0% or 100%.

Where the numbers come from:
  context and tokens: this session's own calls (ctx.stats).
  quota windows: only what a provider itself reports. A ChatGPT login on the native engine sends the 5h and weekly windows and their reset time with every response; the Codex engine and Claude Code report theirs in events; an API key reports none. A reading belongs to its provider: a session on ChatGPT does not refresh Claude's, which keeps its last reading.
  A window that already reset is n/a. A reading older than 15 minutes in a live window is stale: show it dimmed with a compact age (62% left ~2d). A fresh one keeps its reset countdown.
  quotaRefresh [{"provider":"codex","everyMinutes":15}] (/customize; off by default; min 5 minutes) has the daemon ask for the windows: one request per listed provider while a terminal is open, skipped after a fresh turn, paused at a limit, stopped after 3 failures. Each probe spends some of the quota it measures (free on the Codex engine); a Claude probe is one minimal Claude Code turn on Haiku (its own prompt plus one word). Set it if the user asks for it.

Without code: footer segment quota (quotaView used|left, quotaColor pressure|accent), the limits card of the right panel (/panel). More: {{program}} docs footer.
In an extension, ctx.usage in a slot and api.usage() (read-only, free) are
  { context?: {usedPercent, tokens, limit}, tokens: {input, output, reasoning, cacheRead, cacheWrite}, costMicros?, quota: [{provider, window, usedPercent, leftPercent, resetsAt?, observedAt, ageMs, stale}] }
usedPercent + leftPercent = 100. A window not in quota is unknown. A statusline.json script gets the list in the env MENDCODE_USAGE_JSON.

Minimal quota footer, two rows (a .ts file in extensions):
  export default { name: "quota-footer", tui(api) {
    const span = (ms) => { const m = Math.floor(ms / 60000)
      return m >= 1440 ? Math.floor(m / 1440) + "d" + Math.floor(m / 60) % 24 + "h" : m >= 60 ? Math.floor(m / 60) + "h" + m % 60 + "m" : m + "m" }
    api.slot("footer.right", ({ usage, now }) => ["codex", "claude"].map((provider) => {
      const row = [{ text: provider.toUpperCase() + "  ", fg: "primary" }]
      for (const window of ["7d", "5h"]) {
        const q = usage.quota.find((r) => r.provider === provider && r.window === window)
        const ended = !q || (q.resetsAt && q.resetsAt <= now)
        const text = ended ? window + " n/a" : window + " " + q.leftPercent + "% left" + (q.stale ? " ~" + span(q.ageMs).replace(/(\d+[dhm]).*/, "$1") : q.resetsAt ? " · reset " + span(q.resetsAt - now) : "")
        row.push({ text: text + "  ", fg: ended || q.stale ? "muted" : "text" })
      }
      return row
    }))
  } }
Spend limits and prices: {{program}} docs budgets. A paused turn: /limit.
