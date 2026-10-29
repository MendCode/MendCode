import { describe, expect, test } from "bun:test"
import { CloudflareAIGatewayConfig, CloudflareAIGatewayInfo, Command, ProviderConfig, createIdFactory, isReadOnlyCommand } from "../src"

describe("B10.22 gateway protocol", () => {
  test("additive private config supports routing, metadata and false/zero/null overrides", () => {
    const config = { accountId: "team", gatewayId: "coding", metadata: { project: "local", turn: 2, debug: false }, cacheTtl: 0, cacheKey: "local-key", skipCache: false, collectLog: false }
    expect(CloudflareAIGatewayConfig.parse(config)).toEqual(config)
    expect(ProviderConfig.safeParse({ cloudflareAiGateway: config }).success).toBe(true)
    expect(CloudflareAIGatewayConfig.parse({ metadata: null, cacheKey: null, accountId: null })).toEqual({ metadata: null, cacheKey: null, accountId: null })
    const ids = createIdFactory()
    expect(Command.safeParse({ id: ids("command"), clientId: ids("client"), type: "providers.set", provider: "cloudflare-ai-gateway", cloudflareAiGateway: config, enabled: true }).success).toBe(true)
    for (const type of ["providers.set", "providers.test", "providers.refresh", "providers.logout"] as const) expect(isReadOnlyCommand(type)).toBe(false)
  })

  test("public info excludes private values and malformed header/routing options fail closed", () => {
    expect(CloudflareAIGatewayInfo.safeParse({ accountId: "a", hasMetadata: true, hasCacheKey: false }).success).toBe(true)
    for (const config of [{ accountId: "../a" }, { gatewayId: "bad id" }, { cacheTtl: -1 }, { cacheTtl: 1.5 }, { cacheKey: "key\r\nX: bad" }, { metadata: { nested: { key: "secret" } } }, { token: "secret" }]) expect(CloudflareAIGatewayConfig.safeParse(config).success).toBe(false)
    for (const privateConfig of [{ metadata: { project: "private" } }, { cacheKey: "private" }]) expect(CloudflareAIGatewayInfo.safeParse({ ...privateConfig, hasMetadata: true, hasCacheKey: true }).success).toBe(false)
  })
})
