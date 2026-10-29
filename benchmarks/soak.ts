// T12 soak: resources return to baseline after sessions, turns and client churn (P10, I11, I16).
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import type { SessionEvent, SessionId } from "@mendcode/protocol"

const MAIN = path.join(import.meta.dir, "../packages/daemon/src/main.ts")
const dir = mkdtempSync(path.join(tmpdir(), "mend-soak-"))
const daemon = Bun.spawn(["bun", MAIN, "--dir", dir], { stdout: "pipe", stderr: "inherit" })
const reader = daemon.stdout.getReader()
const { socketPath } = JSON.parse(new TextDecoder().decode((await reader.read()).value).split("\n")[0]!) as { socketPath: string }

async function footprintMB(pid: number) {
  const out = await new Response(Bun.spawn(["vmmap", "--summary", String(pid)], { stdout: "pipe", stderr: "ignore" }).stdout).text()
  const match = /Physical footprint:\s+([\d.]+)([KMG])/.exec(out)
  return match ? Number(match[1]) * { K: 1 / 1024, M: 1, G: 1024 }[match[2] as "K" | "M" | "G"] : NaN
}

const events: SessionEvent[] = []
const main = createClient({ socketPath, name: "soak", reconnect: false, onEvent: (e) => events.push(e) })
await main.connect()

async function diagnostics() {
  const reply = await main.send({ type: "diagnostics.resources" })
  if (!reply.ok) throw new Error(reply.error.message)
  return reply.result as Record<string, number>
}

async function waitTurns(sessionId: SessionId, count: number) {
  const deadline = Date.now() + 10_000
  while (events.filter((e) => e.sessionId === sessionId && (e.type === "turn.completed" || e.type === "turn.cancelled")).length < count) {
    if (Date.now() > deadline) throw new Error("turns did not finish")
    await Bun.sleep(5)
  }
}

async function cycle(sessions: number) {
  const created: SessionId[] = []
  for (let i = 0; i < sessions; i++) {
    const reply = await main.send({ type: "session.create", directory: "/repo", title: `soak ${i}` })
    if (!reply.ok) throw new Error(reply.error.message)
    const sessionId = reply.result?.sessionId as SessionId
    created.push(sessionId)
    await main.subscribe(sessionId, 0)
    await main.send({ type: "user.submit", sessionId, text: "hola", attachments: [] })
    await main.send({ type: "user.submit", sessionId, text: "/tool 5", attachments: [] })
    await main.send({ type: "user.submit", sessionId, text: "/hang", attachments: [] })
    await waitTurns(sessionId, 2)
    const started = () => events.filter((e) => e.sessionId === sessionId && e.type === "turn.started")
    while (started().length < 3) await Bun.sleep(2)
    const hang = started().at(-1)
    if (hang?.type === "turn.started") await main.send({ type: "turn.cancel", sessionId, turnId: hang.turnId })
    await waitTurns(sessionId, 3)
    await main.send({ type: "client.unsubscribe", sessionId })
  }
  return created
}

const warm = await cycle(10)
await Bun.sleep(500)
const base = await diagnostics()
const baseMB = await footprintMB(daemon.pid)

const created = await cycle(50)
for (let i = 0; i < 100; i++) {
  const viewer = createClient({ socketPath, name: `viewer ${i}`, reconnect: false })
  await viewer.connect()
  await viewer.subscribe(created[i % created.length]!, 0)
  viewer.close()
}
await Bun.sleep(1_000)
const final = await diagnostics()
const finalMB = await footprintMB(daemon.pid)

const growth = (finalMB - baseMB) / baseMB
const result = {
  warmSessions: warm.length,
  soakSessions: created.length,
  viewerCycles: 100,
  baseFootprintMB: +baseMB.toFixed(1),
  finalFootprintMB: +finalMB.toFixed(1),
  growthPercent: +(growth * 100).toFixed(1),
  base: { timers: base.timers, scopes: base.scopes, actors: base.actors, connections: base.connections },
  final: { timers: final.timers, scopes: final.scopes, actors: final.actors, connections: final.connections, jobs: final.jobs },
  pass: Math.abs(growth) <= 0.05 && final.timers === 0 && final.actors === 0 && final.jobs === 0 && final.scopes === base.scopes,
}
console.log(JSON.stringify(result))
main.close()
daemon.kill("SIGTERM")
await daemon.exited
rmSync(dir, { recursive: true, force: true })
process.exit(result.pass ? 0 : 1)
