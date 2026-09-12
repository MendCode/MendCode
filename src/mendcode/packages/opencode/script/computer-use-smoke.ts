import { open, readFile, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"

const lockPath = path.join(os.tmpdir(), "mendcode-computer-use-smoke.lock")
let lock: Awaited<ReturnType<typeof open>>
try {
  lock = await open(lockPath, "wx", 0o600)
  await lock.writeFile(String(process.pid))
} catch (error) {
  const owner = await readFile(lockPath, "utf8").catch(() => "unknown")
  throw new Error(`Computer Use smoke is already running (PID ${owner.trim() || "unknown"}).`, { cause: error })
}

const page = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>MendCode Computer Use Fixture</title>
<style>
body{font:16px system-ui;max-width:680px;margin:48px auto;padding:0 24px;color:#eee;background:#0a0a0a}button,input{font:inherit;margin:8px 4px 8px 0;padding:10px 14px}.panel{border:1px solid #fab283;border-radius:10px;padding:20px}#spacer{height:500px}.status{color:#56b6c2}
</style></head>
<body><main class="panel"><h1>MendCode Computer Use Fixture</h1><p>Local deterministic surface. It performs no network requests.</p>
<button id="increment">Increment</button><button id="dialog">Open dialog</button>
<label for="name">Labelled text field</label><input id="name" autocomplete="off">
<p class="status" role="status" aria-live="polite">Count: <span id="count">0</span>; Text: <span id="text">empty</span></p>
<div id="spacer"></div><button id="scroll-target">Scroll target</button></main>
<dialog id="fixture-dialog"><p>Fixture dialog is open.</p><button id="close">Close</button></dialog>
<script>
let count=0;const q=(id)=>document.getElementById(id);q('increment').onclick=()=>q('count').textContent=String(++count);q('name').oninput=(e)=>q('text').textContent=e.target.value||'empty';q('dialog').onclick=()=>q('fixture-dialog').showModal();q('close').onclick=()=>q('fixture-dialog').close();
</script></body></html>`

const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } }) })
let closing = false
const close = async (reason: string) => {
  if (closing) return
  closing = true
  server.stop(true)
  await lock.close().catch(() => undefined)
  await rm(lockPath, { force: true }).catch(() => undefined)
  console.log(`Computer Use smoke stopped (${reason}).`)
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => void close(signal).then(() => process.exit(0)))
setTimeout(() => void close("30-minute limit").then(() => process.exit(0)), 30 * 60_000).unref()

console.log(`Computer Use fixture: http://${server.hostname}:${server.port}`)
console.log("Open the URL manually, then use a packaged MendCode Full Mode session to verify: no unsolicited halo; exact activation approval; semantic Increment/text/dialog/scroll actions; visible M halo before mutation; clean screenshot fallback; target-change rejection; and cleanup after stop/Ctrl-C.")
await new Promise(() => {})
