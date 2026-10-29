import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { ChannelsReport, isReadOnlyCommand } from "@mendcode/protocol"
import { createFauxEngine } from "@mendcode/engine-faux"
import { startDaemon, type DaemonOptions } from "../src"
import { remoteTokens } from "../src/remote"
import type { TelegramUpdate } from "../src/channels-telegram"

const TOKEN = "123456789:AAEhBOweik6ad9r_QXMENQjcrr9FMJAGu7e"
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function until(check: () => boolean, ms = 8_000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** A local Telegram: long-polls like the real API, records everything the bot sends. No network. */
function fakeTelegram() {
  const calls: string[] = []
  const sent: Array<{ chat: string; text: string }> = []
  const documents: string[] = []
  let queue: TelegramUpdate[] = []
  let next = 100
  let wake: (() => void) | undefined
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)
    const method = url.pathname.split("/").at(-1)!
    expect(url.pathname.startsWith(`/bot${TOKEN}/`)).toBe(true)
    calls.push(method)
    const ok = (result: unknown) => Response.json({ ok: true, result })
    if (method === "getMe") return ok({ username: "mend_test_bot" })
    if (method === "getUpdates") {
      const body = JSON.parse(String(init?.body)) as { offset?: number; timeout: number }
      if (body.offset === -1) return ok(queue.slice(-1))
      if (body.offset !== undefined) queue = queue.filter((update) => update.update_id >= body.offset!)
      if (!queue.length && body.timeout > 0) {
        await new Promise<void>((resolve) => { wake = resolve; init?.signal?.addEventListener("abort", () => resolve(), { once: true }) })
        wake = undefined
        if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError")
      }
      return ok(body.timeout > 0 ? [...queue] : [])
    }
    if (method === "sendMessage") { const body = JSON.parse(String(init?.body)) as { chat_id: string; text: string }; sent.push({ chat: body.chat_id, text: body.text }); return ok({}) }
    if (method === "sendDocument") { documents.push(((init!.body as FormData).get("document") as File).name); return ok({}) }
    return ok({})
  }) as typeof fetch
  return {
    fetcher, calls, sent, documents,
    say(chat: number, text: string) { queue.push({ update_id: ++next, message: { message_id: next, chat: { id: chat, type: "private", first_name: "Ana" }, text } }); wake?.() },
    seed(chat: number, text: string) { queue.push({ update_id: ++next, message: { message_id: next, chat: { id: chat, type: "private" }, text } }) },
  }
}

async function boot(options: { telegram: ReturnType<typeof fakeTelegram>; token?: boolean; enabled?: boolean } & Partial<DaemonOptions>) {
  const root = mkdtempSync(path.join(tmpdir(), "mendd-channels-"))
  const dir = path.join(root, "data")
  const project = path.join(root, "project")
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  mkdirSync(project)
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  if (options.enabled) writeFileSync(path.join(dir, "channels.json"), JSON.stringify({ telegram: { enabled: true, chats: [] } }))
  const { telegram, token = true, enabled: _enabled, ...rest } = options
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), defaultDirectory: project, engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }), channels: { fetch: telegram.fetcher, env: token ? { MENDCODE_TELEGRAM_TOKEN: TOKEN } : {} }, ...rest })
  const client = createClient({ socketPath: daemon.socketPath, name: "channels-test" })
  await client.connect()
  cleanups.push(() => daemon.stop(), () => client.close())
  const report = async () => {
    const reply = await client.send({ type: "channels.status" })
    if (!reply.ok) throw new Error(reply.error.message)
    return ChannelsReport.parse(reply.result)
  }
  return { daemon, client, dir, project, report }
}

describe("chat bridge in the daemon", () => {
  test("off by default: no Telegram call, nothing listening, status says so", async () => {
    const telegram = fakeTelegram()
    const h = await boot({ telegram })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(telegram.calls).toEqual([])
    expect((await h.report()).telegram).toEqual({ enabled: false, tokenConfigured: true, running: false, chats: [] })
    expect(existsSync(path.join(h.dir, "channels.json"))).toBe(false)
    const pair = await h.client.send({ type: "channels.change", change: { action: "pair", directory: h.project } })
    expect(pair).toMatchObject({ ok: false, error: { message: expect.stringContaining("enable") } })
  })

  test("enable, pair from the terminal, then a phone message runs a turn and the answer returns", async () => {
    const telegram = fakeTelegram()
    telegram.seed(7, "stale message from while the daemon was off")
    const h = await boot({ telegram })
    const enabled = await h.client.send({ type: "channels.change", change: { action: "enable" } })
    expect(enabled.ok && ChannelsReport.parse(enabled.result).telegram).toMatchObject({ enabled: true, running: true, botName: "mend_test_bot" })
    expect(statSync(path.join(h.dir, "channels.json")).mode & 0o777).toBe(0o600)
    const pair = await h.client.send({ type: "channels.change", change: { action: "pair", directory: h.project } })
    const code = (pair.ok ? pair.result?.pairing as { code: string } : undefined)!.code
    expect(code).toMatch(/^[A-Z2-9]{8}$/)
    telegram.say(7, "hello there")
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(telegram.sent).toEqual([])
    telegram.say(7, `/pair ${code}`)
    await until(() => telegram.sent.some((message) => message.text.startsWith("Paired")))
    telegram.say(7, "echo me please")
    await until(() => telegram.sent.some((message) => message.text.includes("echo me please")))
    const status = await h.report()
    expect(status.telegram.chats).toMatchObject([{ id: "7", name: "Ana", directory: h.project }])
    expect(JSON.stringify(status)).not.toContain(TOKEN)
    expect(JSON.stringify(status)).not.toContain(code)
    expect(telegram.sent.every((message) => message.chat === "7" && !message.text.includes(TOKEN))).toBe(true)
    expect(telegram.sent.some((message) => message.text.includes("stale message"))).toBe(false)
    // The phone session is an ordinary session in the paired project.
    const sessions = await h.client.send({ type: "session.list" })
    expect(sessions.ok && JSON.stringify(sessions.result)).toContain("Telegram")
    writeFileSync(path.join(h.project, "report.txt"), "result")
    telegram.say(7, "/file report.txt")
    await until(() => telegram.documents.includes("report.txt"))
    await h.client.send({ type: "channels.change", change: { action: "unpair" } })
    expect((await h.report()).telegram.chats).toEqual([])
    telegram.say(7, "still there?")
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(telegram.sent.some((message) => message.text.includes("still there"))).toBe(false)
  })

  test("enabled in channels.json starts with the daemon; a missing or world-readable token is reported, not used", async () => {
    const telegram = fakeTelegram()
    const missing = await boot({ telegram, enabled: true, token: false })
    await new Promise((resolve) => setTimeout(resolve, 100))
    const report = (await missing.report()).telegram
    expect(report).toMatchObject({ enabled: true, tokenConfigured: false, running: false })
    expect(report.error).toContain("no bot token")
    expect(telegram.calls).toEqual([])

    const second = await boot({ telegram, enabled: true, token: false })
    writeFileSync(path.join(second.dir, "telegram-token"), TOKEN, { mode: 0o644 })
    expect((await second.report()).telegram.error).toContain("private")
    expect(telegram.calls).toEqual([])

    const live = await boot({ telegram, enabled: true })
    await until(() => telegram.calls.includes("getUpdates"))
    expect((await live.report()).telegram).toMatchObject({ enabled: true, running: true })
  })

  test("a Telegram failure never leaks the token and the bridge retries", async () => {
    const telegram = fakeTelegram()
    let failing = true
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (failing) { failing = false; throw new Error(`connect ECONNREFUSED https://api.telegram.org/bot${TOKEN}/getMe`) }
      return telegram.fetcher(input, init)
    }) as typeof fetch
    const logs: string[] = []
    const h = await boot({ telegram: { ...telegram, fetcher }, log: (_level, message) => logs.push(message) })
    const enabled = await h.client.send({ type: "channels.change", change: { action: "enable" } })
    const report = ChannelsReport.parse(enabled.ok ? enabled.result : undefined).telegram
    expect(report.running).toBe(false)
    expect(report.error).toContain("telegram getMe failed")
    expect(JSON.stringify(report)).not.toContain(TOKEN)
    expect(logs.join("\n")).not.toContain(TOKEN)
    await until(() => telegram.calls.includes("getUpdates"), 5_000)
    expect((await h.report()).telegram).toMatchObject({ running: true, botName: "mend_test_bot" })
  })

  test("disable stops polling; the bridge commands are local only and not read-only peer commands", async () => {
    expect(isReadOnlyCommand("channels.status")).toBe(false)
    expect(isReadOnlyCommand("channels.change")).toBe(false)
    const telegram = fakeTelegram()
    const h = await boot({ telegram, listen: "127.0.0.1:0" })
    await h.client.send({ type: "channels.change", change: { action: "enable" } })
    const full = remoteTokens(h.dir).create({ name: "full", readOnly: false }).token
    const remote = createClient({ name: "remote", remote: { hostname: "127.0.0.1", port: h.daemon.remotePort!, token: full } })
    await remote.connect()
    cleanups.push(() => remote.close())
    expect(await remote.send({ type: "channels.status" })).toMatchObject({ ok: false, error: { code: "forbidden" } })
    expect(await remote.send({ type: "channels.change", change: { action: "unpair" } })).toMatchObject({ ok: false, error: { code: "forbidden" } })
    const disabled = await h.client.send({ type: "channels.change", change: { action: "disable" } })
    expect(disabled.ok && ChannelsReport.parse(disabled.result).telegram).toMatchObject({ enabled: false, running: false })
    expect(JSON.parse(readFileSync(path.join(h.dir, "channels.json"), "utf8")).telegram.enabled).toBe(false)
  })
})
