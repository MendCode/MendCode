import { describe, expect, test } from "bun:test"
import { createWebSearchTool, runTool, selectWebSearchProvider, type FetchLike } from "../src"
import { makeContext } from "./helpers"

type Seen = { url: string; method: string; headers: Record<string, string>; body: any }

function fakeFetch(reply: (seen: Seen) => Response | Promise<Response>): { fetch: FetchLike; calls: Seen[] } {
  const calls: Seen[] = []
  const fetch: FetchLike = async (url, init) => {
    const headers: Record<string, string> = {}
    new Headers(init.headers).forEach((value, key) => (headers[key] = value))
    const seen: Seen = { url, method: String(init.method), headers, body: typeof init.body === "string" ? JSON.parse(init.body) : undefined }
    calls.push(seen)
    return reply(seen)
  }
  return { fetch, calls }
}

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } })
const run = (tool: ReturnType<typeof createWebSearchTool>, args: unknown, signal?: AbortSignal) => runTool(tool!, args, makeContext({ cwd: "/tmp", ...(signal ? { signal } : {}) }))

describe("websearch registration", () => {
  test("is not created without a key and blank keys do not count", () => {
    expect(createWebSearchTool({ env: {} })).toBeUndefined()
    expect(createWebSearchTool({ env: { EXA_API_KEY: "  " } })).toBeUndefined()
    expect(selectWebSearchProvider({})).toBeUndefined()
  })
  test("first configured wins: exa, brave, tavily, then openrouter", () => {
    const all = { EXA_API_KEY: "e", BRAVE_API_KEY: "b", TAVILY_API_KEY: "t", OPENROUTER_API_KEY: "o" }
    expect(selectWebSearchProvider(all)?.id).toBe("exa")
    expect(selectWebSearchProvider({ ...all, EXA_API_KEY: "" })?.id).toBe("brave")
    expect(selectWebSearchProvider({ TAVILY_API_KEY: "t", OPENROUTER_API_KEY: "o" })?.id).toBe("tavily")
    expect(selectWebSearchProvider({ OPENROUTER_API_KEY: "o" })?.id).toBe("openrouter")
  })
  test("is a read tool", () => {
    expect(createWebSearchTool({ env: { EXA_API_KEY: "k" } })?.permission).toBe("read")
  })
})

describe("websearch on the ChatGPT subscription", () => {
  const subscription = (available = true, headers: () => Promise<Record<string, string>> = async () => ({ authorization: "Bearer sekret", "chatgpt-account-id": "acct" })) =>
    ({ baseUrl: "https://chatgpt.example/backend-api/codex", headers, model: () => "gpt-test", available: () => available })
  const reply = { output: "…", results: [
    { type: "text_result", domain: "example.com", ref_id: "turn0search0", snippet: "Reserved for documentation.", title: "Example Domain", url: "https://example.com/" },
    { type: "text_result", domain: "iana.org", ref_id: "turn0search1", snippet: "IANA-managed.", title: "IANA", url: "https://www.iana.org/domains/example" },
  ] }

  test("is registered with a login and no key, not without a login; a key still wins", async () => {
    expect(createWebSearchTool({ env: {}, subscription: subscription(false) })).toBeUndefined()
    expect(createWebSearchTool({ env: {}, subscription: subscription() })?.name).toBe("websearch")
    const exa = fakeFetch(() => json({ results: [] }))
    await run(createWebSearchTool({ env: { EXA_API_KEY: "k" }, fetch: exa.fetch, subscription: subscription() }), { query: "x" })
    expect(exa.calls[0]!.url).toBe("https://api.exa.ai/search")
  })

  test("posts the query to the search endpoint with the login's headers and returns titles, links and snippets", async () => {
    const { fetch, calls } = fakeFetch(() => json(reply))
    const result = await run(createWebSearchTool({ env: {}, fetch, subscription: subscription() }), { query: "example domain", numResults: 1, recency: "week" })
    expect(calls[0]).toMatchObject({ url: "https://chatgpt.example/backend-api/codex/alpha/search", method: "POST", headers: { authorization: "Bearer sekret", "chatgpt-account-id": "acct" } })
    expect(calls[0]!.body).toMatchObject({ model: "gpt-test", commands: { search_query: [{ q: "example domain", recency: 7 }], response_length: "short" }, settings: { allowed_callers: ["direct"] } })
    expect(calls[0]!.body.instructions).toBeUndefined()
    expect(result.isError).toBeFalsy()
    expect(result.output).toContain('1 result for "example domain" (ChatGPT)')
    expect(result.output).toContain("https://example.com/")
    expect(result.output).not.toContain("iana.org")
  })

  test("a missing login and a server error fail with a plain message that never carries the token", async () => {
    const none = await run(createWebSearchTool({ env: {}, subscription: subscription(true, async () => { throw new Error("[AUTH]: no Codex login found; run `codex login`") }) }), { query: "x" })
    expect(none.isError).toBe(true)
    expect(none.output).toContain("no Codex login found")
    const { fetch } = fakeFetch(() => json({ error: { message: "bad Bearer sekret" } }, 500))
    const failed = await run(createWebSearchTool({ env: {}, fetch, subscription: subscription() }), { query: "x" })
    expect(failed.isError).toBe(true)
    expect(failed.output).not.toContain("sekret")
  })
})

describe("websearch providers", () => {
  test("Exa: posts to api.exa.ai/search with x-api-key and bounds the snippet", async () => {
    const { fetch, calls } = fakeFetch(() =>
      json({ results: [{ title: "Bun", url: "https://bun.sh", publishedDate: "2026-01-02", text: "x".repeat(2000) }, { title: "", url: "javascript:alert(1)" }, { title: "Dup", url: "https://bun.sh" }] }),
    )
    const result = await run(createWebSearchTool({ env: { EXA_API_KEY: "exa-secret" }, fetch }), { query: "bun runtime", numResults: 3 })
    expect(result.isError).toBe(false)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe("https://api.exa.ai/search")
    expect(calls[0]?.headers["x-api-key"]).toBe("exa-secret")
    expect(calls[0]?.body.numResults).toBe(3)
    expect(result.output).toContain("1. Bun")
    expect(result.output).toContain("https://bun.sh  (2026-01-02)")
    expect(result.output).not.toContain("javascript:")
    expect(result.output).not.toContain("Dup")
    expect(result.output).not.toContain("x".repeat(401))
    expect(result.meta).toEqual({ provider: "exa", results: 1 })
  })

  test("Brave: GET with the subscription token header and q/count", async () => {
    const { fetch, calls } = fakeFetch(() => json({ web: { results: [{ title: "Doc", url: "https://a.dev/x", description: "about <b>x</b>", page_age: "2026-03-04T00:00:00" }] } }))
    const result = await run(createWebSearchTool({ env: { BRAVE_API_KEY: "brave-secret" }, fetch }), { query: "a b" })
    const url = new URL(calls[0]?.url as string)
    expect(url.origin + url.pathname).toBe("https://api.search.brave.com/res/v1/web/search")
    expect(url.searchParams.get("q")).toBe("a b")
    expect(url.searchParams.get("count")).toBe("5")
    expect(calls[0]?.method).toBe("GET")
    expect(calls[0]?.headers["x-subscription-token"]).toBe("brave-secret")
    expect(result.output).toContain("https://a.dev/x  (2026-03-04T00:00:00)")
  })

  test("Tavily: bearer auth and content as snippet", async () => {
    const { fetch, calls } = fakeFetch(() => json({ results: [{ title: "T", url: "https://t.io", content: "snippet here", published_date: "2026-05-06" }] }))
    const result = await run(createWebSearchTool({ env: { TAVILY_API_KEY: "tav-secret" }, fetch }), { query: "q" })
    expect(calls[0]?.url).toBe("https://api.tavily.com/search")
    expect(calls[0]?.headers.authorization).toBe("Bearer tav-secret")
    expect(calls[0]?.body.max_results).toBe(5)
    expect(result.output).toContain("snippet here")
  })

  test("OpenRouter web plugin: results come from the cited sources", async () => {
    const { fetch, calls } = fakeFetch(() =>
      json({
        choices: [{ message: { content: "answer", annotations: [{ type: "url_citation", url_citation: { url: "https://o.dev/1", title: "One", content: "first" } }, { type: "other" }, { type: "url_citation", url_citation: { url: "https://o.dev/2", title: "Two" } }] } }],
      }),
    )
    const result = await run(createWebSearchTool({ env: { OPENROUTER_API_KEY: "or-secret", MENDCODE_WEBSEARCH_OPENROUTER_MODEL: "x/y" }, fetch }), { query: "q", numResults: 2 })
    expect(calls[0]?.url).toBe("https://openrouter.ai/api/v1/chat/completions")
    expect(calls[0]?.headers.authorization).toBe("Bearer or-secret")
    expect(calls[0]?.body.plugins).toEqual([{ id: "web", max_results: 2 }])
    expect(calls[0]?.body.model).toBe("x/y")
    expect(result.output).toContain("1. One")
    expect(result.output).toContain("2. Two")
  })

  test("only the first configured provider is called", async () => {
    const { fetch, calls } = fakeFetch(() => json({ results: [] }))
    const result = await run(createWebSearchTool({ env: { BRAVE_API_KEY: "b", TAVILY_API_KEY: "t" }, fetch }), { query: "nothing" })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toContain("brave")
    expect(result.isError).toBe(false)
    expect(result.output).toContain("No results")
  })
})

describe("websearch failures", () => {
  test("an HTTP error is reported without the key even when the provider echoes it", async () => {
    const { fetch } = fakeFetch(() => new Response("invalid key: exa-secret-123 is not allowed", { status: 401 }))
    const result = await run(createWebSearchTool({ env: { EXA_API_KEY: "exa-secret-123" }, fetch }), { query: "q" })
    expect(result.isError).toBe(true)
    expect(result.output).toContain("HTTP 401")
    expect(result.output).not.toContain("exa-secret-123")
    expect(result.output).toContain("***")
  })
  test("a thrown network error is redacted too", async () => {
    const fetch: FetchLike = async () => {
      throw new Error("connect failed for https://x?key=tav-secret-9")
    }
    const result = await run(createWebSearchTool({ env: { TAVILY_API_KEY: "tav-secret-9" }, fetch }), { query: "q" })
    expect(result.isError).toBe(true)
    expect(result.output).not.toContain("tav-secret-9")
  })
  test("a non-JSON body is an error, not a crash", async () => {
    const { fetch } = fakeFetch(() => new Response("<html>oops</html>", { status: 200 }))
    const result = await run(createWebSearchTool({ env: { BRAVE_API_KEY: "kkkk" }, fetch }), { query: "q" })
    expect(result.isError).toBe(true)
    expect(result.output).toContain("not JSON")
  })
  test("an aborted turn cancels without calling the provider", async () => {
    const { fetch, calls } = fakeFetch(() => json({ results: [] }))
    const controller = new AbortController()
    controller.abort()
    const result = await run(createWebSearchTool({ env: { EXA_API_KEY: "kkkk" }, fetch }), { query: "q" }, controller.signal)
    expect(result.output).toBe("cancelled")
    expect(calls).toHaveLength(0)
  })
  test("arguments are validated: empty query and too many results", async () => {
    const { fetch } = fakeFetch(() => json({ results: [] }))
    const tool = createWebSearchTool({ env: { EXA_API_KEY: "kkkk" }, fetch })
    expect((await run(tool, { query: "  " })).isError).toBe(true)
    expect((await run(tool, { query: "q", numResults: 11 })).isError).toBe(true)
  })
  test("the tool output is bounded for a long result list", async () => {
    const results = Array.from({ length: 10 }, (_, index) => ({ title: `T${index}`, url: `https://e.com/${index}`, text: "y".repeat(5000) }))
    const { fetch } = fakeFetch(() => json({ results }))
    const result = await run(createWebSearchTool({ env: { EXA_API_KEY: "kkkk" }, fetch }), { query: "q", numResults: 10 })
    expect(Buffer.byteLength(result.output)).toBeLessThan(10_000)
  })
})
