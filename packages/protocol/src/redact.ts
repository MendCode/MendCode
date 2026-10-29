/**
 * Pure secret redaction for session text. Zod-free on purpose: the CLI imports it through the wire entry.
 *
 * Every pattern is bounded (no unbounded nested quantifiers, lookbehind-anchored starts) so 60 KB of hostile
 * text cannot trigger catastrophic backtracking, and replacements never re-match, which makes it idempotent.
 */

export type Redaction = { text: string; count: number }

const MARK = (kind: string) => `[redacted:${kind}]`

/** Values that document a secret instead of holding one. */
const PLACEHOLDER =
  /^(?:\[redacted:[^\]]*\]|‹secret:\d{1,6}›|<[^>]*>|\$\{[^}]*\}|\$[A-Za-z_]\w*|\{\{[^}]*\}\}|%[A-Za-z_]+%|[xX*.#_-]+|changeme|change[-_ ]?me|your\S*|(?:my|example|sample|dummy|fake|placeholder|replace|insert|todo)[-_ ].*|null|nil|none|undefined|true|false|empty|string|pass(?:word)?|secret|token|api[-_]?key)$/i

const NUMERIC = /^[0-9.,_-]+$/
const ULID_LIKE = /^[a-z]{2,12}_[0-9][0-9A-HJKMNP-TV-Z]{15,}$/
const URL_VALUE = /^[a-z][a-z0-9+.-]*:\/\//i
const PATH_VALUE = /^(?:(?:~|\.{1,2})\/|\/[a-z])[\w./-]*$/
const DOTTED_IDENTIFIER = /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/
const CAMEL_IDENTIFIER = /^[a-z]+(?:[A-Z][a-z0-9]+)+$/
const CONSTANT_NAME = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/
const LOWERCASE_WORD = /^[a-z]+$/

type TokenRule = { kind: string; pattern: RegExp }

/** Self-identifying credentials; order matters where prefixes overlap (sk-ant- before sk-). */
const TOKEN_RULES: readonly TokenRule[] = [
  { kind: "anthropic-key", pattern: /(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{20,512}/g },
  { kind: "openai-key", pattern: /(?<![A-Za-z0-9])sk-(?:(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,512}|[A-Za-z0-9]{20,512})/g },
  { kind: "github-token", pattern: /(?<![A-Za-z0-9])(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})/g },
  { kind: "aws-access-key-id", pattern: /(?<![A-Za-z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Za-z0-9])/g },
  { kind: "slack-token", pattern: /(?<![A-Za-z0-9])(?:xox[abprs]-[A-Za-z0-9-]{10,255}|xapp-[A-Za-z0-9-]{10,255})/g },
  { kind: "google-api-key", pattern: /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}/g },
  { kind: "stripe-key", pattern: /(?<![A-Za-z0-9])(?:sk|rk)_live_[A-Za-z0-9]{16,255}/g },
  { kind: "jwt", pattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,4096}/g },
]

const PEM_BLOCK =
  /-----BEGIN (?:[A-Z0-9]+ ){0,3}PRIVATE KEY(?: BLOCK)?-----[\s\S]{0,12000}?-----END (?:[A-Z0-9]+ ){0,3}PRIVATE KEY(?: BLOCK)?-----/g

const URL_CREDENTIALS = /(?<![A-Za-z0-9+.-])([a-z][a-z0-9+.-]{1,19}:\/\/)([^\s:@/?#'"<>[\]]{1,128}):([^\s@/?#'"<>]{1,256})@/gi

const AUTH_BEARER = /(\bAuthorization["']?[ \t]*[:=][ \t]*["']?Bearer[ \t]+)([A-Za-z0-9._~+/=-]{8,1024})/gi
const AUTH_BASIC = /(\bAuthorization["']?[ \t]*[:=][ \t]*["']?Basic[ \t]+)([A-Za-z0-9+/=]{8,1024})/gi

const SECRET_WORDS = "SECRET|TOKEN|PASSWORD|PASSWD|API[_-]?KEY|APIKEY|PRIVATE[_-]?KEY|ACCESS[_-]?KEY"
const NAME_CHARS = "[A-Za-z0-9_.-]"
/**
 * NAME=value, NAME: value, "NAME": "value", export NAME=value (also JSON escaped inside strings).
 * Group 1 keeps everything up to the value, 2 is the name, 3/4 a quoted value, 5 an unquoted one.
 */
const ASSIGNMENT = new RegExp(
  String.raw`((?<!${NAME_CHARS})(${NAME_CHARS}{0,48}(?:${SECRET_WORDS})${NAME_CHARS}{0,48})(?:\\?["'])?[ \t]*([:=])[ \t]*)` +
    String.raw`(?:(\\?["'])([^"'\\\r\n]{8,512})(?=\\?["'])|([^\s"'` + "`" + String.raw`,;(){}<>\[\]\\&]{8,512})(?=[\s,;"'` + "`" + String.raw`)}\]&]|$))`,
  "gi",
)

const NAME_KINDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/aws.?secret/i, "aws-secret"],
  [/pass(?:word|wd)/i, "password"],
  [/api.?key/i, "api-key"],
  [/private.?key/i, "private-key"],
  [/access.?key/i, "access-key"],
  [/token/i, "token"],
  [/secret/i, "secret"],
]

function kindForName(name: string) {
  for (const [pattern, kind] of NAME_KINDS) if (pattern.test(name)) return kind
  return "secret"
}

function isPlaceholder(value: string) {
  return PLACEHOLDER.test(value)
}

function looksLikeCode({ value, separator, quoted }: { value: string; separator: string; quoted: boolean }) {
  if (DOTTED_IDENTIFIER.test(value) || CAMEL_IDENTIFIER.test(value) || CONSTANT_NAME.test(value)) return true
  return !quoted && separator === ":" && LOWERCASE_WORD.test(value)
}

function isNotASecretValue({ value, separator, quoted }: { value: string; separator: string; quoted: boolean }) {
  if (isPlaceholder(value) || NUMERIC.test(value) || ULID_LIKE.test(value)) return true
  if (URL_VALUE.test(value) || PATH_VALUE.test(value)) return true
  return looksLikeCode({ value, separator, quoted })
}

/** One detected secret value and what it is (`openai-key`, `password`, ...). */
export type SecretFinding = { kind: string; value: string }

/**
 * Runs every detector over `text` and replaces each secret value with whatever `replace` returns. Detection is
 * sequential (a replacement is visible to the later detectors), which keeps it idempotent for any replacement that
 * does not itself look like a secret. `redactSecrets`, `findSecrets` and the session secret markers all share it.
 */
export function replaceSecrets(text: string, replace: (finding: SecretFinding) => string): string {
  let out = text
  const mark = (kind: string, value: string) => replace({ kind, value })

  out = out.replace(PEM_BLOCK, (match) => mark("private-key", match))

  out = out.replace(URL_CREDENTIALS, (match, scheme: string, user: string, password: string) =>
    isPlaceholder(password) ? match : `${scheme}${user}:${mark("url-password", password)}@`,
  )

  for (const { kind, pattern } of TOKEN_RULES) out = out.replace(pattern, (match) => (/x{8,}/i.test(match) ? match : mark(kind, match)))

  out = out.replace(AUTH_BEARER, (match, head: string, token: string) => (isPlaceholder(token) ? match : `${head}${mark("bearer-token", token)}`))
  out = out.replace(AUTH_BASIC, (match, head: string, token: string) => (isPlaceholder(token) ? match : `${head}${mark("basic-auth", token)}`))

  out = out.replace(
    ASSIGNMENT,
    (match, head: string, name: string, separator: string, quote: string | undefined, quotedValue: string | undefined, bareValue: string | undefined) => {
      const value = quotedValue ?? bareValue
      if (value === undefined) return match
      if (isNotASecretValue({ value, separator, quoted: quote !== undefined })) return match
      return `${head}${quote ?? ""}${mark(kindForName(name), value)}`
    },
  )

  return out
}

export function redactSecrets(text: string): Redaction {
  let count = 0
  const out = replaceSecrets(text, ({ kind }) => {
    count += 1
    return MARK(kind)
  })
  return { text: out, count }
}

/** The distinct secret values in `text` in order of appearance, each with the kind of its first detection. */
export function findSecrets(text: string): SecretFinding[] {
  const found = new Map<string, SecretFinding>()
  replaceSecrets(text, (finding) => {
    if (!found.has(finding.value)) found.set(finding.value, finding)
    return MARK(finding.kind)
  })
  return [...found.values()]
}

/** What the model, the event log and every stored transcript hold in place of a pasted secret: `‹secret:N›`, N per session. */
export const secretMarker = (n: number) => `‹secret:${n}›`

/** Every `‹secret:N›` in `text` goes through `replace`; `undefined` keeps the marker as written. */
export function replaceSecretMarkers(text: string, replace: (n: number) => string | undefined): string {
  if (!text.includes("‹secret:")) return text
  return text.replace(/‹secret:(\d{1,6})›/g, (match, n: string) => replace(Number(n)) ?? match)
}

const EVENT_TEXT_FIELDS = ["text", "detail", "title"] as const

/** Redacts the top-level text fields of an event draft; the same object comes back when nothing changed. */
export function redactEventText<T extends Record<string, unknown>>(draft: T): T {
  let next: Record<string, unknown> | undefined
  for (const field of EVENT_TEXT_FIELDS) {
    const value = draft[field]
    if (typeof value !== "string") continue
    const redacted = redactSecrets(value)
    if (redacted.count === 0) continue
    next ??= { ...draft }
    next[field] = redacted.text
  }
  if (draft.permissionContext) {
    const redacted = redactSecrets(JSON.stringify(draft.permissionContext))
    if (redacted.count) {
      next ??= { ...draft }
      next.permissionContext = JSON.parse(redacted.text)
    }
  }
  return (next ?? draft) as T
}
