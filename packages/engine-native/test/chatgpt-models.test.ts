import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { CHATGPT_CLIENT_VERSION, CHATGPT_MODELS_RETRY_MS, CHATGPT_MODELS_TTL_MS, createChatgptModelCatalog, NATIVE_DEFAULTS } from "../src"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "chatgpt-models-")); dirs.push(dir); return dir }
const entry = (slug: string, extra: Record<string, unknown> = {}) => ({ slug, display_name: slug, visibility: "list", default_reasoning_level: "medium", supported_reasoning_levels: [{ effort: "low" }, { effort: "medium" }, { effort: "high" }], context_window: 272000, base_instructions: "long prompt not kept", ...extra })
const ids = (list: { id: string }[]) => list.map((model) => model.id)

/** A backend that answers in order; each call is recorded with its URL and headers. */
function backend(...answers: Array<Response | Error>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = []
  return {
    calls,
    fetch: async (url: string, init?: RequestInit) => {
      calls.push({ url, headers: init?.headers as Record<string, string> })
      const answer = answers[Math.min(calls.length - 1, answers.length - 1)]!
      if (answer instanceof Error) throw answer
      return answer.clone()
    },
  }
}
const listed = (slugs: string[], etag = "W/\"1\"") => new Response(JSON.stringify({ models: slugs.map((slug) => entry(slug)) }), { headers: { etag } })

function catalog(input: { dir: string; fetch: ReturnType<typeof backend>["fetch"]; clock?: { now: number }; account?: { id: string }; signedIn?: () => boolean }) {
  const clock = input.clock ?? { now: 1_000_000 }
  return createChatgptModelCatalog({
    dir: input.dir,
    headers: async () => ({ authorization: "Bearer t", "chatgpt-account-id": input.account?.id ?? "acct-1", originator: "mendcode" }),
    signedIn: input.signedIn ?? (() => true),
    fetch: input.fetch,
    now: () => clock.now,
  })
}

describe("MendCode's own ChatGPT model list", () => {
  test("a new install without Codex lists what the account has, not only the default (seen live: models chatgpt listed only gpt-6-luna)", async () => {
    const dir = temp()
    const server = backend(listed(["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"]))
    const models = catalog({ dir, fetch: server.fetch })
    await models.settle()
    expect(ids(models.list())).toEqual(["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"])
    expect(server.calls[0]!.url).toBe(`https://chatgpt.com/backend-api/codex/models?client_version=${CHATGPT_CLIENT_VERSION}`)
    expect(server.calls[0]!.headers.authorization).toBe("Bearer t")
    // Its own file, with only the fields it reads and the account hashed; nothing of Codex's is written.
    const saved = JSON.parse(readFileSync(path.join(dir, "chatgpt-models.json"), "utf8"))
    expect(Object.keys(saved.models[0]).sort()).toEqual(["context_window", "default_reasoning_level", "display_name", "slug", "supported_reasoning_levels", "visibility"])
    expect(saved.identity).not.toContain("acct-1")
    expect(JSON.stringify(saved)).not.toContain("Bearer")
    expect(existsSync(path.join(dir, "models_cache.json"))).toBe(false)
  })

  test("a stale list is shown at once and refreshed in the background, with the ETag; a 304 keeps it", async () => {
    const dir = temp()
    const clock = { now: 1_000_000 }
    const server = backend(listed(["gpt-6-luna"]), new Response(null, { status: 304 }), listed(["gpt-6-astra", "gpt-6-luna"], "W/\"2\""))
    const models = catalog({ dir, fetch: server.fetch, clock })
    await models.discover()
    expect(models.list()).toHaveLength(1)
    expect(server.calls).toHaveLength(1)
    clock.now += CHATGPT_MODELS_TTL_MS
    expect(ids(models.list())).toEqual(["gpt-6-luna"])
    await models.discover()
    expect(server.calls[1]!.headers["if-none-match"]).toBe("W/\"1\"")
    expect(models.status()).toMatchObject({ stale: false, models: 1 })
    clock.now += CHATGPT_MODELS_TTL_MS
    await models.discover()
    expect(ids(models.list())).toEqual(["gpt-6-astra", "gpt-6-luna"])
  })

  test("no network, an error status or an empty answer keep the saved list, say why, and wait before trying again", async () => {
    const dir = temp()
    const clock = { now: 1_000_000 }
    const server = backend(listed(["gpt-6-astra", "gpt-6-luna"]), new TypeError("fetch failed: getaddrinfo ENOTFOUND chatgpt.com"), new Response("{}", { status: 503 }), new Response(JSON.stringify({ models: [] })))
    const models = catalog({ dir, fetch: server.fetch, clock })
    await models.discover()
    clock.now += CHATGPT_MODELS_TTL_MS
    await models.discover()
    expect(ids(models.list())).toEqual(["gpt-6-astra", "gpt-6-luna"])
    expect(models.status()).toMatchObject({ stale: true, error: "fetch failed: getaddrinfo ENOTFOUND chatgpt.com" })
    models.list()
    expect(server.calls).toHaveLength(2)
    clock.now += CHATGPT_MODELS_RETRY_MS
    await models.discover()
    expect(models.status().error).toBe("the subscription backend answered 503")
    await models.discover()
    expect(models.status().error).toBe("the subscription backend listed no models")
    expect(ids(models.list())).toEqual(["gpt-6-astra", "gpt-6-luna"])
  })

  test("partial or broken answers and files: bad entries are skipped, a broken file is fetched again, the default stays choosable", async () => {
    const dir = temp()
    const server = backend(new Response(JSON.stringify({ models: [entry("gpt-6-astra"), { display_name: "no slug" }, "junk", entry("gpt-reserve", { visibility: "hide" })] })))
    const models = catalog({ dir, fetch: server.fetch })
    await models.settle()
    expect(ids(models.list())).toEqual(["gpt-6-astra", NATIVE_DEFAULTS.model])
    writeFileSync(path.join(dir, "chatgpt-models.json"), "{ half")
    expect(models.status()).toMatchObject({ stale: true, models: 0 })
    expect(ids(models.list())).toContain(NATIVE_DEFAULTS.model)
  })

  test("another account or another protocol version asks again without the old ETag", async () => {
    const dir = temp()
    const account = { id: "acct-1" }
    const server = backend(listed(["gpt-6-astra", "gpt-6-luna"]), listed(["gpt-6-luna"], "W/\"9\""))
    const models = catalog({ dir, fetch: server.fetch, account })
    await models.discover()
    account.id = "acct-2"
    await models.discover()
    expect(server.calls[1]!.headers["if-none-match"]).toBeUndefined()
    expect(ids(models.list())).toEqual(["gpt-6-luna"])
    const file = path.join(dir, "chatgpt-models.json")
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), clientVersion: "0.1.0" }))
    expect(models.status().stale).toBe(true)
  })

  test("without a login nothing is asked and the default alone is listed; a login that fails says so", async () => {
    const dir = temp()
    const server = backend(listed(["gpt-6-astra"]))
    const signedOut = catalog({ dir, fetch: server.fetch, signedIn: () => false })
    await signedOut.settle()
    await signedOut.discover()
    expect(ids(signedOut.list())).toEqual([NATIVE_DEFAULTS.model])
    expect(server.calls).toHaveLength(0)
    const expired = createChatgptModelCatalog({ dir, headers: async () => { throw new Error("[AUTH]: v2 ChatGPT login failed; use /connect chatgpt") }, signedIn: () => true, fetch: server.fetch })
    await expired.discover()
    expect(expired.status().error).toBe("[AUTH]: v2 ChatGPT login failed; use /connect chatgpt")
    expect(server.calls).toHaveLength(0)
  })

  test("a Sign in with ChatGPT login lists from api.openai.com, drops models the API route does not serve, and never shows the backend's list for it", async () => {
    const dir = temp()
    const server = backend(listed(["gpt-6-luna"]), new Response(JSON.stringify({ models: [entry("gpt-6.1-sol", { supported_in_api: true }), entry("gpt-6-astra", { supported_in_api: false }), entry("gpt-6-luna")] })))
    const clock = { now: 1_000_000 }
    // The same data dir first had a Codex-style login, then the user signed in with ChatGPT.
    let plan: string | undefined
    const models = createChatgptModelCatalog({ dir, headers: async () => plan ? { authorization: "Bearer p" } : { authorization: "Bearer t", "chatgpt-account-id": "acct-1" }, signedIn: () => true, planAccount: () => plan, fetch: server.fetch, now: () => clock.now })
    await models.settle()
    expect(server.calls[0]!.url).toContain("chatgpt.com/backend-api/codex/models")
    plan = "user-subject"
    await models.discover()
    expect(server.calls[1]!.url).toBe("https://api.openai.com/v1/models")
    expect(server.calls[1]!.headers).toMatchObject({ authorization: "Bearer p" })
    expect(server.calls[1]!.headers["if-none-match"]).toBeUndefined()
    expect(ids(models.list())).toEqual(["gpt-6.1-sol", "gpt-6-luna"])
    expect(models.status().stale).toBe(false)
  })

  test("the Codex CLI's cache is never read", () => {
    expect(readFileSync(path.join(import.meta.dir, "../src/chatgpt-models.ts"), "utf8")).not.toContain("models_cache")
    expect(readFileSync(path.join(import.meta.dir, "../src/codex-models.ts"), "utf8")).not.toContain(path.join(homedir(), ".codex"))
  })
})
