import { afterEach, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { SessionId, SessionTranscript } from "@mendcode/protocol"
import type { Store } from "@mendcode/store"
import { boot, callTool, openSession, say, stop } from "./native-harness"
import { renderHtml } from "../src/session-html"
import { createStaticShare, publicMarkdown } from "../src/session-static-share"
import type { GithubProcess } from "../src/github"

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
const secret = `sk-proj-${"B".repeat(40)}`

async function session() {
  const h = await boot({ steps: [callTool("probe", {}), stop("Done <b>bold</b>\n```ts\nconst a = 1 < 2\n```")] })
  cleanup.push(h.cleanup)
  const id = await openSession(h)
  await say(h, id, `hello <script>alert(1)</script> ${secret}`)
  return { h, id }
}

test("HTML export is one self-contained page: escaped text, fenced code, CSS-only tool toggle, no script or external resource", async () => {
  const { h, id } = await session()
  const exported = await h.client.exportSession(id, { format: "html" })
  if (!exported.ok) throw new Error(exported.error.message)
  const html = exported.export.text
  expect(exported.export).toMatchObject({ format: "html", truncated: false })
  expect(html.startsWith("<!doctype html>")).toBe(true)
  expect(html).toContain("Content-Security-Policy")
  expect(html).toContain("default-src 'none'")
  expect(html).toContain("hello &lt;script&gt;alert(1)&lt;/script&gt;")
  expect(html).toContain("Done &lt;b&gt;bold&lt;/b&gt;")
  expect(html).toContain("<pre><code>const a = 1 &lt; 2</code></pre>")
  expect(html).not.toContain("<script")
  expect(html).not.toMatch(/(?:src|href)=|url\(|@import/)
  expect(html).not.toContain(secret)
  expect(html).toContain('<label for="tools">Tool details</label>')
  expect(html).toMatch(/<div class="tool-body">.*probed/s)
  expect(html).toContain("#tools:checked~main .tool-body{display:block}")
  expect(html).not.toContain('<label for="thinking">')
  const noTools = await h.client.exportSession(id, { format: "html", toolDetails: false })
  if (!noTools.ok) throw new Error(noTools.error.message)
  expect(noTools.export.text).not.toContain("tool-body\">")
  expect(noTools.export.text).not.toContain('<label for="tools">')
  expect(noTools.export.text).toContain("<code>probe</code>")
})

test("sanitized HTML export carries no transcript content or directory", async () => {
  const { h, id } = await session()
  const exported = await h.client.exportSession(id, { format: "html", sanitize: true })
  if (!exported.ok) throw new Error(exported.error.message)
  for (const text of ["hello", "Done", "probed", h.project]) expect(exported.export.text).not.toContain(text)
  expect(exported.export.text).toContain("[redacted:")
})

test("renderHtml escapes titles, attributes and failure messages", () => {
  const html = renderHtml({ title: `"><img src=x onerror=alert(1)>`, directory: "<dir>", turns: [{ turnId: "t", at: 1, outcome: "failed", error: { code: "<c>", message: "<m>" }, items: [{ itemId: "i", kind: "user_message", text: "a", attachments: [{ name: "<n>.png", mime: "image/png", bytes: 1 }] }] }], truncated: true, exportedAt: 0 })
  expect(html).not.toContain("<img")
  expect(html).toContain("&lt;n&gt;.png")
  expect(html).toContain("Turn failed (&lt;c&gt;): &lt;m&gt;")
  expect(html).toContain("Export truncated")
})

test("local share writes a private public-data page under the data directory; status, remove and session delete clean it up", async () => {
  const { h, id } = await session()
  const created = await h.client.staticShare(id, "local", "create")
  if (!created.ok) throw new Error(created.error.message)
  expect(created.share).toMatchObject({ target: "local", shared: true, turns: 1 })
  const file = created.share.path!
  expect(path.dirname(file)).toBe(path.join(h.dir, "shares"))
  expect(fileURLToPath(created.share.url!)).toBe(file)
  expect(statSync(file).mode & 0o777).toBe(0o600)
  expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700)
  const html = readFileSync(file, "utf8")
  expect(html).toContain("Done &lt;b&gt;bold&lt;/b&gt;")
  for (const hidden of ["probed", "probe", h.project, secret, "Tool"]) expect(html).not.toContain(hidden)
  expect(await h.client.staticShare(id, "local", "status")).toMatchObject({ ok: true, share: { shared: true, url: created.share.url } })
  const removed = await h.client.staticShare(id, "local", "remove")
  expect(removed).toMatchObject({ ok: true, share: { shared: false } })
  expect(existsSync(file)).toBe(false)
  const again = await h.client.staticShare(id, "local", "create")
  if (!again.ok) throw new Error(again.error.message)
  expect(existsSync(again.share.path!)).toBe(true)
  expect(await h.client.send({ type: "session.delete", sessionId: id })).toMatchObject({ ok: true })
  expect(existsSync(again.share.path!)).toBe(false)
  expect(await h.client.staticShare(id, "local", "create")).toMatchObject({ ok: false })
  expect(readdirSync(path.join(h.dir, "shares")).filter((name) => name.endsWith(".html"))).toEqual([])
})

function fixtureTranscript(): SessionTranscript {
  return { format: "mendcode-session@1", sessionId: "s1", title: `Plan ${secret}`, directory: "/private/project", exportedAt: 5, truncated: false, turns: [{ turnId: "t", at: 1, outcome: "completed", items: [
    { itemId: "1", kind: "user_message", text: "Please read /private/project/x", at: 1 },
    { itemId: "2", kind: "reasoning", text: "secret thoughts" },
    { itemId: "3", kind: "tool_call", text: "tool output", tool: "read", input: "{}" },
    { itemId: "4", kind: "agent_message", text: `Done ${secret}`, at: 2 },
    { itemId: "5", kind: "user_message", text: "!ls", source: "shell" },
  ] }] }
}

function gistFixture(gh: GithubProcess) {
  const dir = mkdtempSync(path.join(tmpdir(), "mend-gist-"))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const store = { hasSession: () => true } as unknown as Store
  const history = { export: () => ({ ok: true, result: { format: "json", text: JSON.stringify(fixtureTranscript()), turns: 1, truncated: false } }) } as never
  return { dir, share: createStaticShare({ dir, store, history, gh, now: () => 77 }) }
}
const sid = "ses_01TESTTESTTESTTESTTESTTEST" as SessionId

test("gist share needs confirmation, uploads only public Markdown as a secret gist through gh with an argument array, and records the link", async () => {
  const calls: Array<{ argv: string[]; stdin?: string | undefined }> = []
  const gh: GithubProcess = async ({ argv, stdin }) => { calls.push({ argv, stdin }); return { code: 0, out: argv[2] === "create" ? "Creating gist...\nhttps://gist.github.com/someone/0123456789abcdef0123456789abcdef" : "" } }
  const { dir, share } = gistFixture(gh)
  await expect(share.handle({ sessionId: sid, target: "gist", action: "create" })).rejects.toThrow("confirmation")
  expect(calls).toHaveLength(0)
  const created = await share.handle({ sessionId: sid, target: "gist", action: "create", confirm: true })
  expect(created).toMatchObject({ target: "gist", shared: true, url: "https://gist.github.com/someone/0123456789abcdef0123456789abcdef", id: "0123456789abcdef0123456789abcdef", at: 77, turns: 1 })
  expect(calls).toHaveLength(1)
  // `gh gist create` has no `--secret` flag (unknown flag, exit 1); a gist is secret unless `--public` is passed.
  expect(calls[0]!.argv).toEqual(["gh", "gist", "create", "--filename", `${sid}.md`, "--desc", expect.stringContaining("Plan"), "-"])
  expect(calls[0]!.argv).not.toContain("--public")
  const body = calls[0]!.stdin!
  expect(body).toContain("## User\n\nPlease read /private/project/x")
  expect(body).toContain("## Assistant")
  for (const hidden of ["secret thoughts", "tool output", "!ls", secret]) expect(body).not.toContain(hidden)
  expect(calls[0]!.argv.join(" ")).not.toContain(secret)
  await expect(share.handle({ sessionId: sid, target: "gist", action: "create", confirm: true })).rejects.toThrow("already has a gist")
  expect(statSync(path.join(dir, "shares", "static-shares.json")).mode & 0o777).toBe(0o600)
  const reloaded = createStaticShare({ dir, store: { hasSession: () => true } as unknown as Store, history: {} as never, gh })
  expect(await reloaded.handle({ sessionId: sid, target: "gist", action: "status" })).toMatchObject({ shared: true, id: "0123456789abcdef0123456789abcdef" })
  expect(await share.handle({ sessionId: sid, target: "gist", action: "remove" })).toMatchObject({ shared: false })
  expect(calls[1]!.argv).toEqual(["gh", "gist", "delete", "0123456789abcdef0123456789abcdef", "--yes"])
})

test("a failing or unexpected gh run leaves no record and says nothing about the output", async () => {
  const failing = gistFixture(async () => ({ code: 1, out: `token ${secret}` }))
  const error = await failing.share.handle({ sessionId: sid, target: "gist", action: "create", confirm: true }).catch((caught: Error) => caught)
  expect((error as Error).message).toContain("gh gist failed")
  expect((error as Error).message).not.toContain(secret)
  expect(await failing.share.handle({ sessionId: sid, target: "gist", action: "status" })).toMatchObject({ shared: false })
  const odd = gistFixture(async () => ({ code: 0, out: "https://evil.example/gist/abc" }))
  await expect(odd.share.handle({ sessionId: sid, target: "gist", action: "create", confirm: true })).rejects.toThrow("did not return a gist link")
  expect(await odd.share.handle({ sessionId: sid, target: "gist", action: "status" })).toMatchObject({ shared: false })
})

test("publicMarkdown keeps only the conversation", () => {
  expect(publicMarkdown({ title: " T ", truncated: true, turns: [{ turnId: "t", at: 1, outcome: "completed", items: [{ itemId: "a", kind: "user_message", text: "q" }, { itemId: "b", kind: "agent_message", text: "a" }] }] })).toBe("# T\n\n## User\n\nq\n\n## Assistant\n\na\n\n> Transcript truncated.\n")
})
