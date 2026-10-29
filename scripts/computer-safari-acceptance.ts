import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createIdFactory, type ComputerObservation, type ComputerSessionReport, type ComputerCodeReport } from "@mendcode/protocol"
import { openStore } from "@mendcode/store"
import { createComputerControl } from "../packages/daemon/src/computer"
import type { ToolResult } from "../packages/tools/src/tool"

// Explicit manual acceptance only. Own loopback page and isolated store; no real pages are navigated.
if (!process.argv.includes("--run")) throw new Error("Run deliberately: bun scripts/computer-safari-acceptance.ts --run (uses only a blank Safari Start Page for a local demo)")
if (process.platform !== "darwin") throw new Error("Safari acceptance requires macOS")
const token = crypto.randomUUID(), title = `MendCode Safari Demo ${token}`
const events: { kind: string; value?: string; y?: number }[] = []
const results: { step: string; verified: boolean; detail?: string }[] = []
const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:18px system-ui;margin:0;background:#f4f7f6;color:#162521}main{max-width:700px;margin:40px auto;padding:24px}input,button{font:inherit;padding:12px;margin:8px 8px 16px 0}button{cursor:pointer}label{display:block}#space{height:1600px}footer{padding:30px;background:#d0e9df}h1{font-size:28px}</style></head>
<body><main><h1>MendCode native Safari acceptance</h1><p>Temporary local demo only. No account, external network, clipboard or downloads.</p>
<label for="demo-text">MendCode demo text</label><input id="demo-text" aria-label="MendCode demo text" autocomplete="off" spellcheck="false">
<div><button aria-label="MendCode demo pointer" id="pointer">Pointer click</button><button aria-label="MendCode demo semantic" id="semantic">Semantic press</button></div>
<p id="result" aria-live="polite">Waiting for native input</p>
<label for="secure">Demo secure field — must not be controlled</label><input id="secure" type="password" aria-label="MendCode demo secure" value="DEMO_ONLY_SECRET">
<div id="space"><p>Scroll test area</p></div><footer>End of local demo</footer></main>
<script>
const text=document.getElementById('demo-text');
const event=(kind,extra={})=>fetch('/${token}/event',{method:'POST',keepalive:true,headers:{'Content-Type':'application/json'},body:JSON.stringify({kind,...extra})});
addEventListener('pagehide',()=>event('closed'));
text.addEventListener('input',()=>event('input',{value:text.value}));
for(const kind of ['pointer','semantic'])document.getElementById(kind).addEventListener('click',()=>{document.getElementById('result').textContent='MendCode demo '+kind+' confirmed';event(kind,{value:text.value})});
addEventListener('scroll',()=>event('scroll',{y:scrollY}));
event('loaded');
</script></body></html>`
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const url = new URL(request.url)
  if (url.pathname === `/${token}/`) return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } })
  if (url.pathname === `/${token}/event` && request.method === "POST") {
    const event = await request.json() as { kind: string; value?: string; y?: number }
    if (["loaded", "input", "pointer", "semantic", "scroll", "closed"].includes(event.kind)) events.push(event)
    return new Response("ok")
  }
  return new Response("Not found", { status: 404 })
} })
const url = `http://127.0.0.1:${server.port}/${token}/`
const dir = await mkdtemp(path.join(tmpdir(), "mend-safari-acceptance-"))
const store = openStore({ dir }), ids = createIdFactory(), sessionId = ids("session")
store.createSession({ id: sessionId, directory: dir, title: "Isolated Safari native acceptance" })
const computer = createComputerControl(store, dir, { enabled: true }), port = computer.port(sessionId)
let ownWindowID: string | undefined, computerSessionID: string | undefined
const deadline = AbortSignal.timeout(120000)
function parsed<T>(result: ToolResult): T {
  if (result.isError) throw new Error(result.output)
  return JSON.parse(result.output) as T
}
async function code(source: string) {
  const report = parsed<ComputerCodeReport>(await port.code!({ computerSessionID: computerSessionID!, code: source }, deadline))
  if (!report.ok) throw new Error(report.error?.message ?? "Computer program failed")
  return report.value
}
async function observe() {
  const view = parsed<ComputerObservation>(await port.observe!({ computerSessionID: computerSessionID! }, deadline))
  if (!view.target.windowName?.includes(title)) throw new Error("Refusing input: selected Safari window is not our demo")
  return view
}
async function waitEvent(kind: string, predicate: (event: typeof events[number]) => boolean = () => true) {
  for (let i = 0; i < 40; i++) {
    if (events.some((event) => event.kind === kind && predicate(event))) return true
    deadline.throwIfAborted(); await Bun.sleep(100)
  }
  return false
}
async function record(step: string, verified: boolean, detail?: string) {
  results.push({ step, verified, ...(detail ? { detail } : {}) })
  console.log(JSON.stringify(results.at(-1)))
  if (!verified) throw new Error(`Postcondition not verified: ${step}. No automatic input retry.`)
}
try {
  const session = parsed<ComputerSessionReport>(await port.session!({ action: "start", mode: "control", bundleID: "com.apple.Safari" }, deadline, {
    sourceId: "manual-safari-acceptance", text: "User explicitly requested testing computer use in Safari on an isolated local demo window", approve: async (target, mode) => target.bundleID === "com.apple.Safari" && mode === "control",
  }))
  computerSessionID = session.computerSessionID
  // Reuse only a blank Start Page left by this manual acceptance, never navigate a real page.
  const blankNames = ["Start Page", "Página de inicio", "Untitled", "Sin título"]
  if (!session.target?.windowID || !blankNames.includes(session.target.windowName ?? "") && !/^MendCode Safari Demo [0-9a-f-]{36}$/.test(session.target.windowName ?? "")) throw new Error("Focused Safari window is not a disposable Start Page or our previous local demo; refusing navigation and not opening another window")
  ownWindowID = session.target.windowID
  await code(`let o = await tools.observe({}); const root = o.nodes.find(n => n.role === 'AXWindow' && n.actions.includes('key')); if (!root) throw 'No new-window keyboard target'; await tools.key({revision:o.revision,nodeID:root.id,key:'l',modifiers:['command']}); o = await tools.observe({}); const address = o.nodes.find(n => n.states.includes('focused') && n.actions.includes('typeText')); if (!address) throw 'No focused Safari address field'; await tools.typeText({revision:o.revision,nodeID:address.id,value:${JSON.stringify(url)}}); o = await tools.observe({}); const filled = o.nodes.find(n => n.states.includes('focused') && n.value && n.value.includes(${JSON.stringify(token)}) && n.actions.includes('key')); if (!filled) throw 'Demo address was not verified'; await tools.key({revision:o.revision,nodeID:filled.id,key:'enter'}); return null`)
  await record("local demo loaded", await waitEvent("loaded"))
  const initial = await observe()
  // Log only demo matches/roles; never dump personal Safari toolbar/bookmark contents.
  const own = initial.nodes.filter((node) => node.name.startsWith("MendCode demo"))
  console.log(JSON.stringify({ step: "native snapshot", nodeCount: initial.nodes.length, truncated: initial.truncated, demoNodes: own.map((node) => ({ role: node.role, name: node.name, actions: node.actions })) }))
  await record("secure field redacted", initial.nodes.some((node) => node.secure && !node.name && node.value === undefined && node.actions.length === 0) && !JSON.stringify(initial).includes("DEMO_ONLY_SECRET"))
  await code(`const o = await tools.observe({}); const n = o.nodes.find(n => n.name === 'MendCode demo text' && n.actions.includes('setValue')); if (!n) throw 'No demo text field with setValue'; await tools.setValue({revision:o.revision,nodeID:n.id,value:'MendCode initial'}); return null`)
  await record("AX setValue", (await observe()).nodes.some((node) => node.name === "MendCode demo text" && node.value === "MendCode initial"))
  await code(`let o = await tools.observe({}); let n = o.nodes.find(n => n.name === 'MendCode demo text' && n.actions.includes('key')); if (!n) throw 'No demo keyboard target'; await tools.key({revision:o.revision,nodeID:n.id,key:'a',modifiers:['command']}); o = await tools.observe({}); n = o.nodes.find(n => n.name === 'MendCode demo text' && n.actions.includes('typeText')); if (!n) throw 'No demo typing target'; await tools.typeText({revision:o.revision,nodeID:n.id,value:'MendCode Safari ✓😀'}); return null`)
  await record("native Unicode typing", (await observe()).nodes.some((node) => node.name === "MendCode demo text" && node.value === "MendCode Safari ✓😀"))
  await code(`const o = await tools.observe({}); const n = o.nodes.find(n => n.name === 'MendCode demo pointer' && n.actions.includes('click')); if (!n) throw 'No demo pointer button'; return await tools.click({revision:o.revision,nodeID:n.id})`)
  await record("physical pointer click", await waitEvent("pointer", (event) => event.value === "MendCode Safari ✓😀"))
  await code(`const o = await tools.observe({}); const n = o.nodes.find(n => n.name === 'MendCode demo semantic' && n.actions.includes('press')); if (!n) throw 'No demo AXPress button'; return await tools.press({revision:o.revision,nodeID:n.id})`)
  await record("semantic AXPress", await waitEvent("semantic", (event) => event.value === "MendCode Safari ✓😀"))
  await code(`const o = await tools.observe({}); const n = o.nodes.find(n => n.role === 'AXScrollArea' && n.actions.includes('scroll') && n.bounds && n.bounds.height > 200); if (!n) throw 'No demo scroll area'; return await tools.scroll({revision:o.revision,nodeID:n.id,direction:'down',amount:400})`)
  await record("physical scroll", await waitEvent("scroll", (event) => (event.y ?? 0) > 0))
  const audit = await code("return await tools.status({})") as { audit?: { action: string; result: string }[] }
  console.log(JSON.stringify({ step: "value-free audit", audit: audit.audit }))
} catch (error) {
  process.exitCode = 1
  console.error(JSON.stringify({ failed: error instanceof Error ? error.message : String(error), results }))
} finally {
  if (ownWindowID && computerSessionID) {
    try {
      const own = await observe()
      if (own.target.windowID !== ownWindowID) throw new Error("Demo window identity changed; leaving it untouched")
      await code("const o = await tools.observe({}); const root = o.nodes.find(n => n.role === 'AXWindow' && n.actions.includes('key')); if (!root) throw 'No demo close target'; return await tools.key({revision:o.revision,nodeID:root.id,key:'w',modifiers:['command']})")
      console.log(JSON.stringify({ cleanup: await waitEvent("closed") ? "closed only the demo window" : "close dispatched; pagehide not confirmed" }))
    } catch (error) { console.error(JSON.stringify({ cleanupError: String(error), note: "Window left untouched rather than risk closing another window" })); process.exitCode = 1 }
  }
  if (computerSessionID) await port.session!({ action: "stop", computerSessionID }, new AbortController().signal).catch(() => {})
  computer.stop(); store.close()
  server.stop(true)
  await Bun.sleep(2100)
  await rm(dir, { recursive: true, force: true })
}
