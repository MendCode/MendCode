import { describe, expect, test } from "bun:test"
import { createApiProvider, createGitLabProvider, fetchGitLabModels, gitlabConfig, gitlabUrl, RetryableProviderError, type Fetch } from "../src"
import { GITLAB_MODELS } from "../src/gitlab-models"
import { collectGitLab, gitlabFake, gitlabRequest, gitlabResolved, GITLAB_DIRECT_TOKEN, GITLAB_NAMESPACE, GITLAB_TOKEN, GITLAB_URL } from "./gitlab-fixtures"

describe("B10.20 GitLab native adapter", () => {
  for (const [id, model, endpoint] of [
    ["duo-chat-sonnet-4-6", "claude-sonnet-4-6", "/ai/v1/proxy/anthropic/v1/messages"],
    ["duo-chat-gpt-5-2", "gpt-5.2-2025-12-11", "/ai/v1/proxy/openai/v1/chat/completions"],
    ["duo-chat-gpt-5-2-codex", "gpt-5.2-codex", "/ai/v1/proxy/openai/v1/responses"],
  ]) test(`${id} streams native text, reasoning, tools and usage`, async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const transport: Fetch = async (url, init) => { calls.push({ url, init }); return gitlabFake(url, init) }
    const provider = createApiProvider({ provider: gitlabResolved({ npm: "gitlab-ai-provider" }), fetch: transport })
    const events = await collectGitLab(provider.stream(gitlabRequest({ model: id! })))
    expect(events).toContainEqual({ type: "text", delta: "Reading ñ" })
    expect(events).toContainEqual({ type: "reasoning", delta: "Look" })
    expect(events).toContainEqual({ type: "tool_call", call: { callId: "call-1", name: "read", args: { path: "a.ts" } } })
    expect(events.find((event) => event.type === "usage")).toMatchObject({ usage: { input: id === "duo-chat-sonnet-4-6" ? 100 : 40, output: 20, cacheRead: 60 } })
    expect(calls).toHaveLength(2)
    expect(calls[0]!.url).toBe(`${GITLAB_URL}/api/v4/ai/third_party_agents/direct_access`)
    expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe(`Bearer ${GITLAB_TOKEN}`)
    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({ feature_flags: { duo_agent_platform: true, duo_agent_platform_agentic_chat: true, DuoAgentPlatformNext: true } })
    const generation = calls[1]!
    expect(generation.url).toBe(`${GITLAB_URL}${endpoint}`)
    expect(new Headers(generation.init.headers).get("authorization")).toBe(`Bearer ${GITLAB_DIRECT_TOKEN}`)
    expect(new Headers(generation.init.headers).get("x-api-key")).toBeNull()
    expect(new Headers(generation.init.headers).get("private-token")).toBeNull()
    expect(generation.init.redirect).toBe("error")
    expect(generation.init.body).not.toContain(GITLAB_TOKEN)
    expect(JSON.parse(generation.init.body as string).model).toBe(model)
    if (endpoint!.includes("anthropic")) expect(new Headers(generation.init.headers).get("anthropic-beta")).toBe("context-1m-2025-08-07")
  })

  test("direct credentials expire, rotate with PAT changes and refresh once after 401", async () => {
    let clock = 0
    let key = GITLAB_TOKEN
    let exchanges = 0
    let reject = false
    const provider = createGitLabProvider({ provider: gitlabResolved({ apiKey: () => key }), now: () => clock, fetch: async (url, init) => {
      if (url.endsWith("/direct_access")) { exchanges++; return Response.json({ token: `direct-${exchanges}`, headers: {} }) }
      if (reject) { reject = false; return new Response("expired", { status: 401 }) }
      return gitlabFake(url, init)
    } })
    const turn = () => collectGitLab(provider.stream(gitlabRequest()))
    await turn(); await turn(); expect(exchanges).toBe(1)
    clock = 25 * 60_000; await turn(); expect(exchanges).toBe(2)
    key = "rotated-private-token"; await turn(); expect(exchanges).toBe(3)
    reject = true; await turn(); expect(exchanges).toBe(4)
    key = ""; await expect(turn()).rejects.toThrow("requires a token")
    expect(exchanges).toBe(4)
  })

  test("gateway headers are bounded, credentials cannot be overridden and request fetch wins", async () => {
    const calls: RequestInit[] = []
    const provider = createGitLabProvider({ provider: gitlabResolved({ gitlab: { aiGatewayUrl: "http://localhost:1235", featureFlags: { duo_agent_platform: false } }, headers: { authorization: "override", "PRIVATE-TOKEN": GITLAB_TOKEN } }), fetch: async () => { throw new Error("wrong transport") } })
    await collectGitLab(provider.stream(gitlabRequest({ parameters: { providerModel: "claude-opus-4-6", workflowRef: "ignored" }, fetch: async (url, init) => {
      calls.push(init)
      if (url.endsWith("/direct_access")) return Response.json({ token: GITLAB_DIRECT_TOKEN, headers: { authorization: "override", "x-api-key": GITLAB_TOKEN, "X-GitLab-Instance-Id": "123", bad: "line\nbreak" } })
      expect(url.startsWith("http://localhost:1235/ai/v1/proxy/")).toBe(true)
      return gitlabFake(url, init)
    } })))
    expect(JSON.parse(calls[0]!.body as string).feature_flags.duo_agent_platform).toBe(false)
    const headers = new Headers(calls[1]!.headers)
    expect(headers.get("authorization")).toBe(`Bearer ${GITLAB_DIRECT_TOKEN}`)
    expect(headers.get("private-token")).toBeNull()
    expect(headers.get("x-api-key")).toBeNull()
    expect(headers.get("bad")).toBeNull()
    expect(headers.get("x-gitlab-instance-id")).toBe("123")
    expect(JSON.parse(calls[1]!.body as string)).toMatchObject({ model: "claude-opus-4-6" })
    expect(calls[1]!.body).not.toContain("workflowRef")
  })

  test("unsafe URLs, unknown workflow references, unsupported overrides and missing tokens never call a transport", async () => {
    for (const url of ["http://gitlab.com","http://localhost.evil", "http://user:secret@localhost", "http://localhost?token=x", "file:///tmp/a", "http://localhost#x"]) expect(() => gitlabUrl(url)).toThrow("loopback")
    expect(gitlabUrl("http://[::1]:1234").hostname).toBe("[::1]")
    expect(() => gitlabConfig({ aiGatewayUrl: "" })).toThrow()
    expect(() => gitlabConfig({ rootNamespaceId: "123" })).toThrow()
    expect(() => createGitLabProvider({ provider: gitlabResolved({ gitlab: { aiGatewayUrl: "http://public.example" } }) })).toThrow("loopback")
    let calls = 0
    const provider = createGitLabProvider({ provider: gitlabResolved(), fetch: async () => { calls++; throw new Error("no network") } })
    await expect(collectGitLab(provider.stream(gitlabRequest({ model: "duo-workflow-unknown" })))).rejects.toThrow("valid model reference")
    await expect(collectGitLab(provider.stream(gitlabRequest({ parameters: { providerModel: "gpt-5.2-codex" } })))).rejects.toThrow("native format")
    expect(calls).toBe(0)
    const controller = new AbortController(); controller.abort()
    expect(await collectGitLab(provider.stream(gitlabRequest({ signal: controller.signal })))).toEqual([])
    expect(calls).toBe(0)
  })

  test("error payloads cannot expose PAT, direct tokens or routing secrets and retries retain delay", async () => {
    for (const status of [401, 429, 503]) for (const model of ["duo-chat-sonnet-4-6", "duo-chat-gpt-5-2", "duo-chat-gpt-5-2-codex"]) {
      const provider = createGitLabProvider({ provider: gitlabResolved(), fetch: async (url, init) => url.endsWith("/direct_access") ? gitlabFake(url, init) : new Response(`${GITLAB_TOKEN} ${GITLAB_DIRECT_TOKEN}`, { status, headers: { "retry-after": "2" } }) })
      const error = await collectGitLab(provider.stream(gitlabRequest({ model }))).then(() => undefined, (failure: Error) => failure)
      expect(error?.message).toContain(String(status))
      expect(error?.message).not.toContain(GITLAB_TOKEN)
      expect(error?.message).not.toContain(GITLAB_DIRECT_TOKEN)
      if (status !== 401) { expect(error).toBeInstanceOf(RetryableProviderError); expect((error as RetryableProviderError).retryAfterMs).toBe(2000) }
    }
    const exchange = createGitLabProvider({ provider: gitlabResolved(), fetch: async () => new Response(GITLAB_TOKEN, { status: 429, headers: { "retry-after": "2" } }) })
    const delayed = await collectGitLab(exchange.stream(gitlabRequest())).then(() => undefined, (failure: Error) => failure)
    expect(delayed).toBeInstanceOf(RetryableProviderError)
    expect((delayed as RetryableProviderError).retryAfterMs).toBe(2000)
    expect(delayed?.message).not.toContain(GITLAB_TOKEN)
    const provider = createGitLabProvider({ provider: gitlabResolved(), fetch: async (url, init) => url.endsWith("/direct_access") ? gitlabFake(url, init) : Promise.reject(new Error(`transport ${GITLAB_TOKEN} ${GITLAB_DIRECT_TOKEN}`)) })
    await expect(collectGitLab(provider.stream(gitlabRequest()))).rejects.toThrow("[redacted]")
  })

  test("namespace discovery respects PAT/OAuth, pinned precedence and deduplication", async () => {
    for (const authType of ["api", "oauth"] as const) {
      const models = await fetchGitLabModels({ provider: gitlabResolved({ gitlab: { authType, rootNamespaceId: GITLAB_NAMESPACE } }), fetch: async (url, init) => {
        expect(url).toBe(`${GITLAB_URL}/api/graphql`)
        expect(init.redirect).toBe("error")
        const headers = new Headers(init.headers)
        expect(headers.get(authType === "api" ? "private-token" : "authorization")).toBe(authType === "api" ? GITLAB_TOKEN : `Bearer ${GITLAB_TOKEN}`)
        expect(JSON.parse(init.body as string).variables).toEqual({ rootNamespaceId: GITLAB_NAMESPACE })
        return Response.json({ data: { aiChatAvailableModels: { pinnedModel: { name: "Pinned\x1b", ref: "claude_sonnet_4_6" }, selectableModels: [{ name: "Other", ref: "other" }] } } })
      } })
      expect(models.filter((model) => model.id.startsWith("duo-workflow"))).toMatchObject([{ id: "duo-workflow-sonnet-4-6", options: { workflowRef: "claude_sonnet_4_6" } }])
      expect(JSON.stringify(models)).not.toContain("\\u001b")
    }
    expect((await fetchGitLabModels({ provider: gitlabResolved({ gitlab: { rootNamespaceId: GITLAB_NAMESPACE } }), fetch: gitlabFake })).filter((model) => model.id.startsWith("duo-workflow"))).toHaveLength(1)
    expect(await fetchGitLabModels({ provider: gitlabResolved(), fetch: async () => { throw new Error("no discovery without namespace") } })).toEqual(GITLAB_MODELS)
  })

  test("discovery and exchange reject malformed, oversized and failing bodies without echoing them", async () => {
    for (const response of [Response.json({ errors: [{ message: GITLAB_TOKEN }] }), Response.json({ data: {} }), new Response(`bad ${GITLAB_TOKEN}`), new Response("x".repeat(1_000_001)), new Response(GITLAB_TOKEN, { status: 403 })]) {
      const error = await fetchGitLabModels({ provider: gitlabResolved({ gitlab: { rootNamespaceId: GITLAB_NAMESPACE } }), fetch: async () => response }).then(() => undefined, (failure: Error) => failure)
      expect(error).toBeInstanceOf(Error)
      expect(error?.message).not.toContain(GITLAB_TOKEN)
    }
    const provider = createGitLabProvider({ provider: gitlabResolved(), fetch: async () => Response.json({ token: "bad token", headers: {} }) })
    await expect(collectGitLab(provider.stream(gitlabRequest()))).rejects.toThrow("invalid direct-access credentials")
  })
})
