import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createClient } from "@mendcode/client"
import type { WorkflowSummary } from "@mendcode/protocol"

/**
 * The feature's core promise on real processes and real SQLite: a script run survives `kill -9` of the daemon. A child
 * daemon runs the script (faux engine, a real isolated script host), is killed with one agent() in flight, and a second
 * daemon on the same data directory resumes it from the persisted journal.
 */

const FIXTURE = path.join(import.meta.dir, "fixtures", "script-restart-daemon.ts")
const SCRIPT = `export const meta = { name: "restart", budget: { agents: 8 } }
const one = await agent("first step", { label: "one" })
const rest = await parallel([() => agent("second step", { label: "two" }), () => agent("third step", { label: "gate-three" })])
const last = await agent("final step after " + one, { label: "four" })
return { one, rest, last, when: Date.now() > 0 }`

const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const tempDir = () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mendd-restart-")))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
async function until(check: () => boolean | Promise<boolean>, label: string, ms = 30_000) {
  const start = Date.now()
  while (!(await check())) {
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}
const turns = (dir: string) => (existsSync(path.join(dir, "turns.log")) ? readFileSync(path.join(dir, "turns.log"), "utf8").split("\n").filter(Boolean) : [])

/** Starts a daemon process on `dir` and a client to it; `kill` is SIGKILL, `stop` a normal termination. */
async function boot(dir: string) {
  const child = Bun.spawn(["bun", FIXTURE, dir], { stdout: "pipe", stderr: "pipe", stdin: "ignore" })
  let output = ""
  void (async () => {
    const decoder = new TextDecoder()
    for await (const chunk of child.stdout) output += decoder.decode(chunk)
  })()
  await until(() => output.includes("ready "), "the daemon process to listen")
  const changes: WorkflowSummary[] = []
  const client = createClient({ socketPath: path.join(dir, "mendd.sock"), name: "restart", onGlobal: (event) => void (event.type === "workflow.changed" && changes.push(event.workflow)) })
  await client.connect()
  const kill = async () => {
    child.kill("SIGKILL")
    await child.exited
    client.close()
  }
  cleanups.push(async () => {
    if (child.exitCode === null) await kill()
  })
  return { client, changes, kill }
}

async function result(client: ReturnType<typeof createClient>, workflowId: string) {
  const full = await client.send({ type: "workflow.get", workflowId } as never)
  return full.ok ? (full.result?.workflow as { state: string; script: { result?: string } }) : undefined
}

describe("script workflows survive a daemon kill (real processes, real SQLite)", () => {
  test("completed calls are not run again, the in-flight one starts again, and the result matches an uninterrupted run", async () => {
    // The reference: the same script, uninterrupted (gate open from the start).
    const reference = tempDir()
    writeFileSync(path.join(reference, "open"), "")
    const calm = await boot(reference)
    const calmStart = await calm.client.send({ type: "workflow.start", directory: reference, plan: { script: SCRIPT } } as never)
    const calmId = (calmStart.ok ? (calmStart.result?.workflow as WorkflowSummary) : undefined)!.workflowId
    await until(async () => (await result(calm.client, calmId))?.state === "completed", "the uninterrupted run to complete")
    const expected = (await result(calm.client, calmId))!.script.result
    expect(JSON.parse(expected!)).toMatchObject({ one: "ok:one", last: "ok:four" })
    await calm.kill()

    // The interrupted run: the third call hangs, the daemon dies with it in flight.
    const dir = tempDir()
    const first = await boot(dir)
    const started = await first.client.send({ type: "workflow.start", directory: reference, plan: { script: SCRIPT } } as never)
    const workflowId = (started.ok ? (started.result?.workflow as WorkflowSummary) : undefined)!.workflowId
    await until(() => ["one", "two", "gate-three"].every((title) => turns(dir).includes(title)), `the three first turns (saw ${turns(dir)})`)
    // Let the two finished calls reach the journal before the crash.
    await until(async () => (JSON.stringify(await result(first.client, workflowId)).match(/"state":"done"/g) ?? []).length >= 2, "two calls done")
    await first.kill()
    expect(turns(dir).sort()).toEqual(["gate-three", "one", "two"])

    // A new daemon on the same directory resumes the run from the journal.
    writeFileSync(path.join(dir, "open"), "")
    const second = await boot(dir)
    await until(async () => (await result(second.client, workflowId))?.state === "completed", "the resumed run to complete")
    const finished = (await result(second.client, workflowId))!
    expect(JSON.parse(finished.script.result!)).toEqual(JSON.parse(expected!))
    // Finished calls were not asked again; the in-flight one started again (once more); the later one ran once.
    const counts = new Map<string, number>()
    for (const title of turns(dir)) counts.set(title, (counts.get(title) ?? 0) + 1)
    expect(Object.fromEntries(counts)).toEqual({ one: 1, two: 1, "gate-three": 2, four: 1 })
    await second.kill()
  }, 120_000)
})
