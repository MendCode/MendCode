import type { SecretsPort, SecretStream, SecretSummary } from "@mendcode/engine-native"
import { redactSecrets, replaceSecretMarkers, replaceSecrets, secretMarker, type SessionId } from "@mendcode/protocol"
import { SecretsError, type Store } from "@mendcode/store"

/** Historical JSON values: callers retain their own key policy and whether keys themselves are redacted. */
export function redactValue<T>(value: T, policy: { keys?: RegExp; redactKeys?: boolean } = {}): T {
  const visit = (entry: unknown, key = ""): unknown => {
    if (policy.keys?.test(key)) return "[redacted]"
    if (typeof entry === "string") return redactSecrets(entry).text
    if (Array.isArray(entry)) return entry.map((item) => visit(item))
    if (entry && typeof entry === "object") return Object.fromEntries(Object.entries(entry).map(([name, item]) => [policy.redactKeys ? redactSecrets(name).text : name, visit(item, name)]))
    return entry
  }
  return visit(value) as T
}

/** Sessions whose decrypted secrets stay in memory; the least recently loaded one is dropped first. */
const MAX_CACHED_SESSIONS = 64
/** Key problems stop the message that carries a secret; the other limits fall back to plain redaction. */
const KEY_PROBLEMS = new Set(["key_missing", "key_invalid", "key_mismatch"])

type Entry = { n: number; kind: string; tail: string; value: string; marker: string }
/** The ways a value can appear in output: as it is and inside a JSON string (tools print JSON). */
type Needle = { text: string; marker: string }
type Known = { entries: Entry[]; byN: Map<number, Entry>; needles: Needle[]; longest: number }

const EMPTY: Known = { entries: [], byN: new Map(), needles: [], longest: 0 }

function build(entries: Entry[]): Known {
  const needles: Needle[] = []
  for (const entry of entries) {
    const texts = new Set([entry.value, JSON.stringify(entry.value).slice(1, -1)])
    for (const text of texts) needles.push({ text, marker: entry.marker })
  }
  // The longest first, so a secret that contains another is masked as a whole.
  needles.sort((a, b) => b.text.length - a.text.length)
  return { entries, byN: new Map(entries.map((entry) => [entry.n, entry])), needles, longest: needles[0]?.text.length ?? 0 }
}

/** Moves `end` back to the start of any secret occurrence it would cut in two. */
function safeEnd(text: string, end: number, needles: Needle[]) {
  let cut = end
  for (let moved = true; moved; ) {
    moved = false
    for (const needle of needles) {
      for (let at = text.indexOf(needle.text); at >= 0 && at < cut; at = text.indexOf(needle.text, at + 1)) {
        if (cut < at + needle.text.length) {
          cut = at
          moved = true
        }
      }
    }
  }
  return cut
}

/**
 * The daemon's secrets: detects a secret in what the user types, keeps it in the store as a per-session marker, and
 * swaps values and markers for the engine (`resolve` before a tool runs, `mask` over everything it prints).
 * Decrypted values live in memory only for the sessions in use.
 */
export function createSecretsService({ store, log }: { store: Store; log(level: "warn" | "error", message: string): void }) {
  const cache = new Map<SessionId, Known>()
  const environmentVersions = new Map<SessionId, string>()
  const environment = (sessionId: SessionId) => store.environment.values(sessionId, store.sessionDirectory(sessionId) ?? "")

  function known(sessionId: SessionId): Known {
    const env = environment(sessionId)
    const version = JSON.stringify(env)
    const cached = cache.get(sessionId)
    if (cached && environmentVersions.get(sessionId) === version) return cached
    let loaded = EMPTY
    try {
      const tails = new Map(store.secrets.list(sessionId).map((secret) => [secret.n, secret.tail]))
      loaded = build(store.secrets.values(sessionId).map((secret) => ({ ...secret, marker: secretMarker(secret.n), tail: tails.get(secret.n) ?? "" })))
    } catch (error) {
      // A lost or wrong key file: nothing can be decrypted, so nothing can leak. The user hears about it when they paste or reveal one.
      log("warn", error instanceof Error ? error.message : String(error))
    }
    const envEntries = Object.entries(env).map(([name, value], index) => ({ n: -index - 1, kind: `env ${name} (automatically injected)`, tail: "", value, marker: `‹env:${name}›` }))
    // Keep previous values masked while already-started background processes may still print them.
    const previous = (cached?.entries ?? []).filter((entry) => entry.n < 0 && !envEntries.some((next) => next.value === entry.value))
    loaded = build([...loaded.entries, ...envEntries, ...previous])
    cache.set(sessionId, loaded)
    environmentVersions.set(sessionId, version)
    if (cache.size > MAX_CACHED_SESSIONS) { const oldest = cache.keys().next().value!; cache.delete(oldest); environmentVersions.delete(oldest) }
    return loaded
  }

  function mask(sessionId: SessionId, text: string): string {
    if (!text) return text
    const { needles } = known(sessionId)
    let out = text
    for (const needle of needles) if (out.includes(needle.text)) out = out.replaceAll(needle.text, needle.marker)
    return out
  }

  function register(sessionId: SessionId, kind: string, value: string): number {
    const existing = known(sessionId).entries.find((entry) => entry.n > 0 && entry.value === value)
    if (existing) return existing.n
    const { n } = store.secrets.add({ sessionId, kind, value })
    // Rebuilt on the next read, from the cached entries: earlier environment values stay masked while processes may still print them.
    environmentVersions.delete(sessionId)
    return n
  }

  const port: SecretsPort = {
    environment,
    list: (sessionId): SecretSummary[] => {
      const env = environment(sessionId)
      return known(sessionId).entries.filter((entry) => entry.n > 0 || Object.values(env).includes(entry.value)).map(({ n, marker, kind, tail }) => ({ n, marker, kind, tail }))
    },
    resolve: (sessionId, text) => {
      const { byN } = known(sessionId)
      return byN.size ? replaceSecretMarkers(text, (n) => n > 0 ? byN.get(n)?.value : undefined) : text
    },
    mask,
    stream(sessionId): SecretStream | undefined {
      const { needles, longest } = known(sessionId)
      if (!needles.length) return undefined
      let held = ""
      return {
        push(chunk) {
          const all = held + chunk
          const cut = safeEnd(all, all.length - (longest - 1), needles)
          if (cut <= 0) {
            held = all
            return ""
          }
          held = all.slice(cut)
          return mask(sessionId, all.slice(0, cut))
        },
        flush() {
          const rest = held
          held = ""
          return mask(sessionId, rest)
        },
      }
    },
  }

  return {
    ...port,
    /**
     * `text` with every secret in it replaced by its marker: newly detected values are stored (encrypted) and numbered,
     * and any other place a known value appears is masked too. A value the store cannot keep (too many, too long) is
     * redacted instead. A lost or wrong key file returns an error and the caller must not use the text.
     */
    capture(sessionId: SessionId, text: string): { text: string } | { error: string } {
      if (!text) return { text }
      try {
        const replaced = replaceSecrets(text, ({ kind, value }) => {
          try {
            return secretMarker(register(sessionId, kind, value))
          } catch (error) {
            if (error instanceof SecretsError && !KEY_PROBLEMS.has(error.code)) return `[redacted:${kind}]`
            throw error
          }
        })
        return { text: mask(sessionId, replaced) }
      } catch (error) {
        // The key file may be restored before the next try, so what was loaded without it is dropped.
        cache.delete(sessionId)
        if (error instanceof SecretsError) return { error: error.message }
        throw error
      }
    },
    /** One secret shown in the clear, for the user's `secrets.reveal`. */
    reveal(sessionId: SessionId, n: number): { value: string } | { error: string } | undefined {
      try {
        const value = store.secrets.reveal(sessionId, n)
        return value === undefined ? undefined : { value }
      } catch (error) {
        if (error instanceof SecretsError) return { error: error.message }
        throw error
      }
    },
    forget(sessionId: SessionId, n: number): boolean {
      cache.delete(sessionId)
      return store.secrets.forget(sessionId, n)
    },
    /** Drops the decrypted values of a session that was deleted. */
    drop(sessionId: SessionId) {
      cache.delete(sessionId)
      environmentVersions.delete(sessionId)
      store.environment.drop(sessionId)
    },
  }
}
export type SecretsService = ReturnType<typeof createSecretsService>
