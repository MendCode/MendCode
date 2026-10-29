import { afterEach, expect, test } from "bun:test"
import type { ModelRequest } from "@mendcode/engine-native"
import type { SessionId, TurnId } from "@mendcode/protocol"
import { shellKill, shellMonitor, shellOutput } from "@mendcode/tools"
import { boot, callTool, hang, openSession, put, stop, until, type NativeHarness, type Step } from "./native-harness"
import path from "node:path"

const all: NativeHarness[] = []
afterEach(async () => { for (const h of all.splice(0).reverse()) await h.cleanup() })
const start = async (options: Parameters<typeof boot>[0] = {}) => { const h = await boot({ shell: true, ...options }); all.push(h); return h }
const LONG = 20_000

const background = (command: string) => callTool("shell", { command, background: true })
const added = (h: NativeHarness, id: SessionId) => h.store.readAfter(id, 0, 2000).filter((event) => event.type === "queue.added" && event.notice)
const turns = (h: NativeHarness, id: SessionId) => h.store.turns.list(id)
const ended = (h: NativeHarness, id: SessionId) => turns(h, id).filter((turn) => turn.status !== "running").length
/** The text of each user-role message of a model call that is a background notice. */
const noticesIn = (request: ModelRequest) => request.messages.flatMap((message) => (message.role === "user" && /^\[(background task|monitor) /.test(message.content) ? [message.content] : []))
const lastText = (request: ModelRequest) => { const message = request.messages.at(-1)!; return message.role === "tool" ? message.output : message.content }
const shownNotices = (h: NativeHarness) => h.events.filter((event) => event.type === "item.started" && event.kind === "user_message" && event.meta?.notice === true)
/** A model call that answers only after `count` notices reached the session, so the task is known to have ended while the turn still works. */
const after = (h: () => NativeHarness, id: () => SessionId, count: number, events: ReturnType<typeof stop>): Step => async () => { await until(() => added(h(), id()).length >= count); return events }
const submit = (h: NativeHarness, id: SessionId, text: string) => h.client.send({ type: "user.submit", sessionId: id, text, attachments: [] })

test("a background task that ends while the turn still calls tools is announced inside that turn, at its next model call", async () => {
  let id!: SessionId
  const h: NativeHarness = await start({ steps: [background("sleep 0.2; echo built"), callTool("probe", {}), after(() => h, () => id, 1, callTool("probe", {})), stop("the build passed")] })
  id = await openSession(h)
  await submit(h, id, "build it")
  await until(() => ended(h, id) === 1)
  // One turn, four model calls: the notice was not left for a turn of its own after the answer (the script has no fifth call to give).
  await new Promise((resolve) => setTimeout(resolve, 150))
  expect(turns(h, id)).toHaveLength(1)
  expect(h.requests).toHaveLength(4)
  expect(noticesIn(h.requests[2]!)).toHaveLength(0)
  const seen = noticesIn(h.requests[3]!)
  expect(seen).toHaveLength(1)
  expect(seen[0]).toContain("exited 0")
  expect(seen[0]).toContain("built")
  // Appended at the tail: everything the model had already read is unchanged before it, so the cached prefix still matches.
  const earlier = h.requests[2]!.messages
  expect(h.requests[3]!.messages.slice(0, earlier.length)).toEqual(earlier)
  expect(lastText(h.requests[3]!)).toBe(seen[0]!)
  expect(h.requests[3]!.messages.at(-2)).toMatchObject({ role: "tool", output: "probed" })
  // Delivered once, shown where it arrived as a notice of that turn, and gone from the queue.
  expect(added(h, id)).toHaveLength(1)
  await until(() => h.events.some((event) => event.type === "turn.completed"))
  expect(shownNotices(h)).toMatchObject([{ turnId: turns(h, id)[0]!.turnId }])
  expect(h.events.findLast((event) => event.type === "queue.changed")).toMatchObject({ queue: [] })
  expect(h.store.queueOf(id)).toEqual([])
  // The turn is still the user's (history, undo and edits go by this), not a notice turn.
  expect(turns(h, id)[0]).toMatchObject({ notice: false, preview: "build it", status: "completed" })
}, LONG)

test("the turn that was already writing its answer ends first: the notice then gets its own turn, once", async () => {
  let id!: SessionId
  const h: NativeHarness = await start({ steps: [background("sleep 0.2; echo late"), after(() => h, () => id, 1, stop("started it")), stop("saw it end")] })
  id = await openSession(h)
  await submit(h, id, "start it")
  await until(() => ended(h, id) === 2)
  await new Promise((resolve) => setTimeout(resolve, 150))
  expect(turns(h, id)).toHaveLength(2)
  expect(h.requests).toHaveLength(3)
  expect(noticesIn(h.requests[1]!)).toHaveLength(0)
  expect(noticesIn(h.requests[2]!)).toHaveLength(1)
  expect(lastText(h.requests[2]!)).toContain("late")
  expect(added(h, id)).toHaveLength(1)
  expect(h.store.queueOf(id)).toEqual([])
}, LONG)

test("a task that ends while a tool is still executing does not interrupt it: the notice follows that tool's result", async () => {
  let id!: SessionId
  const h: NativeHarness = await start({ steps: [background("sleep 0.2; echo quick"), callTool("shell", { command: "sleep 0.8; echo slow" }), stop("both seen")] })
  id = await openSession(h)
  await submit(h, id, "run them")
  await until(() => ended(h, id) === 1)
  expect(turns(h, id)).toMatchObject([{ status: "completed" }])
  expect(h.requests).toHaveLength(3)
  const roles = h.requests[2]!.messages.slice(-2)
  expect(roles[0]).toMatchObject({ role: "tool", name: "shell", isError: false, output: expect.stringContaining("slow") })
  expect(roles[1]).toMatchObject({ role: "user", content: expect.stringContaining("quick") })
}, LONG)

test("tasks that end at different steps are each told once, in the order they ended", async () => {
  let id!: SessionId
  const h: NativeHarness = await start({ steps: [background("echo first"), after(() => h, () => id, 1, background("echo second")), after(() => h, () => id, 2, callTool("probe", {})), stop("both done")] })
  id = await openSession(h)
  await submit(h, id, "run both")
  await until(() => ended(h, id) === 1)
  await new Promise((resolve) => setTimeout(resolve, 150))
  expect(turns(h, id)).toHaveLength(1)
  expect(h.requests).toHaveLength(4)
  // The first one had ended before the second call's tool ran: it joined alone after that step.
  expect(noticesIn(h.requests[2]!)).toHaveLength(1)
  const told = noticesIn(h.requests[3]!).join("\n")
  expect(told.match(/\[background task bg_\w+ exited 0/g)).toHaveLength(2)
  expect(told.indexOf("first")).toBeLessThan(told.indexOf("second"))
  expect(added(h, id)).toHaveLength(2)
  expect(h.store.queueOf(id)).toEqual([])
}, LONG)

test("two tasks that end during one model call are one message and one transcript notice", async () => {
  let id!: SessionId
  const h: NativeHarness = await start({ steps: [[background("sleep 0.05; echo alpha")[0]!, ...background("sleep 0.15; echo omega")], after(() => h, () => id, 2, callTool("probe", {})), stop("done")] })
  id = await openSession(h)
  await submit(h, id, "run both")
  await until(() => ended(h, id) === 1)
  expect(turns(h, id)).toHaveLength(1)
  const seen = noticesIn(h.requests[2]!)
  expect(seen).toHaveLength(1)
  expect(seen[0]!.match(/\[background task bg_\w+ exited 0/g)).toHaveLength(2)
  expect(seen[0]!.indexOf("alpha")).toBeLessThan(seen[0]!.indexOf("omega"))
  await until(() => h.events.some((event) => event.type === "turn.completed"))
  expect(shownNotices(h)).toHaveLength(1)
  expect(added(h, id)).toHaveLength(2)
  expect(h.store.queueOf(id)).toEqual([])
}, LONG)

test("a notice read inside the turn is context, not a prompt: a path in the task's output is not expanded", async () => {
  let id!: SessionId
  const h: NativeHarness = await start({ steps: [background("echo see @secret-notes.txt"), after(() => h, () => id, 1, callTool("probe", {})), stop("done")] })
  put(path.join(h.project, "secret-notes.txt"), "FILE BODY THE MODEL DID NOT ASK FOR")
  id = await openSession(h)
  await submit(h, id, "run it")
  await until(() => ended(h, id) === 1)
  const seen = noticesIn(h.requests[2]!)
  expect(seen).toHaveLength(1)
  expect(seen[0]).toContain("see @secret-notes.txt")
  expect(JSON.stringify(h.requests[2]!.messages)).not.toContain("FILE BODY")
}, LONG)

test("after a user cancel the notice waits and goes with the user's next message (FC-13)", async () => {
  let id!: SessionId
  const h: NativeHarness = await start({ steps: [background("sleep 0.3; echo held"), hang, stop("read it")] })
  id = await openSession(h)
  await submit(h, id, "start it")
  await until(() => h.requests.length === 2)
  await h.client.send({ type: "turn.cancel", sessionId: id, turnId: turns(h, id)[0]!.turnId as TurnId })
  await until(() => turns(h, id)[0]?.status === "cancelled" && added(h, id).length === 1)
  await new Promise((resolve) => setTimeout(resolve, 100))
  expect(h.requests).toHaveLength(2)
  expect(h.store.queueOf(id)).toHaveLength(1)
  await submit(h, id, "what happened")
  await until(() => ended(h, id) === 2)
  expect(h.requests).toHaveLength(3)
  const last = lastText(h.requests[2]!)
  expect(last.startsWith("[while the session was stopped, this happened]\n[background task ")).toBe(true)
  expect(last).toContain("held")
  expect(last.endsWith("[the user's message]\nwhat happened")).toBe(true)
  expect(h.store.queueOf(id)).toEqual([])
}, LONG)

test("an idle session is woken by the notice, as before", async () => {
  let id!: SessionId
  const h: NativeHarness = await start({ steps: [background("sleep 0.3; echo woke"), stop("started"), stop("it ended")] })
  id = await openSession(h)
  await submit(h, id, "start it")
  await until(() => ended(h, id) === 2)
  expect(noticesIn(h.requests[1]!)).toHaveLength(0)
  expect(lastText(h.requests[2]!)).toContain("woke")
  expect(added(h, id)).toHaveLength(1)
}, LONG)

const taskId = (request: ModelRequest) => /bg_\w+/.exec(lastText(request))![0]

test("a task the model waited on to its exit is not announced as well: shell_output already gave the exit and the last output", async () => {
  let id!: SessionId
  const h: NativeHarness = await start({
    extraTools: [shellOutput],
    steps: [background("echo compiling; sleep 0.3; echo built"), (request) => callTool("shell_output", { id: taskId(request), until: "exit", waitMs: 10_000 }), callTool("probe", {}), stop("the build passed")],
  })
  id = await openSession(h)
  await submit(h, id, "build it")
  await until(() => ended(h, id) === 1)
  await new Promise((resolve) => setTimeout(resolve, 200))
  expect(turns(h, id)).toMatchObject([{ status: "completed" }])
  expect(h.requests).toHaveLength(4)
  // One call waited through the task's output to its end.
  const waited = lastText(h.requests[2]!)
  expect(waited).toMatch(/^bg_\w+ exited 0 after \d+s\ncompiling\nbuilt\n$/)
  for (const request of h.requests) expect(noticesIn(request)).toHaveLength(0)
  expect(shownNotices(h)).toHaveLength(0)
  expect(h.store.queueOf(id)).toEqual([])
}, LONG)

test("a task that ended during a model call whose reply reads it with a plain shell_output is not announced either, in that turn or after it", async () => {
  let id!: SessionId
  const h: NativeHarness = await start({
    extraTools: [shellOutput],
    steps: [background("sleep 0.2; echo quick"), async (request) => { await until(() => added(h, id).length === 1); return callTool("shell_output", { id: taskId(request) }) }, stop("it printed quick")],
  })
  id = await openSession(h)
  await submit(h, id, "run it")
  await until(() => ended(h, id) === 1)
  await new Promise((resolve) => setTimeout(resolve, 200))
  // The notice was queued when the task ended, and dropped unread once shell_output had shown that exit.
  expect(added(h, id)).toHaveLength(1)
  expect(turns(h, id)).toHaveLength(1)
  expect(h.requests).toHaveLength(3)
  expect(lastText(h.requests[2]!)).toMatch(/^bg_\w+ exited 0 after \d+s\nquick\n$/)
  expect(noticesIn(h.requests[2]!)).toHaveLength(0)
  expect(h.store.queueOf(id)).toEqual([])
  expect(h.events.findLast((event) => event.type === "queue.changed")).toMatchObject({ queue: [] })
}, LONG)

test("a task whose output was only partly read while it ran is still announced when it ends", async () => {
  let id!: SessionId
  const h: NativeHarness = await start({
    extraTools: [shellOutput],
    steps: [background("echo part; sleep 0.4; echo rest"), (request) => callTool("shell_output", { id: taskId(request), waitMs: 5_000 }), after(() => h, () => id, 1, callTool("probe", {})), stop("read both")],
  })
  id = await openSession(h)
  await submit(h, id, "run it")
  await until(() => ended(h, id) === 1)
  expect(turns(h, id)).toHaveLength(1)
  expect(lastText(h.requests[2]!)).toMatch(/^bg_\w+ running \d+s\npart\n$/)
  const seen = noticesIn(h.requests[3]!)
  expect(seen).toHaveLength(1)
  expect(seen[0]).toContain("exited 0")
  expect(seen[0]).toContain("rest")
  await until(() => h.events.some((event) => event.type === "turn.completed"))
  expect(shownNotices(h)).toHaveLength(1)
}, LONG)

test("a monitor's lines join the running turn the same way", async () => {
  let id!: SessionId
  const h: NativeHarness = await start({
    extraTools: [shellMonitor, shellKill],
    steps: [
      background("sleep 0.3; echo server ready; sleep 30"),
      (request) => callTool("shell_monitor", { id: /bg_\w+/.exec(lastText(request))![0], match: ["ready"] }),
      after(() => h, () => id, 1, callTool("probe", {})),
      (request) => callTool("shell_kill", { id: /bg_\w+/.exec(noticesIn(request)[0]!)![0] }),
      stop("server is up"),
    ],
  })
  id = await openSession(h)
  await submit(h, id, "start the server")
  await until(() => ended(h, id) === 1, 15_000)
  expect(turns(h, id)).toHaveLength(1)
  const seen = noticesIn(h.requests[3]!)
  expect(seen).toHaveLength(1)
  expect(seen[0]).toMatch(/^\[monitor bg_\w+: /)
  expect(seen[0]).toContain("server ready")
  expect(h.store.queueOf(id)).toEqual([])
}, LONG)
