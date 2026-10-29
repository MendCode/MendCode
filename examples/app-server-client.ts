/**
 * Drives `mendcode app-server` from a program: starts a thread, runs one turn, prints the answer as it streams.
 *
 *   bun examples/app-server-client.ts "explain this repo" [--cwd DIR] [--accept]
 *
 * `MENDCODE_BIN` names the executable (default `mendcode`); `MENDCODE_DIR` passes `--dir` for a separate data
 * directory. Approvals are declined unless `--accept` is given (then each one is accepted once). See docs/embedding.md.
 */
import { createAppServerClient } from "@mendcode/client/app-server"

const argv = process.argv.slice(2)
const accept = argv.includes("--accept")
const cwdIndex = argv.indexOf("--cwd")
const cwd = cwdIndex >= 0 ? argv[cwdIndex + 1] : undefined
const prompt = argv.filter((word, index) => !word.startsWith("--") && argv[index - 1] !== "--cwd").join(" ").trim()
if (!prompt) {
  process.stderr.write('usage: bun examples/app-server-client.ts "prompt" [--cwd DIR] [--accept]\n')
  process.exit(64)
}

const dataDir = process.env.MENDCODE_DIR
const server = Bun.spawn([process.env.MENDCODE_BIN ?? "mendcode", "app-server", ...(dataDir ? ["--dir", dataDir] : [])], { stdin: "pipe", stdout: "pipe", stderr: "inherit" })

const decide = (): { decision: "accept" | "decline" } => ({ decision: accept ? "accept" : "decline" })
const client = createAppServerClient({
  clientInfo: { name: "app-server-example", version: "1.0.0" },
  write: (line) => void server.stdin.write(line),
  handlers: {
    "item/commandExecution/requestApproval": (params) => (process.stderr.write(`approval: ${params.title}\n`), decide()),
    "item/fileChange/requestApproval": (params) => (process.stderr.write(`approval: ${params.title}\n`), decide()),
    "item/tool/requestApproval": (params) => (process.stderr.write(`approval: ${params.title}\n`), decide()),
    // This example cannot ask a person; an empty reply tells the agent to decide on its own.
    "item/tool/requestUserInput": () => ({ answers: {} }),
  },
})
client.on("item/agentMessage/delta", (event) => void process.stdout.write(event.delta))
client.on("item/started", (event) => {
  if (event.item.type === "commandExecution") process.stderr.write(`\n$ ${event.item.command}\n`)
})

// Feed the server's stdout to the client, one line at a time.
void (async () => {
  const decoder = new TextDecoder()
  let pending = ""
  for await (const chunk of server.stdout) {
    pending += decoder.decode(chunk, { stream: true })
    for (let newline = pending.indexOf("\n"); newline >= 0; newline = pending.indexOf("\n")) {
      client.receive(pending.slice(0, newline))
      pending = pending.slice(newline + 1)
    }
  }
  client.close()
})()

await client.initialize()
const { thread } = await client.request("thread/start", { ...(cwd ? { cwd } : {}), approvalPolicy: "ask" })
const result = await client.runTurn({ threadId: thread.id, input: [{ type: "text", text: prompt }] })
process.stdout.write("\n")
process.stderr.write(`thread ${thread.id} · turn ${result.turn.status}\n`)
server.stdin.end()
await server.exited
process.exit(result.turn.status === "completed" ? 0 : 1)
