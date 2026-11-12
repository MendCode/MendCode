import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import { ChannelsReport, type SessionId } from "@mendcode/protocol"
import { createFauxEngine } from "@mendcode/engine-faux"
import { startDaemon } from "../src"
import { discordComponents, DISCORD_INTENTS } from "../src/channels-discord"
import { markdownForDiscord } from "../src/channels-format"

/** A made-up token in Discord's shape, assembled here so secret scanners do not take it for a real one. */
const TOKEN = ["MTIzNDU2Nzg5MDEyMzQ1Njc4", "GabcDe", "fake".repeat(4) + "0123456789AB"].join(".")
const GUILD = "500"
const LOBBY = "100"
const OWNER = "42"
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function until(check: () => boolean, ms = 8_000) {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

type Sent = { channel: string; content: string; components?: Array<{ components: Array<{ label: string; custom_id?: string; url?: string; style: number }> }>; allowed_mentions?: unknown }

/**
 * A local Discord: the REST API and the gateway over a real HTTP server and WebSocket on 127.0.0.1, so the daemon's own fetch and
 * WebSocket code runs. It records what the bot sends; `type` delivers a message from a user as the gateway would.
 */
function fakeDiscord() {
  const sent: Sent[] = []
  const edits: Array<{ channel: string; id: string; content: string }> = []
  const threads: Array<{ id: string; parent: string; name: string; fromMessage?: string }> = []
  const acks: string[] = []
  const followups: Array<{ content: string; flags: number }> = []
  const identified: Array<{ token: string; intents: number }> = []
  const authorization: string[] = []
  const kinds = new Map<string, { type: number; parent_id?: string }>([[LOBBY, { type: 0 }]])
  let socket: { send(data: string): void } | undefined
  let seq = 0
  let ids = 1000
  const id = () => String(++ids)
  const dispatch = (t: string, d: unknown) => socket?.send(JSON.stringify({ op: 0, t, s: ++seq, d }))
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request, http) {
      const url = new URL(request.url)
      if (url.pathname === "/gateway") return http.upgrade(request) ? undefined : new Response("no", { status: 400 })
      authorization.push(request.headers.get("authorization") ?? "")
      const route = url.pathname.replace(/^\/api\/v10/, "")
      const body = request.method === "GET" ? undefined : await request.text().then((text) => (text ? JSON.parse(text) : {})).catch(() => ({}))
      let match: RegExpExecArray | null
      if (route === "/users/@me") return Response.json({ id: "900", username: "mend_discord" })
      if ((match = /^\/channels\/(\d+)$/.exec(route))) {
        const known = kinds.get(match[1]!)
        return known ? Response.json({ id: match[1], ...known, guild_id: GUILD }) : Response.json({ message: "Unknown Channel", code: 10003 }, { status: 404 })
      }
      if ((match = /^\/channels\/(\d+)\/messages\/(\d+)\/threads$/.exec(route))) {
        const thread = { id: id(), parent: match[1]!, name: body.name, fromMessage: match[2]! }
        threads.push(thread)
        kinds.set(thread.id, { type: 11, parent_id: thread.parent })
        return Response.json({ id: thread.id })
      }
      if ((match = /^\/channels\/(\d+)\/threads$/.exec(route))) {
        const thread = { id: id(), parent: match[1]!, name: body.name }
        threads.push(thread)
        kinds.set(thread.id, { type: 11, parent_id: thread.parent })
        return Response.json({ id: thread.id })
      }
      if ((match = /^\/channels\/(\d+)\/messages$/.exec(route))) { sent.push({ channel: match[1]!, ...body }); return Response.json({ id: id() }) }
      if ((match = /^\/channels\/(\d+)\/messages\/(\d+)$/.exec(route))) { edits.push({ channel: match[1]!, id: match[2]!, content: body.content }); return Response.json({}) }
      if (/^\/channels\/\d+\/typing$/.test(route)) return new Response(null, { status: 204 })
      if ((match = /^\/interactions\/(\d+)\/[^/]+\/callback$/.exec(route))) { acks.push(match[1]!); return new Response(null, { status: 204 }) }
      if (/^\/webhooks\/app1\/[^/]+$/.test(route)) { followups.push(body); return Response.json({}) }
      return Response.json({ message: `unexpected ${request.method} ${route}` }, { status: 404 })
    },
    websocket: {
      open(ws) {
        socket = ws
        ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }))
      },
      message(ws, raw) {
        const payload = JSON.parse(String(raw)) as { op: number; d: { token: string; intents: number } }
        if (payload.op === 1) ws.send(JSON.stringify({ op: 11 }))
        if (payload.op === 2) {
          identified.push({ token: payload.d.token, intents: payload.d.intents })
          dispatch("READY", { user: { id: "900", username: "mend_discord", bot: true }, application: { id: "app1" }, session_id: "s1" })
          dispatch("GUILD_CREATE", { id: GUILD, channels: [{ id: LOBBY, type: 0 }], threads: [] })
        }
      },
      close() { socket = undefined },
    },
  })
  return {
    sent, edits, threads, acks, followups, identified, authorization,
    seams: { base: `http://127.0.0.1:${server.port}/api/v10`, gateway: `ws://127.0.0.1:${server.port}/gateway` },
    stop: () => server.stop(true),
    type(channel: string, content: string, author = OWNER) {
      const message = id()
      dispatch("MESSAGE_CREATE", { id: message, type: 0, channel_id: channel, guild_id: GUILD, content, author: { id: author, username: author === OWNER ? "obed" : "someone" } })
      return message
    },
    press(channel: string, data: string, user = OWNER) {
      const interaction = id()
      dispatch("INTERACTION_CREATE", { id: interaction, token: `tok${interaction}`, type: 3, application_id: "app1", channel_id: channel, guild_id: GUILD, member: { user: { id: user } }, data: { custom_id: data } })
      return interaction
    },
    in: (channel: string) => sent.filter((message) => message.channel === channel),
  }
}

async function boot(discord: ReturnType<typeof fakeDiscord>) {
  const root = mkdtempSync(path.join(tmpdir(), "mendd-discord-"))
  const dir = path.join(root, "data")
  const project = path.join(root, "project")
  const other = path.join(root, "other")
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  mkdirSync(project)
  mkdirSync(other)
  cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => discord.stop())
  const daemon = await startDaemon({ dir, socketPath: path.join(dir, "mendd.sock"), defaultDirectory: project, engine: ({ clock }) => createFauxEngine({ clock, deltaMs: 1 }), channels: { env: { MENDCODE_DISCORD_TOKEN: TOKEN }, discord: discord.seams } })
  const client = createClient({ socketPath: daemon.socketPath, name: "discord-test" })
  await client.connect()
  cleanups.push(() => daemon.stop(), () => client.close())
  const code = async (directory: string, sessionId?: SessionId) => {
    const pair = await client.send({ type: "channels.change", change: { action: "pair", directory, channel: "discord", ...(sessionId ? { sessionId } : {}) } })
    return (pair.ok ? pair.result?.pairing as { code: string } : undefined)!.code
  }
  const session = async (directory: string) => {
    const created = await client.send({ type: "session.create", directory, title: "Terminal" })
    return (created.ok ? created.result?.sessionId : undefined) as SessionId
  }
  return { daemon, client, dir, project, other, code, session }
}

describe("Discord bridge in the daemon", () => {
  test("a channel pairs; a prompt there opens a thread and runs in it; only the owner drives it; a terminal session pairs into its own thread", async () => {
    const discord = fakeDiscord()
    const h = await boot(discord)
    const enabled = await h.client.send({ type: "channels.change", change: { action: "enable", channel: "discord" } })
    expect(enabled.ok && ChannelsReport.parse(enabled.result).discord).toMatchObject({ enabled: true, running: true, botName: "mend_discord" })
    expect(discord.identified).toEqual([{ token: TOKEN, intents: DISCORD_INTENTS }])
    expect(discord.authorization.every((value) => value === `Bot ${TOKEN}`)).toBe(true)

    // Nothing answers before pairing.
    discord.type(LOBBY, "hello?")
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(discord.sent).toEqual([])
    discord.type(LOBBY, `/pair ${await h.code(h.project)}`)
    await until(() => discord.in(LOBBY).some((message) => message.content.startsWith("**Paired with**")))

    // A prompt in the channel starts a thread from that message, named after it, and runs there.
    const prompt = discord.type(LOBBY, "echo from discord please")
    await until(() => discord.threads.length === 1)
    expect(discord.threads[0]).toMatchObject({ parent: LOBBY, name: "echo from discord please", fromMessage: prompt })
    const thread = discord.threads[0]!.id
    await until(() => discord.in(thread).some((message) => message.content.includes("echo from discord please")))

    // Another member of the server is ignored: no thread, no reply, no turn.
    const before = discord.sent.length
    discord.type(LOBBY, "let me in", "43")
    discord.type(thread, "me too", "43")
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(discord.sent.length).toBe(before)
    expect(discord.threads).toHaveLength(1)

    // A reply in the thread continues the same session.
    discord.type(thread, "second message here")
    await until(() => discord.in(thread).some((message) => message.content.includes("second message here")))
    const listed = await h.client.send({ type: "session.list", directory: h.project })
    const titles = ((listed.ok ? listed.result?.sessions : []) as Array<{ title: string }>).map((entry) => entry.title)
    expect(titles.filter((title) => title === "Discord")).toHaveLength(1)

    // A code from another project's terminal session opens that session in its own thread; the lobby gets a link.
    const terminal = await h.session(h.other)
    discord.type(LOBBY, `/pair ${await h.code(h.other, terminal)}`)
    await until(() => discord.threads.length === 2)
    const second = discord.threads[1]!
    expect(second).toMatchObject({ parent: LOBBY, name: "other · Terminal" })
    await until(() => discord.in(second.id).some((message) => message.content.includes("**Paired with**")))
    await until(() => discord.in(LOBBY).some((message) => message.components?.[0]?.components[0]?.url === `https://discord.com/channels/${GUILD}/${second.id}`))

    // Everything leaves with mentions off, and no message carries the token.
    expect(discord.sent.every((message) => JSON.stringify(message.allowed_mentions) === JSON.stringify({ parse: [] }))).toBe(true)
    expect(JSON.stringify(discord.sent)).not.toContain(TOKEN)
    const report = await h.client.send({ type: "channels.status" })
    expect(report.ok && ChannelsReport.parse(report.result).discord?.chats).toMatchObject([{ id: LOBBY, name: "obed", directory: h.project }])
    expect(JSON.stringify(report)).not.toContain(OWNER)
  })

  test("an approval in a terminal turn arrives in its thread with buttons; a press is acknowledged at once, only the owner's counts", async () => {
    const discord = fakeDiscord()
    const h = await boot(discord)
    await h.client.send({ type: "channels.change", change: { action: "enable", channel: "discord" } })
    const sessionId = await h.session(h.project)
    discord.type(LOBBY, `/pair ${await h.code(h.project, sessionId)}`)
    await until(() => discord.threads.length === 1)
    const thread = discord.threads[0]!.id
    await until(() => discord.in(thread).some((message) => message.content.includes("No turns in this session yet.")))
    await h.client.send({ type: "user.submit", sessionId, text: "/ask", attachments: [] })
    await until(() => discord.in(thread).some((message) => message.content.startsWith("**Approve")))
    const approval = discord.in(thread).find((message) => message.content.startsWith("**Approve"))!
    const buttons = approval.components![0]!.components
    expect(buttons.map((button) => [button.label, button.style])).toEqual([["Allow once", 3], ["Deny", 4]])
    const allow = buttons[0]!.custom_id!

    const stranger = discord.press(thread, allow, "43")
    await until(() => discord.acks.includes(stranger))
    await until(() => discord.followups.some((followup) => followup.content.startsWith("Only the person who paired")))
    expect(discord.followups.every((followup) => followup.flags === 64)).toBe(true)

    const owner = discord.press(thread, allow)
    await until(() => discord.acks.includes(owner))
    await until(() => discord.followups.some((followup) => followup.content === "Allowed"))
    const done = async () => { const reply = await h.client.send({ type: "session.history", sessionId, limit: 1 }); return reply.ok ? (reply.result as { turns: Array<{ outcome: string }> }).turns[0]?.outcome : undefined }
    const end = Date.now() + 8_000
    while (await done() === "running" && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 20))
    expect(await done()).toBe("completed")
  })

  test("a missing token is reported and nothing connects", async () => {
    const discord = fakeDiscord()
    const root = mkdtempSync(path.join(tmpdir(), "mendd-discord-"))
    cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => discord.stop())
    const daemon = await startDaemon({ dir: root, socketPath: path.join(root, "mendd.sock"), defaultDirectory: root, engine: ({ clock }) => createFauxEngine({ clock }), channels: { env: {}, discord: discord.seams } })
    const client = createClient({ socketPath: daemon.socketPath, name: "discord-test" })
    await client.connect()
    cleanups.push(() => daemon.stop(), () => client.close())
    const enabled = await client.send({ type: "channels.change", change: { action: "enable", channel: "discord" } })
    const report = enabled.ok ? ChannelsReport.parse(enabled.result) : undefined
    expect(report?.discord).toMatchObject({ enabled: true, tokenConfigured: false, running: false })
    expect(report?.discord?.error).toContain("MENDCODE_DISCORD_TOKEN")
    expect(report?.telegram.enabled).toBe(false)
    expect(discord.identified).toEqual([])
  })
})

describe("Discord formatting", () => {
  test("Markdown goes as written except tables, which become aligned columns in a code block", () => {
    expect(markdownForDiscord("**Done**\n\n| File | Lines |\n|---|---|\n| a.ts | 12 |\n\n```\n| not | a table |\n|---|---|\n```")).toBe(
      "**Done**\n\n```\nFile  Lines\n────  ─────\na.ts  12\n```\n\n```\n| not | a table |\n|---|---|\n```",
    )
  })

  test("buttons become rows of at most five, styled for allow and deny, with links as link buttons", () => {
    const rows = discordComponents([[{ text: "Allow once", data: "ap:1:y" }, { text: "Deny", data: "ap:1:n" }], ...Array.from({ length: 6 }, (_, index) => [{ text: `S${index}`, data: `s:ses_${index}` }]), [{ text: "Open the thread", url: "https://discord.com/channels/1/2" }]])
    expect(rows.map((row) => (row.components as unknown[]).length)).toEqual([5, 4])
    expect((rows[0]!.components as Array<{ style: number }>).slice(0, 3).map((button) => button.style)).toEqual([3, 4, 2])
    expect((rows[1]!.components as Array<{ style: number; url?: string }>).at(-1)).toMatchObject({ style: 5, url: "https://discord.com/channels/1/2" })
  })
})
