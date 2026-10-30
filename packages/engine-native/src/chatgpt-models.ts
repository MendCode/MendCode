import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { ModelInfo } from "@mendcode/protocol"
import { CHATGPT_PLAN_BASE_URL } from "./chatgpt-auth"
import { CHATGPT_CODEX_BASE_URL } from "./codex-auth"
import { parseCodexModels } from "./codex-models"
import { NATIVE_DEFAULTS } from "./defaults"

/**
 * The Codex protocol version MendCode's engine speaks to the subscription backend. The backend lists the models a client of that
 * version can run (`GET …/models?client_version=`, codex-rs/codex-api/src/endpoint/models.rs), so it moves with the protocol, not with
 * the Codex CLI installed on the machine.
 */
export const CHATGPT_CLIENT_VERSION = "0.164.0"
/** Codex's own lifetime for its list (codex-rs/models-manager, DEFAULT_MODEL_CACHE_TTL); with the ETag a refresh is a 304. */
export const CHATGPT_MODELS_TTL_MS = 300_000
/** After a failed refresh the saved list is kept and the next try waits this long. */
export const CHATGPT_MODELS_RETRY_MS = 60_000
const FETCH_TIMEOUT_MS = 10_000
/** How long a first listing waits for a catalog that was never fetched before it shows the engine default alone. */
const FIRST_WAIT_MS = 5_000
/** The fields MendCode reads of an entry; the backend's other fields (prompts, tool settings) are not kept. */
const KEPT = ["slug", "display_name", "visibility", "default_reasoning_level", "supported_reasoning_levels", "context_window", "max_context_window", "supported_in_api"] as const
/** The version a Sign in with ChatGPT list is saved under: it comes from api.openai.com, not from the backend of a Codex client version. */
const PLAN_VERSION = "plan"

const FALLBACK: ModelInfo[] = [{ id: NATIVE_DEFAULTS.model, name: NATIVE_DEFAULTS.model, efforts: ["low", "medium", "high"], defaultEffort: NATIVE_DEFAULTS.effort }]

type Saved = { fetchedAt: number; etag?: string; clientVersion: string; identity: string; models: Record<string, unknown>[] }
export type ChatgptCatalogStatus = { fetchedAt?: number; error?: string; stale: boolean; models: number }
type Fetch = (input: string, init?: RequestInit) => Promise<Response>

/**
 * MendCode's own list of the models the signed-in ChatGPT account can use (docs/connect.md#where-each-list-comes-from), asked of the subscription
 * backend with MendCode's login and kept in `<data dir>/chatgpt-models.json`. No other program's cache is read or written. A failed
 * or empty answer keeps the last list; a list from another account is not shown. Listing never waits on the network once a list was
 * saved: a stale one is refreshed in the background.
 */
export function createChatgptModelCatalog(options: {
  dir: string
  /** MendCode's subscription headers; throws when there is no login MendCode may use. */
  headers(): Promise<Record<string, string>>
  /** Whether a login exists, without reading it; no login, no request. */
  signedIn(): boolean
  /** The account of a Sign in with ChatGPT login: its list is asked of api.openai.com (developers.openai.com/siwc/token-sharing-open-source/models-and-inference). */
  planAccount?(): string | undefined
  fetch?: Fetch
  now?: () => number
  log?(message: string): void
}) {
  const file = path.join(options.dir, "chatgpt-models.json")
  const now = options.now ?? Date.now
  let loaded: { mtimeMs: number; saved: Saved | undefined } | undefined
  let refreshing: Promise<void> | undefined
  let failedAt = 0
  let error: string | undefined

  function read(): Saved | undefined {
    try {
      const { mtimeMs } = statSync(file)
      if (loaded?.mtimeMs !== mtimeMs) {
        const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<Saved>
        const valid = typeof raw.fetchedAt === "number" && typeof raw.identity === "string" && typeof raw.clientVersion === "string" && Array.isArray(raw.models)
        loaded = { mtimeMs, saved: valid ? raw as Saved : undefined }
      }
      return loaded.saved
    } catch {
      return undefined
    }
  }

  function save(saved: Saved) {
    mkdirSync(options.dir, { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify(saved)}\n`, { mode: 0o600 })
    renameSync(temp, file)
  }

  const version = () => options.planAccount?.() ? PLAN_VERSION : CHATGPT_CLIENT_VERSION
  const stale = (saved: Saved | undefined) => !saved || saved.clientVersion !== version() || now() - saved.fetchedAt >= CHATGPT_MODELS_TTL_MS

  async function download() {
    const headers = await options.headers()
    const plan = options.planAccount?.()
    const clientVersion = plan ? PLAN_VERSION : CHATGPT_CLIENT_VERSION
    // The account the list belongs to, hashed: a list is never shown for another account.
    const identity = createHash("sha256").update(plan ?? headers["chatgpt-account-id"] ?? "").digest("hex")
    const saved = read()
    const same = saved?.identity === identity && saved.clientVersion === clientVersion
    const response = await (options.fetch ?? fetch)(plan ? `${CHATGPT_PLAN_BASE_URL}/models` : `${CHATGPT_CODEX_BASE_URL}/models?client_version=${CHATGPT_CLIENT_VERSION}`, {
      headers: { ...headers, accept: "application/json", ...(same && saved.etag ? { "if-none-match": saved.etag } : {}) },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (response.status === 304 && same) { save({ ...saved, fetchedAt: now() }); return }
    if (!response.ok) throw new Error(`the subscription backend answered ${response.status}`)
    const body = await response.json() as { models?: unknown }
    // A model the API route does not serve (`supported_in_api: false`) is not offered there.
    const models = Array.isArray(body.models) ? body.models.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null && !(plan && entry.supported_in_api === false)).map((entry) => Object.fromEntries(KEPT.filter((key) => key in entry).map((key) => [key, entry[key]]))) : []
    // An answer with no usable model is a broken answer, not an account without models: the last list stays.
    if (!parseCodexModels({ models }).length) throw new Error("the subscription backend listed no models")
    const etag = response.headers.get("etag") ?? undefined
    save({ fetchedAt: now(), ...(etag ? { etag } : {}), clientVersion, identity, models })
  }

  /** Asks the backend now (one request at a time); a failure is recorded and keeps the saved list. */
  function refresh(): Promise<void> {
    return refreshing ??= download().then(() => { error = undefined; failedAt = 0 }, (cause: unknown) => {
      error = cause instanceof Error ? cause.message : String(cause)
      failedAt = now()
      options.log?.(`ChatGPT model list not refreshed: ${error}`)
    }).finally(() => { refreshing = undefined })
  }

  const due = () => options.signedIn() && stale(read()) && now() - failedAt >= CHATGPT_MODELS_RETRY_MS

  return {
    /** The saved list, or the engine default alone when none was ever fetched; a stale list is refreshed in the background. */
    list(): ModelInfo[] {
      if (due()) void refresh()
      const saved = read()
      const models = saved ? parseCodexModels({ models: saved.models }) : []
      // The engine default stays choosable, as with the list Codex kept: a session that names it is never left without its model.
      return models.some((model) => model.id === NATIVE_DEFAULTS.model) ? models : [...models, ...FALLBACK]
    },
    /** For a listing that must be whole: waits (up to 5 s) only when no list was ever saved and a login exists. */
    async settle(): Promise<void> {
      if (read() || !due()) return
      await Promise.race([refresh(), Bun.sleep(FIRST_WAIT_MS)])
    },
    /** A fresh list now, whatever its age: before a model the saved list does not have is refused. */
    discover(): Promise<void> {
      return options.signedIn() ? refresh() : Promise.resolve()
    },
    status(): ChatgptCatalogStatus {
      const saved = read()
      return { ...(saved ? { fetchedAt: saved.fetchedAt } : {}), ...(error ? { error } : {}), stale: stale(saved), models: saved ? parseCodexModels({ models: saved.models }).length : 0 }
    },
  }
}
