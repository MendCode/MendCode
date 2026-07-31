import { describe, expect, test } from "bun:test"
import {
  CodexAuthPlugin,
  parseJwtClaims,
  extractAccountIdFromClaims,
  extractAccountId,
  normalizeCodexChatGPTRequestBody,
  prepareCodexChatGPTOAuthRequest,
  type IdTokenClaims,
} from "../../src/plugin/codex"

function createTestJwt(payload: object): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `${header}.${body}.sig`
}

describe("plugin.codex", () => {
  describe("normalizeCodexChatGPTRequestBody", () => {
    test("routes the GPT-5.6 family alias to Sol for ChatGPT Codex", () => {
      expect(
        JSON.parse(
          normalizeCodexChatGPTRequestBody(
            JSON.stringify({ model: "gpt-5.6", reasoning: { effort: "max" }, service_tier: "priority" }),
          ) as string,
        ),
      ).toEqual({
        model: "gpt-5.6-sol",
        reasoning: { effort: "max" },
        service_tier: "priority",
      })
    })

    test("routes the legacy GPT-5.3 Codex ID to a ChatGPT-supported model", () => {
      expect(
        JSON.parse(normalizeCodexChatGPTRequestBody(JSON.stringify({ model: "gpt-5.3-codex" })) as string),
      ).toEqual({ model: "gpt-5.5" })
    })

    test("lowers generated fast model IDs used by subagents and hidden roles", () => {
      expect(JSON.parse(normalizeCodexChatGPTRequestBody(JSON.stringify({ model: "gpt-5.6-fast" })) as string)).toEqual(
        { model: "gpt-5.6-sol", service_tier: "priority" },
      )
      expect(
        JSON.parse(normalizeCodexChatGPTRequestBody(JSON.stringify({ model: "gpt-5.6-sol-fast" })) as string),
      ).toEqual({ model: "gpt-5.6-sol", service_tier: "priority" })
      expect(
        JSON.parse(normalizeCodexChatGPTRequestBody(JSON.stringify({ model: "gpt-5.6-terra-fast" })) as string),
      ).toEqual({ model: "gpt-5.6-terra", service_tier: "priority" })
      expect(
        JSON.parse(normalizeCodexChatGPTRequestBody(JSON.stringify({ model: "gpt-5.6-luna-fast" })) as string),
      ).toEqual({ model: "gpt-5.6-luna", service_tier: "priority" })
      expect(JSON.parse(normalizeCodexChatGPTRequestBody(JSON.stringify({ model: "gpt-5.4-fast" })) as string)).toEqual(
        { model: "gpt-5.4", service_tier: "priority" },
      )
      expect(
        JSON.parse(normalizeCodexChatGPTRequestBody(JSON.stringify({ model: "gpt-5.4-mini-fast" })) as string),
      ).toEqual({ model: "gpt-5.4-mini", service_tier: "priority" })
    })

    test("lowers generated pro model IDs without dropping reasoning effort", () => {
      expect(
        JSON.parse(
          normalizeCodexChatGPTRequestBody(
            JSON.stringify({ model: "gpt-5.6-sol-pro", reasoning: { effort: "max" } }),
          ) as string,
        ),
      ).toEqual({ model: "gpt-5.6-sol", reasoning: { effort: "max", mode: "pro" } })
      expect(
        JSON.parse(
          normalizeCodexChatGPTRequestBody(
            JSON.stringify({ model: "gpt-5.6-terra-pro", reasoning: { effort: "high" } }),
          ) as string,
        ),
      ).toEqual({ model: "gpt-5.6-terra", reasoning: { effort: "high", mode: "pro" } })
    })

    test("preserves explicit GPT-5.6 tiers and non-JSON bodies", () => {
      for (const model of ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]) {
        const explicit = JSON.stringify({ model })
        expect(normalizeCodexChatGPTRequestBody(explicit)).toBe(explicit)
      }
      expect(normalizeCodexChatGPTRequestBody("not-json")).toBe("not-json")
      expect(normalizeCodexChatGPTRequestBody("null")).toBe("null")
      expect(normalizeCodexChatGPTRequestBody("[]")).toBe("[]")
      expect(normalizeCodexChatGPTRequestBody(new URLSearchParams({ model: "gpt-5.6" }))).toBeInstanceOf(
        URLSearchParams,
      )
    })
  })

  test("keeps Sol, Terra, and Luna modes in the ChatGPT OAuth catalog", async () => {
    const ids = [
      "gpt-5.6-sol",
      "gpt-5.6-sol-fast",
      "gpt-5.6-terra",
      "gpt-5.6-terra-fast",
      "gpt-5.6-luna",
      "gpt-5.6-luna-fast",
    ]
    const provider = {
      models: Object.fromEntries(
        ids.map((id) => [
          id,
          {
            id,
            api: { id: id.replace(/-fast$/, "") },
            cost: { input: 1, output: 1, cache: { read: 1, write: 1 } },
            limit: { context: 1, input: 1, output: 1 },
          },
        ]),
      ),
    }
    const plugin = await CodexAuthPlugin({} as never)
    const models = await plugin.provider!.models!(provider as never, { auth: { type: "oauth" } } as never)

    expect(Object.keys(models)).toEqual(ids)
    for (const id of ids) {
      expect(models[id]?.limit).toEqual({ context: 256_000, input: 256_000, output: 128_000 })
      expect(models[id]?.options).toMatchObject({ compaction: { threshold: 90 } })
    }
  })

  test("rewrites GPT-5.6 OAuth requests for Responses Lite with honest client identity", async () => {
    const requests: Array<{ headers: Headers; body: Record<string, unknown> }> = []
    using server = Bun.serve({
      port: 0,
      async fetch(request) {
        requests.push({
          headers: new Headers(request.headers),
          body: await readRequestBody(request),
        })
        return Response.json({})
      },
    })
    const providerFetch = await loadCodexFetch(new URL("/backend-api/codex/responses", server.url).toString())
    const body = JSON.stringify({
      model: "gpt-5.6-luna-fast",
      input: [
        {
          role: "user",
          content: [{ type: "input_image", image_url: "data:image/png;base64,test", detail: "high" }],
        },
      ],
      instructions: "always say first Hello World!",
      tools: [{ type: "function", name: "noop", parameters: { type: "object", properties: {} } }],
      reasoning: { effort: "high", summary: "auto" },
      store: false,
      parallel_tool_calls: true,
      stream: true,
    })
    const init = {
      method: "POST",
      headers: { "content-type": "application/json", session_id: "ses_luna" },
      body,
    }

    await providerFetch("https://api.openai.com/v1/responses", init)
    await providerFetch(
      new Request("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { "content-type": "application/json", session_id: "ses_luna", "x-custom": "retained" },
        body: JSON.stringify({
          model: "gpt-5.6-luna",
          input: [],
          instructions: "always say first Hello World!",
          store: false,
          stream: true,
        }),
      }),
    )

    expect(requests).toHaveLength(2)
    expect(requests[0]?.headers.get("originator")).toBe("codex_cli_rs")
    expect(requests[0]?.headers.get("user-agent")).toContain("codex_cli_rs/0.0.0 (MendCode;")
    expect(requests[0]?.headers.get("origin")).toBe("https://chatgpt.com")
    expect(requests[0]?.headers.get("version")).toBe("0.144.0")
    expect(requests[0]?.headers.get("x-openai-internal-codex-responses-lite")).toBe("true")
    const sessionID = requests[0]?.headers.get("session-id")
    expect(sessionID).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(requests[0]?.headers.get("x-session-affinity")).toBe(sessionID)
    expect(requests[1]?.headers.get("session-id")).toBe(sessionID)
    expect(requests[1]?.headers.get("x-custom")).toBe("retained")
    expect(requests[0]?.body.model).toBe("gpt-5.6-luna")
    expect(requests[0]?.body.store).toBe(false)
    expect(requests[0]?.body.service_tier).toBe("priority")
    expect(requests[0]?.body.prompt_cache_key).toBe(sessionID)
    expect(requests[0]?.body.tool_choice).toBe("auto")
    expect(requests[0]?.body.parallel_tool_calls).toBe(false)
    expect(requests[0]?.body.reasoning).toEqual({ effort: "high", summary: "auto", context: "all_turns" })
    expect(requests[0]?.body.tools).toBeUndefined()
    expect(requests[0]?.body.instructions).toBeUndefined()
    expect(requests[0]?.body.input).toEqual([
      {
        type: "additional_tools",
        role: "developer",
        tools: [{ type: "function", name: "noop", parameters: { type: "object", properties: {} } }],
      },
      {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "always say first Hello World!" }],
      },
      {
        role: "user",
        content: [{ type: "input_image", image_url: "data:image/png;base64,test" }],
      },
    ])
  })

  test("does not retain generated affinity keys for headerless Responses Lite requests", () => {
    const sessionIDs = new Map<string, string>()
    const headers = new Headers()
    const body = prepareCodexChatGPTOAuthRequest({
      headers,
      sessionIDs,
      body: JSON.stringify({ model: "gpt-5.6-luna", input: [] }),
    })

    expect(typeof body).toBe("string")
    expect(headers.get("session-id")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(sessionIDs.size).toBe(0)
  })

  test("rotates Responses Lite affinity when instructions change", () => {
    const sessionIDs = new Map<string, string>()
    const sessionPromptFingerprints = new Map<string, string>()

    const request = (instructions: string) => {
      const headers = new Headers({ "session-id": "ses_prompt_context" })
      const body = prepareCodexChatGPTOAuthRequest({
        headers,
        sessionIDs,
        sessionPromptFingerprints,
        body: JSON.stringify({
          model: "gpt-5.6-luna",
          input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
          instructions,
        }),
      })
      return { headers, body: JSON.parse(body as string) as Record<string, unknown> }
    }

    const first = request("always say first Hello World!")
    const same = request("always say first Hello World!")
    const changed = request("always say first Goodbye World!")

    expect(same.headers.get("session-id")).toBe(first.headers.get("session-id"))
    expect(changed.headers.get("session-id")).not.toBe(first.headers.get("session-id"))
    expect(changed.body.input).toEqual([
      { type: "additional_tools", role: "developer", tools: [] },
      {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "always say first Goodbye World!" }],
      },
      { role: "user", content: [{ type: "input_text", text: "hello" }] },
    ])
  })

  test("keeps the API-key transport independent from the ChatGPT OAuth adapter", async () => {
    const plugin = await CodexAuthPlugin({} as never)
    const loaded = await plugin.auth!.loader!(async () => ({ type: "api", key: "test" }) as never, {} as never)
    expect(loaded.fetch).toBeUndefined()
  })

  describe("parseJwtClaims", () => {
    test("parses valid JWT with claims", () => {
      const payload = { email: "test@example.com", chatgpt_account_id: "acc-123" }
      const jwt = createTestJwt(payload)
      const claims = parseJwtClaims(jwt)
      expect(claims).toEqual(payload)
    })

    test("returns undefined for JWT with less than 3 parts", () => {
      expect(parseJwtClaims("invalid")).toBeUndefined()
      expect(parseJwtClaims("only.two")).toBeUndefined()
    })

    test("returns undefined for invalid base64", () => {
      expect(parseJwtClaims("a.!!!invalid!!!.b")).toBeUndefined()
    })

    test("returns undefined for invalid JSON payload", () => {
      const header = Buffer.from("{}").toString("base64url")
      const invalidJson = Buffer.from("not json").toString("base64url")
      expect(parseJwtClaims(`${header}.${invalidJson}.sig`)).toBeUndefined()
    })
  })

  describe("extractAccountIdFromClaims", () => {
    test("extracts chatgpt_account_id from root", () => {
      const claims: IdTokenClaims = { chatgpt_account_id: "acc-root" }
      expect(extractAccountIdFromClaims(claims)).toBe("acc-root")
    })

    test("extracts chatgpt_account_id from nested https://api.openai.com/auth", () => {
      const claims: IdTokenClaims = {
        "https://api.openai.com/auth": { chatgpt_account_id: "acc-nested" },
      }
      expect(extractAccountIdFromClaims(claims)).toBe("acc-nested")
    })

    test("prefers root over nested", () => {
      const claims: IdTokenClaims = {
        chatgpt_account_id: "acc-root",
        "https://api.openai.com/auth": { chatgpt_account_id: "acc-nested" },
      }
      expect(extractAccountIdFromClaims(claims)).toBe("acc-root")
    })

    test("extracts from organizations array as fallback", () => {
      const claims: IdTokenClaims = {
        organizations: [{ id: "org-123" }, { id: "org-456" }],
      }
      expect(extractAccountIdFromClaims(claims)).toBe("org-123")
    })

    test("returns undefined when no accountId found", () => {
      const claims: IdTokenClaims = { email: "test@example.com" }
      expect(extractAccountIdFromClaims(claims)).toBeUndefined()
    })
  })

  describe("extractAccountId", () => {
    test("extracts from id_token first", () => {
      const idToken = createTestJwt({ chatgpt_account_id: "from-id-token" })
      const accessToken = createTestJwt({ chatgpt_account_id: "from-access-token" })
      expect(
        extractAccountId({
          id_token: idToken,
          access_token: accessToken,
          refresh_token: "rt",
        }),
      ).toBe("from-id-token")
    })

    test("falls back to access_token when id_token has no accountId", () => {
      const idToken = createTestJwt({ email: "test@example.com" })
      const accessToken = createTestJwt({
        "https://api.openai.com/auth": { chatgpt_account_id: "from-access" },
      })
      expect(
        extractAccountId({
          id_token: idToken,
          access_token: accessToken,
          refresh_token: "rt",
        }),
      ).toBe("from-access")
    })

    test("returns undefined when no tokens have accountId", () => {
      const token = createTestJwt({ email: "test@example.com" })
      expect(
        extractAccountId({
          id_token: token,
          access_token: token,
          refresh_token: "rt",
        }),
      ).toBeUndefined()
    })

    test("handles missing id_token", () => {
      const accessToken = createTestJwt({ chatgpt_account_id: "acc-123" })
      expect(
        extractAccountId({
          id_token: "",
          access_token: accessToken,
          refresh_token: "rt",
        }),
      ).toBe("acc-123")
    })
  })
})

async function readRequestBody(request: Request) {
  const body: unknown = await request.json()
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error("Expected a JSON object")
  return body as Record<string, unknown>
}

async function loadCodexFetch(endpoint: string) {
  const hooks = await CodexAuthPlugin({} as never, { codexApiEndpoint: endpoint })
  const loaded = await hooks.auth!.loader!(
    async () =>
      ({
        type: "oauth",
        refresh: "refresh-token",
        access: "access-token",
        expires: Date.now() + 60_000,
        accountId: "account-id",
      }) as never,
    {} as never,
  )
  if (!loaded.fetch) throw new Error("Expected a provider fetch implementation")
  return loaded.fetch
}
