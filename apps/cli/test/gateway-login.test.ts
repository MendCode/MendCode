import { afterAll, beforeAll, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import path from "node:path"
import { digest } from "../../../packages/gateway/src/bytes"
import { createGateway } from "../../../packages/gateway/src/server"
import { gatewayState } from "../../../packages/gateway/src/state"
import { fakeAuthenticator } from "../../../packages/gateway/test/fake-authenticator"
import { gatewayAccessToken, gatewayFiles, gatewayOrigin, gatewayTransport, parseLoginCommand, readGatewayProfile, runLoginCommand } from "../src/gateway-login"

/** `remote login` against a real gateway on loopback with a fake account daemon: pairing, approval, tokens, logout. */
let root: string
let clock = Date.now()
let server: ReturnType<typeof Bun.serve>
let backend: ReturnType<typeof Bun.serve>
let origin: string
const ACCOUNT = "cccccccccc"
const INVITE = "invite-code-for-login-test-0123456789abc"

beforeAll(() => {
  root = mkdtempSync("/tmp/mcgw-login-")
  const stateDir = path.join(root, "state")
  gatewayState(stateDir).update((state) => {
    state.accounts.push({ id: ACCOUNT, name: "carol", role: "user", status: "invited", createdAt: clock, passkeys: [], devices: [] })
    state.invites.push({ hash: digest(INVITE), accountId: ACCOUNT, createdAt: clock, expiresAt: clock + 3600_000 })
  })
  backend = Bun.serve({ unix: path.join(root, "c.sock"), fetch: (request) => Response.json({ auth: request.headers.get("authorization") }) })
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request, srv) => gateway.fetch(request, srv as never) })
  origin = `http://localhost:${server.port}`
  const gateway = createGateway({ config: { version: 1, origin, rpId: "localhost", name: "MendCode", listen: { port: 1 }, runtimeRoot: "/run/unused" }, stateDir, now: () => clock, backend: () => ({ socket: path.join(root, "c.sock"), token: "daemon-token" }) })
})
afterAll(() => { server.stop(true); backend.stop(true); rmSync(root, { recursive: true, force: true }) })

async function browser(route: string, body: unknown, cookie?: string, csrf?: string) {
  const response = await fetch(`${origin}/_gw/${route}`, { method: body === undefined ? "GET" : "POST", headers: { origin, "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(csrf ? { "x-mendcode-csrf": csrf } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return { json: await response.json() as Record<string, any>, cookie: response.headers.get("set-cookie")?.split(";")[0] }
}

test("the gateway URL must be https, or plain http on loopback, with no path or credentials", () => {
  expect(gatewayOrigin("https://code.example.test/")).toBe("https://code.example.test")
  for (const bad of ["http://code.example.test", "https://u:p@code.example.test", "https://code.example.test/x", "ftp://x"]) expect(() => gatewayOrigin(bad)).toThrow()
  expect(parseLoginCommand(["remote", "login", "https://code.example.test", "--name", "work laptop"], root)).toMatchObject({ action: "login", name: "work laptop" })
  expect(parseLoginCommand(["remote", "list"], root)).toBeUndefined()
})

test("remote login pairs with a passkey approval, keeps only a 0600 private key, and signs for short tokens; logout removes the device", async () => {
  const dataDir = path.join(root, "data")
  const authenticator = fakeAuthenticator({ userId: Buffer.from(ACCOUNT), rpId: "localhost", origin })
  const options = await browser("register/options", { code: INVITE })
  const registered = await browser("register", { flowId: options.json.flowId, credential: authenticator.create(options.json.publicKey) })
  const cookie = registered.cookie!
  const csrf = (await browser("me", undefined, cookie)).json.csrf
  const printed: string[] = []
  let approved = false
  const code = await runLoginCommand({ action: "login", origin, name: "laptop", dataDir }, { write: (text: string) => printed.push(text) }, {
    now: () => clock,
    sleep: async () => {
      clock += 2_000
      if (approved) return
      approved = true
      const userCode = /\n {4}([0-9A-Z]{4}-[0-9A-Z]{4})\n/.exec(printed.join(""))![1]
      const lookup = await browser("device/approve/options", { userCode }, cookie, csrf)
      await browser("device/approve", { flowId: lookup.json.flowId, scope: "full", credential: authenticator.get(lookup.json.publicKey) }, cookie, csrf)
    },
  })
  expect(code).toBe(0)
  const files = gatewayFiles(dataDir, origin)
  expect(statSync(files.key).mode & 0o777).toBe(0o600)
  expect(readFileSync(files.key, "utf8")).toContain("BEGIN PRIVATE KEY")
  expect(readGatewayProfile(dataDir, origin)).toMatchObject({ url: origin, scope: "full" })
  expect(printed.join("")).not.toContain("PRIVATE")
  const first = await gatewayAccessToken({ dataDir, origin })
  expect(first.token).toStartWith("mgw_")
  const reached = await fetch(`${origin}/anything`, { headers: { authorization: `Bearer ${first.token}` } })
  expect(await reached.json()).toEqual({ auth: "Bearer daemon-token" })
  // The attach transport reuses a token while it has more than a minute left.
  const transport = gatewayTransport({ hostname: "localhost", port: server.port!, tls: false, httpUrl: `${origin}/` }, dataDir)
  const a = await transport.freshToken!()
  expect(await transport.freshToken!()).toBe(a)
  expect(transport.token).toBe("")
  expect(await runLoginCommand({ action: "logout", origin, name: "laptop", dataDir }, { write: () => {} })).toBe(0)
  expect(existsSync(files.key)).toBe(false)
  expect((await fetch(`${origin}/anything`, { headers: { authorization: `Bearer ${a}` } })).status).toBe(401)
})
