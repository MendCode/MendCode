import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, writeFileSync } from "node:fs"
import path from "node:path"
import type { Client, CommandInput, CommandReply } from "@mendcode/client"
import type { SessionId } from "@mendcode/protocol"
import { parseStartup, prepareStartup, prepareRunSubmission } from "../src/startup"
import { parseRemoteFlags } from "../src/remote"
import { createAcpAgent } from "../src/acp"
import { appHarness, cleanTemps, ids, tempDir } from "./session-ui-harness"
import { writeSnapshot } from "../src/diagnostics"
import { statSync } from "node:fs"
import { textWidth } from "../src/view/wrap"

afterEach(cleanTemps)
const memory = { rss: 42 * 1048576, heapTotal: 20 * 1048576, heapUsed: 10 * 1048576, external: 1048576, arrayBuffers: 0 }
const resources = { memory, rssBytes: memory.rss, scopes: 4, timers: 2, disposers: 3, connections: 1, actors: 2, jobs: 0, pid: 42, uptime: 60 }
function fake(answer: (command: CommandInput) => CommandReply) {
  const sent: CommandInput[] = []
  const client = { send: async (command: CommandInput) => { sent.push(command); return answer(command) } } as Pick<Client, "send">
  return { client, sent }
}

describe("B16 startup parsing", () => {
  test("headless selections, aliases, files, title and permissions", () => {
    expect(parseStartup(["run", "review", "-m", "openai/gpt-6-luna", "--agent", "plan", "--variant", "high", "-c", "--fork", "-f", "one.txt", "two.txt", "--title", "--thinking", "--dangerously-skip-permissions", "--format=json", "--cwd", "../project", "--dir", "/data"], { exists: () => true })).toMatchObject({ kind: "run", words: ["review"], model: "openai/gpt-6-luna", agent: "plan", variant: "high", continue: true, fork: true, files: ["one.txt", "two.txt"], title: "", thinking: true, approve: true, json: true, project: "../project", dataDir: "/data" })
    expect(parseStartup(["run", "--command=review", "--", "--literal", "argument"])).toMatchObject({ command: "review", words: ["--literal", "argument"] })
  })
  test("--file takes the existing paths after it; the first argument that is not one starts the message", () => {
    const project = tempDir("mendcode-file-order-")
    for (const name of ["a.png", "b.txt", "notes dir"]) writeFileSync(path.join(project, name), "x")
    const parse = (...argv: string[]) => { const { files, words } = parseStartup(["run", ...argv], { cwd: project }); return { files, words } }
    // The natural order: the prompt after the attachment.
    expect(parse("--file", "a.png", "describe this image")).toEqual({ files: ["a.png"], words: ["describe this image"] })
    expect(parse("-f", "a.png", "b.txt", "notes dir", "compare", "them")).toEqual({ files: ["a.png", "b.txt", "notes dir"], words: ["compare", "them"] })
    expect(parse("describe", "--file", "a.png", "b.txt")).toEqual({ files: ["a.png", "b.txt"], words: ["describe"] })
    // Once the message has started, a later existing path is text, and the words keep their order around the flag.
    expect(parse("first", "--file", "a.png", "then", "b.txt", "--json", "last")).toEqual({ files: ["a.png"], words: ["first", "then", "b.txt", "last"] })
    expect(parse("--file", "a.png", "one", "--file", "b.txt", "two")).toEqual({ files: ["a.png", "b.txt"], words: ["one", "two"] })
    expect(parse("--file", path.join(project, "b.txt"), "absolute")).toEqual({ files: [path.join(project, "b.txt")], words: ["absolute"] })
    // The value of --file itself is always an attachment, so a path that does not exist still reaches the daemon's clear error.
    expect(parse("--file", "missing.png", "prompt")).toEqual({ files: ["missing.png"], words: ["prompt"] })
    expect(parse("--file", "missing.png")).toEqual({ files: ["missing.png"], words: [] })
    expect(parse("--file=a.png", "b.txt")).toEqual({ files: ["a.png"], words: ["b.txt"] })
    // --cwd names the project the paths are checked in, wherever it stands on the line.
    expect(parseStartup(["run", "--file", "a.png", "b.txt", "go", "--cwd", project], { cwd: "/" })).toMatchObject({ files: ["a.png", "b.txt"], words: ["go"] })
    expect(() => parseStartup(["run", "--file", ...Array.from({ length: 33 }, () => "a.png")], { cwd: project })).toThrow("at most 32")
  })
  test("a bare - asks to wait for stdin", () => {
    expect(parseStartup(["run", "question", "-"]).waitStdin).toBe(true)
    expect(parseStartup(["run", "question"]).waitStdin).toBeUndefined()
  })
  test("default TUI, thread spelling, draft, prompt, isolated and diagnostics", () => {
    expect(parseStartup(["../project", "--initial-message", "draft", "--isolated", "--diagnostics"])).toMatchObject({ kind: "tui", project: "../project", initialMessage: "draft", isolated: true, diagnostics: true })
    expect(parseStartup(["thread", "--prompt", "go", "-s", ids("session"), "--fork"])).toMatchObject({ kind: "tui", prompt: "go", fork: true })
    expect(parseStartup(["acp", "--cwd", "../project"])).toMatchObject({ kind: "acp", project: "../project" })
  })
  test("bad combinations and missing values fail without side effects", () => {
    for (const args of [["run", "--fork"], ["--prompt", "go", "--initial-message", "draft"], ["run", "--model"], ["run", "--format=yaml"], ["project", "--cwd", "other"], ["--file", "x"], ["run", "--isolated"], ["run", "--diagnostics"], ["--dir", "/a", "--data-dir", "/b"], ["--modle", "x"], ["acp", "--unknown"], ["run", "-z"], ["run", "--thinking=true"]]) expect(() => parseStartup(args)).toThrow()
    expect(() => parseStartup(["run", "--modle", "x"])).toThrow("did you mean --model?")
  })
  test("a flag MendCode does not know is kept for the session's extensions (`--name` true, `--name=value`), for the TUI and run", () => {
    expect(parseStartup(["run", "--plan-first", "--ticket=ABC-12", "go"])).toMatchObject({ kind: "run", words: ["go"], extensionFlags: { "plan-first": true, ticket: "ABC-12" } })
    expect(parseStartup(["--unknown"])).toMatchObject({ kind: "tui", extensionFlags: { unknown: true } })
    expect(parseStartup(["run", "go"]).extensionFlags).toBeUndefined()
  })
  test("pending HTTP/service aliases fail explicitly without echoing secrets", () => {
    for (const flag of ["share", "attach", "password", "username", "port"]) {
      try { parseStartup(["run", `--${flag}=private-secret`]); throw new Error("accepted") } catch (error) {
        expect(String(error)).not.toContain("private-secret")
        expect(String(error)).not.toContain("accepted")
      }
    }
    expect(parseRemoteFlags(["--server-url", "localhost:9876", "--token-file", "/token", "run", "go"])).toMatchObject({ args: ["run", "go"], remote: { hostname: "localhost", port: 9876, tokenFile: "/token" } })
    expect(() => parseRemoteFlags(["--server-url", "http://user:secret@localhost:9876"])).toThrow()
    expect(() => parseRemoteFlags(["--server-url", "localhost:9876", "--connect", "localhost:9876"])).toThrow()
  })
})

test("continue queries project roots; explicit session wins and fork preserves transcript", async () => {
  const root = ids("session"), child = ids("session")
  const h = fake((command) => ({ ok: true, result: command.type === "session.list" ? { sessions: [{ sessionId: root, title: "Root" }] } : command.type === "session.get" ? { session: { directory: "/original" } } : command.type === "session.fork" ? { sessionId: child } : {} }))
  expect(await prepareStartup(h.client, parseStartup(["--continue", "--fork"]), "/project")).toEqual({ sessionId: child, directory: "/original" })
  expect(h.sent[0]).toMatchObject({ type: "session.list", directory: "/project", roots: true, hideEmpty: true })
  expect(h.sent).toContainEqual({ type: "session.fork", sessionId: root, transcript: true })
  h.sent.length = 0
  await prepareStartup(h.client, parseStartup(["--continue", "--session", root]), "/project")
  expect(h.sent[0]?.type).toBe("session.get")
})

test("--session forgives a stray character after the id, the case, a missing ses_ and a piece of the id; none or several says so", async () => {
  const wanted = "ses_01M5ZE5MTCXWJFJ6RJ1Y2VDPB5" as SessionId, other = "ses_01M5ZE5MTCXWJFJ6RJ1Y2VDQ77" as SessionId
  const h = fake((command) => ({ ok: true, result: command.type === "session.list" ? { sessions: [{ sessionId: wanted, title: "a" }, { sessionId: other, title: "b" }] } : command.type === "session.get" ? { session: { directory: "/project" } } : {} }))
  for (const typed of [`${wanted}t`, wanted.toLowerCase(), wanted.slice(4), "vdpb5"]) {
    expect(await prepareStartup(h.client, parseStartup(["--session", typed]), "/project")).toMatchObject({ sessionId: wanted })
  }
  expect(h.sent.filter((command) => command.type === "session.get").every((command) => (command as { sessionId: string }).sessionId === wanted)).toBe(true)
  await expect(prepareStartup(h.client, parseStartup(["--session", "01M5ZE5MTCXWJFJ6RJ1Y2VD"]), "/project")).rejects.toThrow("fits 2 sessions")
  await expect(prepareStartup(h.client, parseStartup(["--session", "ZZZZZZ"]), "/project")).rejects.toThrow("no session ZZZZZZ")
  await expect(prepareStartup(h.client, parseStartup(["--session", "ab"]), "/project")).rejects.toThrow("is not a session id")
})

test("continue opens the last session worked in, past newer ones that hold only an unsent draft", async () => {
  const worked = ids("session"), drafted = ids("session")
  const draft = { preview: "half a thought", chars: 14, attachments: 0, images: 0, updatedAt: 2 }
  const h = fake((command) => ({ ok: true, result: command.type === "session.list" ? { sessions: [{ sessionId: drafted, title: "", draft }, { sessionId: worked, title: "Fix the retry loop" }] } : command.type === "session.get" ? { session: { directory: "/project" } } : {} }))
  expect(await prepareStartup(h.client, parseStartup(["-c"]), "/project")).toMatchObject({ sessionId: worked })
})

test("read-only startup never forks or changes selection", async () => {
  const h = fake(() => ({ ok: true, result: { session: { directory: "/remote" } } }))
  const id = ids("session")
  await expect(prepareStartup(h.client, parseStartup(["--session", id, "--fork"]), "/remote", "", { readOnly: true })).rejects.toThrow("read-only")
  expect(h.sent.map((command) => command.type)).toEqual(["session.get"])
  await expect(prepareRunSubmission(h.client, parseStartup(["run", "--file=local.txt"]), id, "/remote", "go", true)).rejects.toThrow("disabled while remote")
})

test("run executes custom commands in the daemon with text and image attachments", async () => {
  const id = ids("session")
  const blob = { hash: "a".repeat(64), mime: "image/png", bytes: 4 }
  const h = fake((command) => ({ ok: true, result: command.type === "commands.expand" ? { prompt: "Review component" } : command.type === "attachment.paste" && command.path.endsWith(".png") ? { kind: "image", attachment: blob } : { kind: "text", name: "notes.md", content: "requirements" } }))
  const submission = await prepareRunSubmission(h.client, parseStartup(["run", "--command", "review", "--file=notes.md", "--file=mock.png"]), id, "/project", "component")
  expect(submission).toEqual({ type: "commands.execute", sessionId: id, name: "review", args: "component", contextText: "\n\n[notes.md]\nrequirements", attachments: [blob] })
  expect(h.sent[0]).toEqual({ type: "attachment.paste", path: "/project/notes.md", allowDirectory: true })
})

test("ACP omitted cwd uses startup project, explicit editor cwd wins", async () => {
  const created: string[] = []
  const id = ids("session")
  const h = fake((command) => {
    if (command.type === "session.create") created.push(command.directory)
    return { ok: true, result: { sessionId: id } }
  })
  const agent = createAcpAgent({ client: { ...h.client, subscribe: async () => ({ ok: true }) } as Client, listen: () => {}, write: () => {}, cwd: "/startup" })
  await agent.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/new", params: { mcpServers: [] } }))
  await agent.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/editor", mcpServers: [] } }))
  expect(created).toEqual(["/startup", "/editor"])
})

test("initial-message fills the editor; prompt submits exactly once across repeated start", async () => {
  const draft = appHarness({ startup: { initialMessage: "Review the protocol\nKeep compatibility" } })
  await draft.app.start()
  expect(draft.app.editor.text).toBe("Review the protocol\nKeep compatibility")
  expect(draft.sentOf("user.submit")).toHaveLength(0)
  const prompt = appHarness({ startup: { prompt: "Review protocol" } })
  await prompt.app.start()
  await prompt.app.start()
  expect(prompt.sentOf("user.submit")).toHaveLength(1)
  expect(prompt.sentOf("user.submit")[0]).toMatchObject({ text: "Review protocol" })
  expect(prompt.app.editor.text).toBe("")
})

test("diagnostics are opt-in and never submit diagnostic text to the model", async () => {
  const h = appHarness()
  await h.type("/diag\r")
  expect(h.sentOf("user.submit")).toHaveLength(0)
  expect(h.sentOf("diagnostics.resources")).toHaveLength(0)
  await h.type("/diag")
  expect(h.text().join("\n")).not.toContain("TUI and daemon memory")
})

for (const [width, height] of [[60, 20], [100, 30], [160, 45], [180, 50], [220, 60]]) test(`diagnostics panels and keys fit ${width}x${height}`, async () => {
  const h = appHarness({ width, height, diagnostics: { memory: () => memory, snapshot: async () => "/tmp/tui.heapsnapshot" }, reply: (command) => command.type === "diagnostics.resources" ? { ok: true, result: resources } : command.type === "diagnostics.snapshot" ? { ok: true, result: { path: "/tmp/daemon.heapsnapshot" } } : undefined })
  await h.type("/diag\r")
  expect(h.text()[1]).toContain("esc")
  expect(h.text().slice(2).join("\n")).not.toContain("esc back")
  expect(h.text().join("\n")).toContain("Diagnostics")
  expect(h.text().join("\n")).toContain("TUI memory")
  expect(h.frames.at(-1)).toHaveLength(height)
  expect(h.text().every((row) => textWidth(row) <= width && !row.includes("\x1b"))).toBe(true)
  await h.app.onKey("r")
  expect(h.sentOf("diagnostics.resources")).toHaveLength(2)
  await h.app.onKey("s")
  expect(h.sentOf("diagnostics.snapshot")).toHaveLength(1)
  for (let page = 0; page < 8 && !h.text().join("\n").includes("Heap snapshots"); page++) {
    await h.app.onKey("\x1b[6~")
    h.app.render()
  }
  h.app.render()
  expect(h.text().join("\n")).toContain("Heap snapshots")
  await h.app.onKey("\x1b")
  expect(h.app.page).toBe("chat")
})

test("read-only diagnostics refuses both snapshots before touching the filesystem", async () => {
  let captured = false
  const h = appHarness({ remote: { host: "remote", readOnly: true }, diagnostics: { memory: () => memory, snapshot: async () => { captured = true; return "/tmp/no" } }, reply: () => ({ ok: true, result: resources }) })
  await h.type("/snapshot\r")
  expect(h.sentOf("diagnostics.snapshot")).toHaveLength(0)
  expect(captured).toBe(false)
})

test("heap snapshot file is private and stays under the explicit data dir", async () => {
  const dir = tempDir()
  const file = await writeSnapshot(dir, "tui", (target) => { writeFileSync(target!, "{\"snapshot\":{}}"); return target! })
  expect(file.startsWith(path.join(dir, "diagnostics", "tui-"))).toBe(true)
  expect(existsSync(file)).toBe(true)
  expect(statSync(file).mode & 0o777).toBe(0o600)
})

test("snapshot errors remain visible and a later refresh clears the error", async () => {
  const h = appHarness({ diagnostics: { memory: () => memory, snapshot: async () => "/tmp/tui.heapsnapshot" }, reply: (command) => command.type === "diagnostics.snapshot" ? { ok: false, error: { code: "internal", message: "capture failed" } } : { ok: true, result: resources } })
  await h.type("/snapshot\r")
  expect(h.text().join("\n")).toContain("capture failed")
  await h.app.onKey("r")
  h.app.render()
  expect(h.text().join("\n")).not.toContain("capture failed")
})
