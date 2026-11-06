import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { computeBuildId } from "@mendcode/build-id"
import { createClient } from "@mendcode/client"
import { createClaudeEngine, type ClaudeTransport } from "@mendcode/engine-claude"
import { AGENT_SHELL_ENV, type SessionId } from "@mendcode/protocol"
import { agentProcesses } from "@mendcode/tools"
import { startDaemon } from "../src"

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  agentProcesses.clear()
})
const temp = (prefix: string) => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
const until = async <T>(read: () => T | undefined | Promise<T | undefined>, what: string, ms = 30_000): Promise<T> => {
  const end = Date.now() + ms
  for (;;) {
    const value = await read()
    if (value) return value
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await Bun.sleep(50)
  }
}

describe.skipIf(process.platform === "win32")("end to end: a session whose engine is Claude Code", () => {
  const main = path.resolve(import.meta.dir, "../../../apps/cli/src/main.ts")

  test("a client run by the Claude Code process's tools is known by its session: a file attaches and a child above its mode asks for approval", async () => {
    const dir = temp("mcev-claude-origin-")
    const project = temp("mcev-claude-origin-project-")
    const helpers: Array<ReturnType<typeof Bun.spawn>> = []
    cleanups.push(() => { for (const helper of helpers) helper.kill() })
    const announced: Array<{ sessionId: string; pid: number }> = []
    // The first `claude` process of each session is a real shell: what its "Bash tool" runs is a real descendant of the pid the engine reports.
    const claudeProcess = (): ClaudeTransport => {
      const helper = Bun.spawn(["/bin/sh", "-c", 'while IFS= read -r line; do eval "$line"; done'], {
        cwd: project,
        stdin: "pipe",
        stdout: "ignore",
        stderr: "ignore",
        // The tools' environment carries no session marks: only the process tree can say who is asking.
        env: Object.fromEntries(Object.entries({ ...process.env, MENDCODE_V2_DIR: dir }).filter(([key]) => key !== AGENT_SHELL_ENV && key !== "MENDCODE_SESSION_ID")) as Record<string, string>,
      })
      helpers.push(helper)
      const queue: string[] = []
      let wake: (() => void) | undefined
      let done = false
      const push = (message: unknown) => { queue.push(JSON.stringify(message)); wake?.() }
      helper.exited.then(() => { done = true; wake?.() })
      return {
        write(line) {
          const message = JSON.parse(line)
          if (message.type === "control_request") push({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } })
          else if (message.type === "user") {
            const text = String(message.message.content[0]?.text ?? "")
            if (text.startsWith("sh:")) { helper.stdin!.write(`${text.slice(3)}\n`); helper.stdin!.flush() }
            queueMicrotask(() => push({ type: "result", subtype: "success", is_error: false, terminal_reason: "completed", session_id: "cc-1", usage: { input_tokens: 1, output_tokens: 1 }, modelUsage: {} }))
          }
        },
        lines: (async function* () {
          while (!done || queue.length) {
            if (queue.length) yield queue.shift()!
            else await new Promise<void>((resolve) => (wake = resolve))
          }
        })(),
        close: () => void helper.kill(),
        exited: helper.exited,
        pid: helper.pid,
        stderrTail: () => "",
      }
    }
    const daemon = await startDaemon({
      dir,
      socketPath: path.join(dir, "mendd.sock"),
      defaultDirectory: project,
      buildId: computeBuildId(),
      engine: () => createClaudeEngine({
        cwdFor: () => project,
        modelFor: () => ({ model: "haiku" }),
        transportFactory: claudeProcess,
        onProcess: (sessionId, pid) => {
          announced.push({ sessionId, pid })
          const tracked = agentProcesses.agent(pid, sessionId)
          return () => tracked.exited()
        },
      }),
    })
    const events: Array<{ type: string; sessionId?: string; requestId?: string }> = []
    const owner = createClient({ socketPath: daemon.socketPath, name: "owner", capabilities: ["extension-dialogs"], onEvent: (event) => void events.push(event as never) })
    await owner.connect()
    cleanups.push(() => daemon.stop(), () => owner.close())
    const created = await owner.send({ type: "session.create", directory: project })
    if (!created.ok) throw new Error(created.error.message)
    const sessionId = created.result!.sessionId as SessionId
    await owner.subscribe(sessionId, 0)

    const honest = path.join(project, "honest")
    writeFileSync(honest, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(main)} "$@"\n`)
    chmodSync(honest, 0o755)
    writeFileSync(path.join(project, "a.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==", "base64"))
    const out = path.join(dir, "run.out")

    // The tool call (in the foreground, as Claude Code's Bash runs it): Claude Code runs `mendcode run --bg --permission smart --file a.png …` from its own process.
    const sent = await owner.send({ type: "user.submit", sessionId, text: `sh:./honest run --bg --permission smart --file a.png "fix it" > ${JSON.stringify(out)} 2>&1`, attachments: [] })
    expect(sent.ok).toBe(true)
    expect(announced).toHaveLength(1)
    expect(announced[0]!.sessionId).toBe(sessionId)

    // The approval card for the child reaches the calling session; nothing was refused for lack of a session.
    const card = await until(() => events.find((event) => event.type === "server.request" && event.sessionId === sessionId), `the approval card (run output: ${existsSync(out) ? readFileSync(out, "utf8") : "none"}; events: ${events.map((event) => event.type).join(",")})`)
    expect(card.requestId).toBeTruthy()
    const text = existsSync(out) ? readFileSync(out, "utf8") : ""
    expect(text).not.toContain("without a session")

    expect((await owner.send({ type: "request.resolve", sessionId, requestId: card.requestId!, decision: { kind: "answer", text: "Approve once", answers: [["Approve once"]] } } as never)).ok).toBe(true)
    await until(() => (existsSync(out) && /ses_/.test(readFileSync(out, "utf8")) ? true : undefined), "the run to start the child")
    expect(readFileSync(out, "utf8")).not.toContain("refused")
  }, 90_000)
})
