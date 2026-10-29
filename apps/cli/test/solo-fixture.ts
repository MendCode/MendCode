// A terminal without the screen: starts like main.ts does in solo mode (ensureDaemon with `solo`, a client through the
// in-memory loopback), then does what the test asks over stdin, one JSON object per line, and prints one JSON line per answer.
//   {"op":"submit","text":"/tool 800"}   starts a turn on a new session; answers {"op":"submit","sessionId":...}
//   {"op":"status"}                        the daemon's own status
//   {"op":"leave"}                         closes the terminal the way main.ts does (leaveSolo); answers the outcome and exits
// It runs in its own process because the daemon module can be hosted only once per process.
import { createClient } from "@mendcode/client"
import { ensureDaemon } from "../src/launcher"
import { leaveSolo } from "../src/solo"

const arg = (name: string) => { const at = process.argv.indexOf(`--${name}`); return at >= 0 ? process.argv[at + 1] : undefined }
const dir = arg("dir")!
const emit = (value: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(value)}\n`)
const options = { dir, engine: "faux", cwd: dir, timeoutMs: 15_000 }

const started = await ensureDaemon({ ...options, solo: arg("process") !== "daemon" })
const host = started.host
const client = createClient({
  socketPath: started.socketPath,
  ...(host ? { loopback: () => (host.stopped ? undefined : host.attach) } : {}),
  name: "solo-fixture",
  reconnect: false,
})
await client.connect()
emit({ op: "ready", pid: process.pid, hosted: host !== undefined, started: started.started })

let sessionId: string | undefined
let leaving: Promise<unknown> | undefined
const reader = process.stdin.pipe ? process.stdin : undefined
let pending = ""
reader?.setEncoding("utf8")
reader?.on("data", (chunk: string) => {
  pending += chunk
  for (let newline = pending.indexOf("\n"); newline >= 0; newline = pending.indexOf("\n")) {
    const line = pending.slice(0, newline)
    pending = pending.slice(newline + 1)
    if (line.trim()) void handle(JSON.parse(line) as { op: string; text?: string })
  }
})

async function handle(request: { op: string; text?: string }) {
  if (request.op === "submit") {
    const created = await client.send({ type: "session.create", directory: dir, title: "solo" })
    sessionId = created.ok ? String((created.result as { sessionId: string }).sessionId) : undefined
    const sent = await client.send({ type: "user.submit", sessionId: sessionId as never, text: request.text ?? "hello", attachments: [] })
    emit({ op: "submit", ok: sent.ok, sessionId })
  } else if (request.op === "status") {
    const reply = await client.send({ type: "daemon.status" })
    emit({ op: "status", ok: reply.ok, result: reply.ok ? reply.result : undefined })
  } else if (request.op === "leave") {
    leaving ??= (async () => {
      const outcome = host
        ? await leaveSolo({
            host,
            status: async () => { const reply = await client.send({ type: "daemon.status" }); return reply.ok ? reply.result : undefined },
            closeClient: () => client.close(),
            handOff: () => ensureDaemon(options),
            interrupted: new Promise(() => {}),
            notify: (message) => emit({ op: "notice", message }),
            sleep: Bun.sleep,
            pollMs: 50,
          })
        : "daemon"
      emit({ op: "leave", outcome })
      process.exit(0)
    })()
  }
}
