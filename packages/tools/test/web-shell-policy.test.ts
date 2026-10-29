import { describe, expect, test } from "bun:test"
import { applyShellEnvironment, createWebSearchTool, domainAllowed, runTool, shellArgv, type FetchLike } from "../src"
import webfetch from "../src/tools/webfetch"
import { makeContext } from "./helpers"

const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } })

describe("web domain rules", () => {
  test("a block wins, an allow list admits only listed domains and their subdomains, entries may be written loosely", () => {
    expect(domainAllowed("docs.example.com", undefined)).toEqual({ ok: true })
    expect(domainAllowed("docs.example.com", { blockDomains: ["Example.com"] })).toMatchObject({ ok: false })
    expect(domainAllowed("notexample.com", { blockDomains: ["example.com"] })).toEqual({ ok: true })
    expect(domainAllowed("a.b.dev", { allowDomains: ["https://b.dev/docs", "*.other.org"] })).toEqual({ ok: true })
    expect(domainAllowed("x.other.org", { allowDomains: ["https://b.dev/docs", "*.other.org"] })).toEqual({ ok: true })
    expect(domainAllowed("evil.com", { allowDomains: ["b.dev"] })).toMatchObject({ ok: false })
    expect(domainAllowed("a.b.dev", { allowDomains: ["b.dev"], blockDomains: [".a.b.dev"] })).toMatchObject({ ok: false })
  })

  test("webfetch refuses a blocked or unlisted host before any request", async () => {
    const context = { ...makeContext({ cwd: "/tmp" }), web: { blockDomains: ["example.com"] } }
    const blocked = await runTool(webfetch, { url: "https://www.example.com/page" }, context)
    expect(blocked.isError).toBe(true)
    expect(blocked.output).toContain("blocked by the web domain rules")
    const unlisted = await runTool(webfetch, { url: "https://other.dev/" }, { ...context, web: { allowDomains: ["example.com"] } })
    expect(unlisted.output).toContain("not in the web domain allow list")
  })

  test("websearch passes domain and recency to providers that support them, and filters every result", async () => {
    const calls: Array<{ url: string; body: any }> = []
    const fetch: FetchLike = async (url, init) => {
      calls.push({ url, body: typeof init.body === "string" ? JSON.parse(init.body) : undefined })
      return json({ results: [{ title: "ok", url: "https://good.dev/a", content: "x" }, { title: "bad", url: "https://www.bad.com/b", content: "y" }] })
    }
    const tool = createWebSearchTool({ env: { TAVILY_API_KEY: "t" }, fetch })!
    const result = await runTool(tool, { query: "q", recency: "week" }, { ...makeContext({ cwd: "/tmp" }), web: { blockDomains: ["bad.com"], allowDomains: ["good.dev", "bad.com"] } })
    expect(calls[0]!.body).toMatchObject({ include_domains: ["good.dev", "bad.com"], exclude_domains: ["bad.com"], time_range: "week" })
    expect(result.output).toContain("https://good.dev/a")
    expect(result.output).not.toContain("bad.com")
    expect(result.meta).toEqual({ provider: "tavily", results: 1 })
  })

  test("websearch maps recency for Brave and Exa and adds exclusions as -site", async () => {
    const urls: string[] = []
    const bodies: any[] = []
    const fetch: FetchLike = async (url, init) => {
      urls.push(url)
      bodies.push(typeof init.body === "string" ? JSON.parse(init.body) : undefined)
      return json({ web: { results: [] }, results: [] })
    }
    await runTool(createWebSearchTool({ env: { BRAVE_API_KEY: "b" }, fetch })!, { query: "hello", recency: "month" }, { ...makeContext({ cwd: "/tmp" }), web: { blockDomains: ["spam.io"] } })
    const url = new URL(urls[0]!)
    expect(url.searchParams.get("freshness")).toBe("pm")
    expect(url.searchParams.get("q")).toBe("hello -site:spam.io")
    await runTool(createWebSearchTool({ env: { EXA_API_KEY: "e" }, fetch })!, { query: "hello", recency: "day" }, makeContext({ cwd: "/tmp" }))
    expect(Date.now() - Date.parse(bodies[1].startPublishedDate)).toBeLessThan(86_400_000 + 5_000)
  })
})

describe("shell environment policy", () => {
  const base = { PATH: "/usr/bin", HOME: "/h", LANG: "C", LC_ALL: "C", OPENAI_API_KEY: "k", GITHUB_TOKEN: "t", EDITOR: "vim", Secret_Thing: "s" }

  test("no policy returns the environment unchanged", () => {
    expect(applyShellEnvironment(base, undefined)).toBe(base)
  })

  test("a policy drops credential-looking names by default; keepSecrets and set override", () => {
    const env = applyShellEnvironment(base, {})
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/h", LANG: "C", LC_ALL: "C", EDITOR: "vim" })
    expect(applyShellEnvironment(base, { keepSecrets: true }).OPENAI_API_KEY).toBe("k")
    expect(applyShellEnvironment(base, { set: { OPENAI_API_KEY: "fixed" } }).OPENAI_API_KEY).toBe("fixed")
  })

  test("core keeps the basics, none keeps only what is set, includeOnly and exclude use case-insensitive globs", () => {
    expect(Object.keys(applyShellEnvironment(base, { inherit: "core" })).sort()).toEqual(["HOME", "LANG", "LC_ALL", "PATH"])
    expect(applyShellEnvironment(base, { inherit: "none", set: { CI: "1" } })).toEqual({ CI: "1" })
    expect(Object.keys(applyShellEnvironment(base, { includeOnly: ["path", "ed*"] })).sort()).toEqual(["EDITOR", "PATH"])
    expect(applyShellEnvironment(base, { exclude: ["lc_*", "editor"] })).toEqual({ PATH: "/usr/bin", HOME: "/h", LANG: "C" })
  })
})

describe("shell prefix and login", () => {
  test("the prefix runs first in the same shell and a login shell adds -l on POSIX", () => {
    expect(shellArgv({ shell: "/bin/sh", command: "echo hi" })).toEqual(["/bin/sh", "-c", "echo hi"])
    expect(shellArgv({ shell: "/bin/zsh", command: "echo hi", policy: { prefix: "set -e", login: true } })).toEqual(["/bin/zsh", "-l", "-c", "set -e\necho hi"])
    expect(shellArgv({ shell: "pwsh", command: "ls", policy: { prefix: "$x = 1", login: true } }).at(-1)).toContain("$x = 1\nls")
  })
})
