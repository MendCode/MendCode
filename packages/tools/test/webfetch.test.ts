import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { BUILTIN_TOOLS, WEBFETCH_ALLOW_PRIVATE_ENV, htmlToMarkdown, htmlToText, webfetch } from "../src"
import { isPrivateAddress } from "../src/tools/webfetch"
import { makeContext } from "./helpers"

const html = (body: string) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } })

let hops = 0
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    switch (url.pathname) {
      case "/page":
        return html(
          `<html><head><title>Hi &amp; bye</title><style>x{}</style></head><body><nav>menu</nav><h1>Head</h1><p>Some <a href="/rel?x=1">link</a> and <a href="javascript:alert(1)">bad</a>.</p></body></html>`,
        )
      case "/json":
        return Response.json({ a: 1, b: [2, 3] })
      case "/text":
        return new Response("plain  text\n", { headers: { "content-type": "text/plain" } })
      case "/png":
        return new Response(new Uint8Array(10), { headers: { "content-type": "image/png" } })
      case "/big":
        return new Response("a".repeat(6 * 1024 * 1024), { headers: { "content-type": "text/plain" } })
      case "/slow":
        await Bun.sleep(3000)
        return new Response("late")
      case "/missing":
        return new Response("nope", { status: 404, headers: { "content-type": "text/plain" } })
      case "/loop":
        return new Response(null, { status: 302, headers: { location: "/loop" } })
      case "/r1":
        return new Response(null, { status: 301, headers: { location: "/r2" } })
      case "/r2":
        return new Response(null, { status: 302, headers: { location: "/text" } })
      case "/to-other":
        return new Response(null, { status: 302, headers: { location: url.searchParams.get("to") ?? "/" } })
      case "/ua":
        return new Response(`${req.headers.get("user-agent")}|${req.headers.get("cookie")}`, { headers: { "content-type": "text/plain" } })
      default:
        hops++
        return new Response("not found", { status: 404 })
    }
  },
})
const other = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("secret", { headers: { "content-type": "text/plain" } }) })
const base = `http://127.0.0.1:${server.port}`
const previous = process.env[WEBFETCH_ALLOW_PRIVATE_ENV]

beforeAll(() => {
  process.env[WEBFETCH_ALLOW_PRIVATE_ENV] = "1"
})
afterEach(() => {
  process.env[WEBFETCH_ALLOW_PRIVATE_ENV] = "1"
})
afterAll(() => {
  server.stop(true)
  other.stop(true)
  if (previous === undefined) delete process.env[WEBFETCH_ALLOW_PRIVATE_ENV]
  else process.env[WEBFETCH_ALLOW_PRIVATE_ENV] = previous
})

const ctx = () => makeContext({ cwd: "/" })
const fetchUrl = (url: string, extra: { format?: "markdown" | "text" | "raw"; timeoutMs?: number } = {}, context = ctx()) =>
  webfetch.execute({ url, ...extra }, context)

describe("webfetch tool", () => {
  test("is registered as a read tool", () => {
    expect(BUILTIN_TOOLS.some((t) => t.name === "webfetch")).toBe(true)
    expect(webfetch.permission).toBe("read")
  })
  test("converts html to markdown with title, links resolved and unsafe links dropped", async () => {
    const result = await fetchUrl(`${base}/page`)
    expect(result.isError).toBe(false)
    expect(result.output).toBe(`# Hi & bye\n\n# Head\n\nSome [link](${base}/rel?x=1) and bad.`)
    expect(result.meta).toMatchObject({ status: 200, contentType: "text/html", finalUrl: `${base}/page` })
    expect(result.title).toBe(`fetch 127.0.0.1:${server.port}/page`)
  })
  test("text format strips markdown; raw returns the source", async () => {
    const text = await fetchUrl(`${base}/page`, { format: "text" })
    expect(text.output).toBe("Hi & bye\n\nHead\n\nSome link and bad.")
    const raw = await fetchUrl(`${base}/page`, { format: "raw" })
    expect(raw.output).toContain("<nav>menu</nav>")
  })
  test("pretty-prints json and passes text through", async () => {
    expect((await fetchUrl(`${base}/json`)).output).toBe(JSON.stringify({ a: 1, b: [2, 3] }, null, 2))
    expect((await fetchUrl(`${base}/text`)).output).toBe("plain  text\n")
  })
  test("unsupported content types are errors with the size", async () => {
    const result = await fetchUrl(`${base}/png`)
    expect(result.isError).toBe(true)
    expect(result.output).toBe("unsupported content type: image/png (10 bytes)")
  })
  test("reads at most 5 MB and says so", async () => {
    const result = await fetchUrl(`${base}/big`)
    expect(result.meta?.bytes).toBe(5 * 1024 * 1024)
    expect(result.truncated).toBe(true)
    expect(result.output).toContain("[body truncated at")
  })
  test("non-2xx is an error carrying the status", async () => {
    const result = await fetchUrl(`${base}/missing`)
    expect(result.isError).toBe(true)
    expect(result.output).toContain("HTTP 404")
    expect(result.meta?.status).toBe(404)
  })
  test("sends the user agent and no cookies; follows redirects", async () => {
    expect((await fetchUrl(`${base}/ua`)).output).toBe("MendCode/2 (+terminal coding agent)|null")
    const redirected = await fetchUrl(`${base}/r1`)
    expect(redirected.output).toBe("plain  text\n")
    expect(redirected.meta?.finalUrl).toBe(`${base}/text`)
  })
  test("redirect loops stop after 5 hops", async () => {
    const result = await fetchUrl(`${base}/loop`)
    expect(result.isError).toBe(true)
    expect(result.output).toContain("too many redirects")
  })
  test("times out", async () => {
    const started = Date.now()
    const result = await fetchUrl(`${base}/slow`, { timeoutMs: 200 })
    expect(Date.now() - started).toBeLessThan(2000)
    expect(result.isError).toBe(true)
    expect(result.output).toContain("timed out")
  })
  test("cancels", async () => {
    const controller = new AbortController()
    const started = Date.now()
    const pending = fetchUrl(`${base}/slow`, {}, makeContext({ cwd: "/", signal: controller.signal }))
    setTimeout(() => controller.abort(), 100)
    const result = await pending
    expect(Date.now() - started).toBeLessThan(2000)
    expect(result.output).toBe("cancelled")
  })
  test("rejects bad schemes and invalid urls", async () => {
    expect((await fetchUrl("file:///etc/passwd")).output).toContain("unsupported scheme")
    expect((await fetchUrl("ftp://example.com/x")).isError).toBe(true)
    expect((await fetchUrl("not a url")).output).toContain("invalid URL")
  })
})

describe("private address guard", () => {
  test("blocks localhost, loopback, private and link-local hosts", async () => {
    delete process.env[WEBFETCH_ALLOW_PRIVATE_ENV]
    for (const url of [
      `http://localhost:${server.port}/page`,
      `http://127.0.0.1:${server.port}/page`,
      "http://[::1]/",
      "http://10.1.2.3/",
      "http://172.20.0.1/",
      "http://192.168.1.1/",
      "http://169.254.169.254/latest/meta-data",
      "http://[fe80::1]/",
      "http://[fd00::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://2130706433/",
    ]) {
      const result = await fetchUrl(url)
      expect(result.isError, url).toBe(true)
      expect(result.output, url).toContain("private address")
    }
  })
  test("blocks a redirect that lands on a private host", async () => {
    process.env[WEBFETCH_ALLOW_PRIVATE_ENV] = `127.0.0.1:${server.port}`
    const result = await fetchUrl(`${base}/to-other?to=${encodeURIComponent(`http://127.0.0.1:${other.port}/`)}`)
    expect(result.isError).toBe(true)
    expect(result.output).toContain("private address")
    expect(result.output).not.toContain("secret")
  })
  test("classifies addresses", () => {
    expect(isPrivateAddress("8.8.8.8")).toBe(false)
    expect(isPrivateAddress("172.32.0.1")).toBe(false)
    expect(isPrivateAddress("2606:4700::1111")).toBe(false)
    expect(isPrivateAddress("172.16.0.1")).toBe(true)
    expect(isPrivateAddress("::1")).toBe(true)
    expect(isPrivateAddress("::ffff:7f00:1")).toBe(true)
  })
})

describe("html conversion", () => {
  const md = (body: string) => htmlToMarkdown({ html: body, baseUrl: "https://example.com/dir/page" })
  test("headings, paragraphs and line breaks", () => {
    expect(md("<h1>A</h1><h3>B</h3><p>one<br>two</p><div>x</div><div>y</div>")).toBe("# A\n\n### B\n\none\ntwo\n\nx\ny")
  })
  test("lists, ordered and nested", () => {
    expect(md("<ul><li>a</li><li>b<ol><li>c</li><li>d</li></ol></li></ul>")).toBe("- a\n- b\n  1. c\n  2. d")
  })
  test("links resolve against the page url", () => {
    expect(md('<a href="../up">u</a> <a href="//cdn.x/y">c</a> <a href="#top">t</a> <a href="https://z.io">z</a>')).toBe(
      "[u](https://example.com/up) [c](https://cdn.x/y) t [z](https://z.io/)",
    )
  })
  test("entities: named, decimal, hex, invalid", () => {
    expect(md("<p>&lt;a&gt; &amp;amp; &copy; &#65;&#x42; &#0; &unknown; &hellip;</p>")).toBe("<a> &amp; © AB � &unknown; …")
  })
  test("tables and pre/code", () => {
    expect(md("<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>x|y</td></tr></table>")).toBe(
      "| a | b |\n| --- | --- |\n| 1 | x\\|y |",
    )
    expect(md("<p>use <code>npm i</code></p><pre>l1\n  l2</pre>")).toBe("use `npm i`\n\n```\nl1\n  l2\n```")
  })
  test("drops script, style, noscript, svg, nav, footer, iframe and comments", () => {
    expect(
      md("<script>var a='<p>no</p>'</script><style>p{}</style><!-- c --><svg><text>s</text></svg><nav>n</nav><footer>f</footer><iframe>i</iframe><noscript>ns</noscript><p>kept</p>"),
    ).toBe("kept")
  })
  describe("main content", () => {
    const prose = "The request body is JSON. ".repeat(12).trim()
    const chrome = `<a href="#content">Skip to main content</a><header><div class="menu"><a href="/">Docs home</a><a href="/api">API reference</a><button>Search...</button><select><option>English</option><option>Deutsch</option><option>日本語</option></select></div></header>`
    const sidebar = `<aside><ul><li><a href="/a">Getting started</a></li><li><a href="/b">Authentication</a></li></ul></aside>`
    const tail = `<div class="feedback">Was this page helpful?</div><footer>© Example</footer><dialog><p>Search the docs</p></dialog>`
    const page = (content: string) => `<html><head><title>Messages API</title></head><body>${chrome}${sidebar}${content}${tail}</body></html>`
    const expected = `# Messages API\n\n## Create a message\n\n${prose}\n\n\`\`\`\ncurl https://api.example.com/v1/messages\n\`\`\``
    const content = `<h2>Create a message</h2><p>${prose}</p><pre>curl https://api.example.com/v1/messages</pre>`
    test("a page with <main> is its main content: the skip link, menus, search box, language list and sidebar are gone", () => {
      const out = md(page(`<main id="content">${content}</main>`))
      expect(out).toBe(expected)
      for (const noise of ["Skip to main content", "Docs home", "Search...", "Deutsch", "Getting started", "helpful", "Search the docs"]) expect(out).not.toContain(noise)
    })
    test('role="main" and a single <article> mark the content too', () => {
      expect(md(page(`<div class="x" role="main">${content}</div>`))).toBe(`${expected}\n\nWas this page helpful?`)
      expect(md(page(`<ARTICLE>${content}</ARTICLE>`))).toBe(expected)
    })
    test("an empty or tiny <main>, several articles, or no marker at all keep the whole document", () => {
      expect(md(page(`<main><p>Loading</p></main><div>${content}</div>`))).toContain("Docs home")
      expect(md(page(`<main><p>Loading</p></main><div>${content}</div>`))).toContain("Create a message")
      const two = md(page(`<article><h2>First post</h2><p>${prose}</p></article><article><h2>Second post</h2><p>${prose}</p></article>`))
      expect(two).toContain("First post")
      expect(two).toContain("Second post")
      expect(md(page(`<div>${content}</div>`))).toContain("Skip to main content")
      // A language list and a closed dialog are never content, wherever they stand.
      expect(md(page(`<div>${content}</div>`))).not.toContain("Deutsch")
      expect(md(page(`<div>${content}</div>`))).not.toContain("Search the docs")
    })
    test("the text format takes the main content too, and a marker inside a script is not one", () => {
      expect(htmlToText({ html: page(`<main>${content}</main>`), baseUrl: "https://e.com/" })).toBe(`Messages API\n\nCreate a message\n\n${prose}\n\ncurl https://api.example.com/v1/messages`)
      const scripted = md(`<p>before</p><script>var t = '<main><p role="main">${prose}</p></main>'</script><p>${prose}</p>`)
      expect(scripted).toBe(`before\n\n${prose}`)
    })
  })
  test("text format has no markdown syntax", () => {
    const text = htmlToText({ html: "<h2>T</h2><p><a href='/x'>l</a> <code>c</code></p><pre>p</pre>", baseUrl: "https://e.com/" })
    expect(text).toBe("T\n\nl c\n\np")
  })
  test("collapses whitespace", () => {
    expect(md("<p>  a \n\n  b\t c  </p>")).toBe("a b c")
  })
  test("malformed input does not throw or hang", () => {
    expect(() => md("<div><p>unclosed <a href='x'>l <b <<>> </td></table><td>x<tr>")).not.toThrow()
    expect(md("a < b and <3")).toContain("a < b")
  })
  test("large adversarial inputs stay linear", () => {
    const size = 5 * 1024 * 1024
    const inputs = ["&".repeat(size), " ".repeat(size), "<div>".repeat(size / 5), "<a href='x'>".repeat(size / 12), "<td>".repeat(size / 4), `<p ${'a="'.repeat(size / 3)}`, "<".repeat(size)]
    for (const input of inputs) {
      const started = performance.now()
      md(input)
      expect(performance.now() - started, input.slice(0, 12)).toBeLessThan(3000)
    }
  })
})
