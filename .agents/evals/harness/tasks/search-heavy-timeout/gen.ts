/**
 * Deterministic generator for this task's 150-file repo (kept for review and regeneration; the agent never sees it).
 *   bun .agents/evals/harness/tasks/search-heavy-timeout/gen.ts
 * Rewrites repo/src (except nothing else) and check/expected-ms.json from a fixed seed.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

const taskDir = import.meta.dir
const srcDir = path.join(taskDir, "repo", "src")

function mulberry32(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const random = mulberry32(20261006)
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!

const domains: Record<string, string[]> = {
  auth: ["login-form", "token-refresh", "password-reset", "session-store", "mfa-challenge", "oauth-callback", "device-trust", "logout-all", "api-keys", "invite-accept"],
  billing: ["invoice-pdf", "tax-lookup", "proration", "dunning", "ledger-export", "credit-notes", "plan-change", "usage-meter", "vat-validate", "receipt-mailer"],
  cart: ["add-item", "remove-item", "price-refresh", "coupon-apply", "stock-hold", "cart-merge", "gift-wrap", "wishlist-move", "bundle-rules", "cart-expiry"],
  catalog: ["product-feed", "category-tree", "image-resize", "sku-import", "facet-index", "price-rules", "variant-picker", "availability", "tag-sync", "seo-slugs"],
  search: ["query-parse", "suggest", "synonyms", "ranking", "index-writer", "spell-fix", "recent-queries", "filters", "result-cache", "analytics"],
  media: ["avatar-upload", "video-transcode", "thumbnail", "cdn-purge", "exif-strip", "gallery", "virus-scan", "watermark", "audio-clip", "signed-urls"],
  notify: ["email-queue", "push-gateway", "sms-relay", "digest", "template-render", "unsubscribe", "bounce-handler", "quiet-hours", "channel-prefs", "webhook-fanout"],
  orders: ["order-create", "order-status", "refund-flow", "fraud-score", "fulfilment", "split-order", "order-export", "return-label", "checkout-notify", "reorder"],
  payments: ["card-vault", "wallet-pay", "bank-transfer", "payout-batch", "chargeback", "fx-rates", "payment-intent", "three-ds", "reconcile", "checkout-client"],
  profile: ["address-book", "preferences", "avatar-crop", "privacy-export", "delete-account", "newsletter", "locale", "badges", "activity-feed", "linked-accounts"],
  reports: ["daily-rollup", "csv-export", "funnel", "cohort", "revenue-chart", "retention", "scheduled-mail", "pivot", "audit-trail", "slow-queries"],
  shipping: ["rate-quote", "label-print", "tracking-poll", "address-verify", "carrier-select", "customs-forms", "pickup-slots", "zone-map", "insurance", "dispatch"],
  support: ["ticket-create", "macro-apply", "sla-timer", "chat-handoff", "kb-search", "csat-survey", "escalation", "merge-tickets", "canned-replies", "agent-routing"],
  sync: ["delta-pull", "conflict-merge", "offline-queue", "full-resync", "cursor-store", "schema-migrate", "batch-upload", "tombstones", "clock-skew", "peer-discovery"],
  users: ["user-search", "role-assign", "bulk-invite", "directory-sync", "deactivate", "impersonate", "team-list", "seat-count", "audit-log", "lifecycle"],
}

const camel = (name: string) => name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())
const constant = (name: string) => name.toUpperCase().replace(/-/g, "_")
const timeouts = [2000, 3000, 5000, 8000, 10000, 10000, 10000, 15000, 30000]
const blurbs = ["Handles the request lifecycle.", "Thin wrapper around the upstream service.", "Keeps the hot path allocation free.", "Retries are owned by the caller.", "Metrics are emitted by the shared logger."]

rmSync(srcDir, { recursive: true, force: true })
const expected: Record<string, Record<string, number>> = {}
let files = 0

function write(relative: string, content: string) {
  const target = path.join(srcDir, relative)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, content)
  files++
}

for (const [domain, names] of Object.entries(domains)) {
  for (const name of names) {
    const base = constant(name)
    const relative = `${domain}/${name}.ts`
    const key = `src/${relative}`
    if (domain === "payments" && name === "checkout-client") {
      write(
        relative,
        `import { timeoutError } from "../shared/errors"

/** Longest a checkout call to the payment gateway may take before we give up on it. */
export const CHECKOUT_REQUEST_TIMEOUT_MS = 10_000
export const CHECKOUT_REQUEST_RETRIES = 1

export type CheckoutRequest = { cartId: string; timeoutMs: number }

export function createCheckoutRequest(cartId: string): CheckoutRequest {
  return { cartId, timeoutMs: CHECKOUT_REQUEST_TIMEOUT_MS }
}

export function checkoutTimeout(): Error {
  return timeoutError("checkout", CHECKOUT_REQUEST_TIMEOUT_MS)
}
`,
      )
      expected[key] = { CHECKOUT_REQUEST_TIMEOUT_MS: 25000 }
      continue
    }
    if (domain === "orders" && name === "checkout-notify") {
      write(
        relative,
        `import { timeoutError } from "../shared/errors"

/** Customer notification sent after checkout completes; unrelated to the payment call itself. */
export const CHECKOUT_NOTIFY_TIMEOUT_MS = 10_000

export function notifyTimeout(): Error {
  return timeoutError("checkout notification", CHECKOUT_NOTIFY_TIMEOUT_MS)
}
`,
      )
      expected[key] = { CHECKOUT_NOTIFY_TIMEOUT_MS: 10000 }
      continue
    }
    if (domain === "cart" && name === "cart-expiry") {
      write(
        relative,
        `/** How long an abandoned cart (including one stuck mid-checkout) is kept. */
export const CART_EXPIRY_TTL_MS = 1_800_000
export const CART_EXPIRY_SWEEP_MS = 60_000

export function isExpired(createdAtMs: number, nowMs: number): boolean {
  return nowMs - createdAtMs > CART_EXPIRY_TTL_MS
}
`,
      )
      expected[key] = { CART_EXPIRY_TTL_MS: 1800000, CART_EXPIRY_SWEEP_MS: 60000 }
      continue
    }
    const timeout = pick(timeouts)
    const retries = 1 + Math.floor(random() * 4)
    const separator = random() < 0.5
    const literal = separator ? String(timeout).replace(/(\d)(?=(\d{3})$)/, "$1_") : String(timeout)
    write(
      relative,
      `/** ${domain}/${name}: ${pick(blurbs)} */
export const ${base}_TIMEOUT_MS = ${literal}
export const ${base}_RETRIES = ${retries}

export function ${camel(name)}(input: string): string {
  return \`${domain}:${name}:\${input}\`
}
`,
    )
    expected[key] = { [`${base}_TIMEOUT_MS`]: timeout }
  }
}

write(
  "shared/errors.ts",
  `/** Builds the error thrown when a call exceeds its limit, e.g. "<label> request timed out after <ms>ms". */
export function timeoutError(label: string, ms: number): Error {
  return new Error(\`\${label} request timed out after \${ms}ms\`)
}
`,
)
write(
  "shared/ids.ts",
  `let counter = 0

export function nextId(prefix: string): string {
  counter += 1
  return \`\${prefix}_\${counter.toString(36)}\`
}
`,
)
write(
  "index.ts",
  `export { createCheckoutRequest, checkoutTimeout } from "./payments/checkout-client"
export { notifyTimeout } from "./orders/checkout-notify"
export { timeoutError } from "./shared/errors"
`,
)

writeFileSync(path.join(taskDir, "check", "expected-ms.json"), `${JSON.stringify(expected, null, 1)}\n`)
console.log(`wrote ${files} source files`)
