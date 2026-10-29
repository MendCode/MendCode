import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { createFauxEngine } from "@mendcode/engine-faux"
import { createProviderRouter } from "@mendcode/engine-native"
import { Command, createIdFactory, isReadOnlyCommand, type SessionId } from "@mendcode/protocol"
import { collectGitLab, gitlabFake, gitlabRequest, GITLAB_FIXTURE_MODELS, GITLAB_NAMESPACE, GITLAB_TOKEN, GITLAB_URL } from "../../engine-native/test/gitlab-fixtures"
import { startDaemon } from "../src"
import { createProviderAuth } from "../src/provider-auth"
import { createProviderService, PROVIDERS_FILE } from "../src/providers"
import { workflowFake } from "../../engine-native/test/gitlab-workflow-fixtures"

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop() })
const temp = () => { const dir = mkdtempSync(path.join(tmpdir(), "mendcode-b10-20-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir }

describe("B10.20 GitLab daemon and protocol", () => {
  test("additive settings validate without promoting any credential action to read-only", () => {
    const ids = createIdFactory()
    const command = { id: ids("command"), clientId: ids("client"), type: "providers.set", provider: "gitlab", baseUrl: GITLAB_URL, apiKeyEnv: "GITLAB_TOKEN", enabled: true, gitlab: { authType: "oauth", aiGatewayUrl: "http://localhost:4321", rootNamespaceId: GITLAB_NAMESPACE, featureFlags: { duo_agent_platform: true }, projectId: "42" } }
    expect(Command.safeParse(command).success).toBe(true)
    expect(Command.safeParse({ ...command, gitlab: { rootNamespaceId: "123" } }).success).toBe(false)
    expect(Command.safeParse({ ...command, gitlab: { accessToken: GITLAB_TOKEN } }).success).toBe(false)
    for (const type of ["providers.set", "providers.test", "providers.refresh", "providers.logout"] as const) expect(isReadOnlyCommand(type)).toBe(false)
    expect(isReadOnlyCommand("providers.auth.methods")).toBe(true)
  })

  test("environment and legacy SDK stay opt-in, bad endpoints stay off and live disable stops routing", async () => {
    const dir = temp()
    let calls = 0
    const providers = createProviderService({ dir, env: { GITLAB_TOKEN }, fetch: async (url, init) => { calls++; return gitlabFake(url, init) } })
    expect(providers.list().find((provider) => provider.id === "gitlab")).toMatchObject({ enabled: false, hasKey: true })
    expect(providers.models()).toEqual([])
    expect(providers.set({ id: "gitlab", enabled: true })).toMatchObject({ ok: false, message: expect.stringContaining("loopback") })
    expect(providers.set({ id: "gitlab", baseUrl: GITLAB_URL, enabled: true, models: GITLAB_FIXTURE_MODELS })).toMatchObject({ ok: true, provider: { enabled: true } })
    const router = createProviderRouter({ fallback: { id: "subscription", model: "default", async *stream() { throw new Error("must not call subscription") } }, providers: providers.runtime })
    expect(await collectGitLab(router.stream(gitlabRequest({ model: "gitlab:duo-chat-sonnet-4-6" })))).toContainEqual({ type: "text", delta: "Reading ñ" })
    providers.set({ id: "gitlab", enabled: false })
    const before = calls
    await expect(collectGitLab(router.stream(gitlabRequest({ model: "gitlab:duo-chat-sonnet-4-6" })))).rejects.toThrow()
    expect(calls).toBe(before)
    writeFileSync(path.join(dir, PROVIDERS_FILE), JSON.stringify({ providers: { gitlab: { npm: "gitlab-ai-provider", apiKey: GITLAB_TOKEN, baseUrl: "http://gitlab.com", models: GITLAB_FIXTURE_MODELS } } }))
    const legacy = createProviderService({ dir, env: {}, fetch: async () => { throw new Error("no network") } })
    expect(legacy.list().find((provider) => provider.id === "gitlab")).toMatchObject({ enabled: false, error: expect.stringContaining("loopback") })
    expect(legacy.models()).toEqual([])
  })

  test("validation, private persistence, auth status and logout keep tokens out of public reports", () => {
    const dir = temp()
    const providers = createProviderService({ dir, env: {}, fetch: gitlabFake })
    expect(providers.set({ id: "gitlab", baseUrl: GITLAB_URL, enabled: true })).toMatchObject({ ok: false, message: expect.stringContaining("token") })
    expect(providers.set({ id: "gitlab", baseUrl: GITLAB_URL, apiKey: GITLAB_TOKEN, enabled: true, gitlab: { rootNamespaceId: GITLAB_NAMESPACE } })).toMatchObject({ ok: true })
    const auth = createProviderAuth({ dir, providers, env: {} })
    cleanup.push(auth.stop)
    expect(auth.methods("gitlab")).toMatchObject({ gitlab: [{ type: "api", available: true, label: "GitLab token (PAT or OAuth access token)" }] })
    expect(auth.status("gitlab")[0]).toMatchObject({ state: "authorized", source: "v2" })
    expect(auth.plan("gitlab")).toMatchObject({ callsProvider: false, writesSecrets: false, executesNow: false })
    expect(statSync(path.join(dir, PROVIDERS_FILE)).mode & 0o777).toBe(0o600)
    expect(JSON.stringify([providers.list(), providers.inventory!(), auth.status("gitlab")])).not.toContain(GITLAB_TOKEN)
    expect(providers.list()[0]!.keyTail).toBeUndefined()
    providers.logout!("gitlab")
    expect(auth.status("gitlab")[0]!.state).toBe("none")
    expect(readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")).not.toContain(GITLAB_TOKEN)
    expect(JSON.parse(readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")).providers.gitlab.gitlab.rootNamespaceId).toBe(GITLAB_NAMESPACE)
    const unsafe = createProviderService({ dir: temp(), env: { GITLAB_TOKEN, GITLAB_INSTANCE_URL: GITLAB_URL, GITLAB_AI_GATEWAY_URL: "http://public.example" } })
    expect(unsafe.set({ id: "gitlab", enabled: true })).toMatchObject({ ok: false, message: expect.stringContaining("loopback") })
    expect(providers.set({ id: "openai", gitlab: {} })).toMatchObject({ ok: false })
  })

  test("refresh preserves explicit overrides, exposes executable workflows and never overwrites on failure", async () => {
    const dir = temp()
    let fail = false
    const providers = createProviderService({ dir, env: {}, fetch: async (url, init) => fail ? new Response(GITLAB_TOKEN, { status: 403 }) : gitlabFake(url, init) })
    providers.set({ id: "gitlab", baseUrl: GITLAB_URL, apiKey: GITLAB_TOKEN, enabled: true, gitlab: { rootNamespaceId: GITLAB_NAMESPACE }, models: [{ ...GITLAB_FIXTURE_MODELS[0]!, name: "Custom name", images: false }] })
    expect(await providers.refresh("gitlab")).toMatchObject({ ok: true })
    expect(providers.list()[0]!.models.find((model) => model.id === "duo-chat-sonnet-4-6")).toMatchObject({ name: "Custom name", images: false })
    expect(providers.list()[0]!.models.some((model) => model.id.startsWith("duo-workflow"))).toBe(true)
    expect(providers.models().some((model) => model.id.includes("duo-workflow"))).toBe(true)
    const before = readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")
    fail = true
    const result = await providers.refresh("gitlab")
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining("403") })
    expect(JSON.stringify(result)).not.toContain(GITLAB_TOKEN)
    expect(readFileSync(path.join(dir, PROVIDERS_FILE), "utf8")).toBe(before)
  })

  test("discovered workflow models route and test through the daemon's injected transport", async () => {
    const fake = workflowFake()
    const providers = createProviderService({ dir: temp(), env: {}, fetch: async (url, init) => url.includes("/duo_workflows/") ? fake.fetch(url, init) : gitlabFake(url, init), gitlabSocket: fake.socket })
    expect(providers.set({ id: "gitlab", baseUrl: GITLAB_URL, apiKey: GITLAB_TOKEN, enabled: true, gitlab: { rootNamespaceId: GITLAB_NAMESPACE, projectId: "42" } })).toMatchObject({ ok: true })
    expect(await providers.refresh("gitlab")).toMatchObject({ ok: true })
    expect(providers.models()).toContainEqual(expect.objectContaining({ id: "gitlab:duo-workflow-sonnet-4-6" }))
    const router = createProviderRouter({ fallback: { id: "unused", model: "unused", async *stream() { throw new Error("must not call subscription") } }, providers: providers.runtime })
    const events = await collectGitLab(router.stream(gitlabRequest({ model: "gitlab:duo-workflow-sonnet-4-6" })))
    expect(events).toContainEqual({ type: "text", delta: "Done" })
    expect(await providers.test("gitlab", "duo-workflow-sonnet-4-6")).toMatchObject({ ok: true, model: "duo-workflow-sonnet-4-6" })
    expect(fake.peers).toHaveLength(2)
    expect(providers.list()[0]!.gitlab?.projectId).toBe("42")
    expect(Command.safeParse({ id: createIdFactory()("command"), clientId: createIdFactory()("client"), type: "providers.set", provider: "gitlab", gitlab: { projectId: "../unsafe" } }).success).toBe(false)
  })

  test("socket protocol and typed client configure, refresh, test, select and disable GitLab", async () => {
    const dir = temp()
    const providers = createProviderService({ dir, env: {}, fetch: gitlabFake })
    const daemon = await startDaemon({ dir, socketPath: path.join(dir, "daemon.sock"), engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }), info: { engine: "native" }, providers, models: { selectable: true, list: providers.models, defaults: { model: "gitlab:duo-chat-sonnet-4-6" } } })
    cleanup.push(() => daemon.stop())
    const client = createClient({ socketPath: daemon.socketPath, name: "b10-20" })
    cleanup.push(() => client.close())
    await client.connect()
    expect(await client.configureGitLab({ baseUrl: GITLAB_URL, apiKey: GITLAB_TOKEN, enabled: true, gitlab: { rootNamespaceId: GITLAB_NAMESPACE }, models: GITLAB_FIXTURE_MODELS })).toMatchObject({ ok: true, provider: { id: "gitlab", enabled: true, hasKey: true } })
    expect(await client.send({ type: "providers.refresh", provider: "gitlab" })).toMatchObject({ ok: true })
    expect(await client.send({ type: "providers.test", provider: "gitlab" })).toMatchObject({ ok: true, result: { ok: true } })
    expect(await client.providerAuthMethods("gitlab")).toMatchObject({ ok: true, methods: { gitlab: [{ type: "api" }] } })
    const session = await client.send({ type: "session.create", directory: dir })
    if (!session.ok) throw new Error("No session")
    expect(await client.send({ type: "session.model.set", sessionId: session.result?.sessionId as SessionId, choice: { model: "gitlab:duo-chat-gpt-5-2" } })).toMatchObject({ ok: true, result: { effective: { model: "gitlab:duo-chat-gpt-5-2" } } })
    expect(await client.configureGitLab({ enabled: false })).toMatchObject({ ok: true, provider: { enabled: false } })
    expect(providers.models()).toEqual([])
  }, 15_000)
})
