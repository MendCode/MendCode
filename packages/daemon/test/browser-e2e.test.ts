import { afterAll, beforeAll, expect, test } from "bun:test"
import type { BrowserInput, BrowserOutcome } from "@mendcode/tools"
import { findBrowserExecutable } from "../src/browser-cdp"
import { createBrowserControl } from "../src/browser"

/** Real Chromium against a loopback page. Opt-in (needs an installed browser): MENDCODE_BROWSER_E2E=1 bun test packages/daemon/test/browser-e2e.test.ts */
const executable = process.env.MENDCODE_BROWSER_E2E === "1" ? findBrowserExecutable({ explicit: process.env.MENDCODE_BROWSER_PATH }) : undefined
const live = executable ? test : test.skip

const PAGE = `<!doctype html><title>Demo form</title><body>
<h1>Welcome</h1>
<label for="name">Name</label><input id="name" type="text">
<label for="pw">Password</label><input id="pw" type="password" value="hunter2">
<select id="size" aria-label="Size"><option value="s">Small</option><option value="l">Large</option></select>
<button id="go" onclick="document.getElementById('out').textContent = 'Hello ' + document.getElementById('name').value + ' ' + document.getElementById('size').value; console.log('clicked')">Greet</button>
<a href="/next">Next page</a>
<p id="out"></p>
<script>setTimeout(() => console.error('late failure'), 50)</script>
</body>`

let server: ReturnType<typeof Bun.serve>
beforeAll(() => {
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request) => new URL(request.url).pathname === "/next" ? new Response("<title>Second</title><h1>Second page</h1>", { headers: { "content-type": "text/html" } }) : new Response(PAGE, { headers: { "content-type": "text/html" } }) })
})
afterAll(() => server?.stop(true))

live("drives a real page: navigate, snapshot, type, select, click, console, screenshot, back, close", async () => {
  const control = createBrowserControl({ enabled: true, ...(executable ? { executable } : {}) })
  try {
    const port = control.port("ses_e2e")
    const run = async (input: BrowserInput): Promise<Extract<BrowserOutcome, { ok: true }>> => {
      const outcome = await port.run(input, AbortSignal.timeout(40_000))
      if (!outcome.ok) throw new Error(outcome.error)
      return outcome
    }
    const opened = await run({ action: "navigate", url: `http://127.0.0.1:${server.port}/` })
    expect(opened.page?.title).toBe("Demo form")
    const snap = await run({ action: "snapshot" })
    expect(snap.text).toContain("Welcome")
    expect(snap.text).not.toContain("hunter2")
    const ref = (pattern: RegExp) => Number(new RegExp(`\\[(\\d+)\\] ${pattern.source}`).exec(snap.text)?.[1])
    await run({ action: "type", ref: ref(/input:text "Name"/), text: "Ada" })
    await run({ action: "type", ref: ref(/select "Size"/), text: "Large" })
    await run({ action: "click", ref: ref(/button "Greet"/) })
    expect((await run({ action: "snapshot" })).text).toContain("Hello Ada l")
    expect((await run({ action: "console" })).text).toMatch(/clicked/)
    const shot = await run({ action: "screenshot" })
    expect(shot.image?.bytes.length).toBeGreaterThan(1000)
    await run({ action: "click", ref: ref(/link "Next page"/) })
    expect((await run({ action: "snapshot" })).text).toContain("Second page")
    expect((await run({ action: "back" })).page?.title).toBe("Demo form")
    expect((await port.run({ action: "click", ref: 999 }, AbortSignal.timeout(5_000)))).toMatchObject({ ok: false })
    expect((await run({ action: "close" })).text).toContain("closed")
    expect(control.count()).toBe(0)
  } finally {
    await control.stop()
  }
}, 90_000)
