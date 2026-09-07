import { afterEach, describe, expect, test } from "bun:test"
import { Flag } from "@mendcode/core/flag/flag"
import * as Log from "@mendcode/core/util/log"
import { Server } from "../../src/server/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"
import { createHash } from "node:crypto"
import { aiConfigRequest, runAIConfigRequest } from "../../src/mend/cli/ai-config-request"

void Log.init({ print: false })

const original = Flag.OPENCODE_EXPERIMENTAL_HTTPAPI

function app(experimental: boolean) {
  Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = experimental
  return experimental ? Server.Default().app : Server.Legacy().app
}

function headers(directory: string) {
  return { "x-opencode-directory": directory }
}

async function readJSON(response: Response) {
  const text = await response.text()
  return text ? (JSON.parse(text) as Record<string, unknown>) : {}
}

afterEach(async () => {
  Flag.OPENCODE_EXPERIMENTAL_HTTPAPI = original
  await disposeAllInstances()
  await resetDatabase()
})

describe("AI configuration HTTP routes", () => {
  test("CLI client uses the shared backend and fresh exact-action approval, never an invented session", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const server = app(false)
    const connection = { url: "http://localhost", headers: new Headers(headers(tmp.path)) }
    const fetcher = ((url: string | URL | Request, init?: RequestInit) => server.request(String(url), init)) as typeof fetch
    const inspect = await runAIConfigRequest({ action: "inspect", connection, fetch: fetcher, confirm: async () => { throw new Error("Inspect must not ask") } }) as {
      configSources: Array<{ path: string; exists: boolean; scope: string; digest: string }>
    }
    const target = inspect.configSources.find((item) => item.exists && item.path.startsWith(tmp.path))
    if (!target) throw new Error("Fixture target missing")
    const before = await Bun.file(target.path).text()
    const request = aiConfigRequest("apply", { patch: { compaction: { strategy: "portable" } }, target, expectedHash: target.digest }, { scope: "project" })
    let approvals = 0
    await expect(runAIConfigRequest({ action: "apply", request, connection, fetch: fetcher, confirm: async (approval) => {
      approvals++
      expect(approval.metadata.target).toBe(target.path)
      expect(approval.sessionID.startsWith("ses")).toBe(true)
      return false
    } })).rejects.toThrow("403")
    expect(await Bun.file(target.path).text()).toBe(before)
    const result = await runAIConfigRequest({ action: "apply", request, connection, fetch: fetcher, confirm: async () => { approvals++; return true } }) as { changed: boolean }
    expect(result.changed).toBe(true)
    expect(approvals).toBe(2)
  })

  test("both backends enforce causal identity, denial, success and digest conflict on apply", async () => {
    for (const experimental of [false, true]) {
      await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
      const server = app(experimental)
      const inventory = await readJSON(await server.request("/config/ai", { headers: headers(tmp.path) }))
      const target = (inventory.configSources as Array<{ path: string; exists: boolean }>).find((item) => item.exists && item.path.startsWith(tmp.path))
      if (!target) throw new Error("Fixture config target not discovered")
      const before = await Bun.file(target.path).text()
      const expectedHash = createHash("sha256").update(before).digest("hex")
      const post = (url: string, value: unknown) => server.request(url, {
        method: "POST", headers: { ...headers(tmp.path), "content-type": "application/json" }, body: JSON.stringify(value),
      })
      const apply = (causalSessionID: string, hash = expectedHash) => post("/config/ai/apply", {
        scope: "project", target: target.path, patch: { compaction: { strategy: "portable" } }, expectedHash: hash, causalSessionID,
      })
      expect((await apply("cli:invented")).status).toBe(403)
      const deniedSession = await readJSON(await post("/session", { permission: [{ permission: "edit", pattern: "*", action: "deny" }] }))
      expect(typeof deniedSession.id).toBe("string")
      expect((await apply(String(deniedSession.id))).status).toBe(403)
      expect(await Bun.file(target.path).text()).toBe(before)
      const allowedSession = await readJSON(await post("/session", { permission: [{ permission: "edit", pattern: "*", action: "allow" }] }))
      const approveApply = async (hash = expectedHash) => {
        const pending = apply(String(allowedSession.id), hash)
        let request: { id: string; sessionID: string; metadata: { action?: string; expectedHash?: string } } | undefined
        for (let attempt = 0; attempt < 100 && !request; attempt++) {
          const response = await server.request("/permission", { headers: headers(tmp.path) })
          const requests = await response.json() as Array<{ id: string; sessionID: string; metadata: { action?: string; expectedHash?: string } }>
          request = requests.find((item) => item.sessionID === allowedSession.id && item.metadata.action === "ai_config.apply")
          if (!request) await new Promise((resolve) => setTimeout(resolve, 10))
        }
        if (!request) throw new Error("The backend failed to request fresh action approval")
        expect(request.metadata.expectedHash).toBe(hash)
        const reply = await post(`/permission/${request.id}/reply`, { reply: "once" })
        expect(reply.status).toBe(200)
        return pending
      }
      const success = await approveApply()
      expect(success.status).toBe(200)
      const result = await readJSON(success)
      expect(result.changed).toBe(true)
      expect(await Bun.file(target.path).text()).toContain('"portable"')
      expect((await apply(String(allowedSession.id))).status).toBe(409)
      expect((await approveApply(String(result.afterHash))).status).toBe(200)
    }
  })

  test("keeps inspect and unavailable-candidate errors aligned across both backends", async () => {
    await using tmp = await tmpdir({ config: { formatter: false, lsp: false } })
    const requestHeaders = headers(tmp.path)
    const legacy = app(false)
    const httpapi = app(true)

    const legacyInspect = await legacy.request("/config/ai", { headers: requestHeaders })
    const httpapiInspect = await httpapi.request("/config/ai", { headers: requestHeaders })
    expect(legacyInspect.status).toBe(200)
    expect(httpapiInspect.status).toBe(200)

    const legacyInventory = await readJSON(legacyInspect)
    const httpapiInventory = await readJSON(httpapiInspect)
    expect(httpapiInventory).toEqual(legacyInventory)
    expect(httpapiInventory.version).toBe(1)
    expect(Array.isArray(httpapiInventory.models)).toBe(true)
    expect(Array.isArray(httpapiInventory.roles)).toBe(true)
    expect(Array.isArray(httpapiInventory.configSources)).toBe(true)
    expect(JSON.stringify(httpapiInventory)).not.toContain("access_token")
    expect(JSON.stringify(httpapiInventory)).not.toContain("refresh_token")

    const body = {
      candidates: [{ providerID: "missing-provider", modelID: "missing-model" }],
      intent: "balanced",
      taskKind: "general",
    }
    const legacyPlan = await legacy.request("/config/ai/plan", {
      method: "POST",
      headers: { ...requestHeaders, "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    const httpapiPlan = await httpapi.request("/config/ai/plan", {
      method: "POST",
      headers: { ...requestHeaders, "content-type": "application/json" },
      body: JSON.stringify(body),
    })
    expect(legacyPlan.status).toBe(422)
    expect(httpapiPlan.status).toBe(422)
    expect(await readJSON(httpapiPlan)).toEqual(await readJSON(legacyPlan))
  })

  test("keeps concurrent client inventories scoped to their project targets", async () => {
    await using first = await tmpdir({ config: { formatter: false, lsp: false } })
    await using second = await tmpdir({ config: { formatter: false, lsp: false } })
    const server = app(false)

    const [firstResponse, secondResponse] = await Promise.all([
      server.request("/config/ai", { headers: headers(first.path) }),
      server.request("/config/ai", { headers: headers(second.path) }),
    ])
    expect(firstResponse.status).toBe(200)
    expect(secondResponse.status).toBe(200)

    const firstInventory = await readJSON(firstResponse)
    const secondInventory = await readJSON(secondResponse)
    const firstTarget = (firstInventory.configSources as Array<{ path: string }>).find((item) => item.path.includes(first.path))
    const secondTarget = (secondInventory.configSources as Array<{ path: string }>).find((item) => item.path.includes(second.path))
    expect(firstTarget?.path).toContain(first.path)
    expect(secondTarget?.path).toContain(second.path)
    expect(firstTarget?.path).not.toBe(secondTarget?.path)
  })
})
