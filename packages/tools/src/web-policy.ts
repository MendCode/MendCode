/** Domain rules for `webfetch` and `websearch` (settings `web`). A block wins; with an allow list only listed domains and their subdomains pass. */
export type WebPolicy = {
  allowDomains?: readonly string[] | undefined
  blockDomains?: readonly string[] | undefined
}

/** An entry as a bare lowercase domain: `https://Example.com/x`, `*.example.com` and `.example.com` all become `example.com`. */
function normalize(entry: string) {
  const text = entry.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^\*?\./, "").split(/[/?#]/, 1)[0] ?? ""
  return text.replace(/:\d+$/, "").replace(/\.$/, "")
}

export function domainRules(policy: WebPolicy | undefined) {
  return {
    allow: (policy?.allowDomains ?? []).map(normalize).filter(Boolean),
    block: (policy?.blockDomains ?? []).map(normalize).filter(Boolean),
  }
}

const within = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`)

/** Whether `host` may be reached under the rules; `reason` is the one-line refusal. */
export function domainAllowed(host: string, policy: WebPolicy | undefined): { ok: true } | { ok: false; reason: string } {
  const { allow, block } = domainRules(policy)
  const name = host.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "")
  const blocked = block.find((domain) => within(name, domain))
  if (blocked) return { ok: false, reason: `${name} is blocked by the web domain rules (${blocked})` }
  if (allow.length && !allow.some((domain) => within(name, domain))) return { ok: false, reason: `${name} is not in the web domain allow list` }
  return { ok: true }
}
