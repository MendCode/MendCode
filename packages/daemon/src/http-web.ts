import { WEB_EDITOR_CSS, WEB_EDITOR_PANE, WEB_EDITOR_SCRIPT } from "./http-web-editor"
import { WEB_TERMINAL_CSS, WEB_TERMINAL_PANE, WEB_TERMINAL_SCRIPT } from "./http-web-terminal"
import { WEB_WORKSPACES_BAR, WEB_WORKSPACES_SCRIPT } from "./http-web-workspaces"

/** Dependency-free browser client. Content always enters through textContent, never HTML. */
export const HTTP_WEB = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>MendCode</title><style>
:root { color-scheme: dark; font: 14px/1.5 ui-monospace, monospace; background: #07110d; color: #f0f6f2; --border: #537a60; --accent: #7de8a0 }
* { box-sizing: border-box } body { margin: 0; padding: 16px; height: 100dvh; display: flex; flex-direction: column; gap: 12px }
header { display: flex; justify-content: space-between; gap: 16px; align-items: center; flex-wrap: wrap } h1,h2 { font: inherit; margin: 0; color: var(--accent) }
[hidden] { display: none !important } header label { color: #9bb8a6 } #workspace { max-width: 24ch }
main { flex: 1; min-height: 0; display: grid; grid-template-columns: 28ch minmax(0, 1fr); gap: 12px }
#panes { display: flex; flex-direction: column; gap: 12px; min-width: 0; min-height: 0 } #panes > section { flex: 1 } #tabs { display: flex; gap: 8px } #tabs button[aria-selected=true] { color: var(--accent); border-color: var(--accent) }
section,nav { border: 1px solid var(--border); padding: 16px; min-width: 0; min-height: 0 } section { display: flex; flex-direction: column; gap: 12px } nav { overflow: auto }
button,input,textarea { font: inherit; color: inherit; background: transparent; border: 1px solid var(--border); padding: 8px; min-width: 0 } button { cursor: pointer } button:hover { border-color: var(--accent) }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px } button:disabled { opacity: .5; cursor: default } button[aria-current] { color: var(--accent); border-color: var(--accent) }
#sessions button { display: block; width: 100%; text-align: left; margin-top: 8px; overflow-wrap: anywhere } #transcript { flex: 1; min-height: 0; overflow: auto; margin: 0; white-space: pre-wrap; overflow-wrap: anywhere }
form { display: flex; gap: 8px; align-items: center; flex-wrap: wrap } textarea { width: 100%; resize: vertical; min-height: 4.5em } #token { width: min(42ch,100%) } #error { color: #ffb8ad; white-space: pre-wrap; margin: 0 }
select { font: inherit; color: inherit; background: #0b1b13; border: 1px solid var(--border); padding: 8px; min-width: 0; max-width: 100%; text-overflow: ellipsis } label { color: #9bb8a6 }
#tools { gap: 8px } #tools input { flex: 1; min-width: 12ch } #requests:empty,#diff[hidden] { display: none } #requests { display: flex; flex-direction: column; gap: 8px }
.request { border: 1px solid #d7a64a; padding: 12px; display: flex; flex-direction: column; gap: 8px } .request h2 { color: #d7a64a } .request p { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 12em; overflow: auto } .request div { display: flex; gap: 8px; flex-wrap: wrap }
#diff { border: 1px solid var(--border); padding: 12px; max-height: 40vh; overflow: auto; display: flex; flex-direction: column; gap: 8px } #files { display: flex; flex-wrap: wrap; gap: 6px } #patch { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere }
::selection { background: #31583f } input,textarea { caret-color: var(--accent) } @media (max-width: 70ch) { main { grid-template-columns: minmax(0,1fr) } nav { max-height: 28vh } body { padding: 8px } section,nav { padding: 12px } }
${WEB_EDITOR_CSS}${WEB_TERMINAL_CSS}</style><header><h1>MendCode</h1>${WEB_WORKSPACES_BAR}<span>ctrl-enter send</span></header>
<form id="login"><label for="token">Token</label><input id="token" type="password" autocomplete="off" required><button>Connect</button><button id="disconnect" type="button" hidden>Disconnect</button></form>
<p id="error" role="alert"></p><main><nav aria-label="Sessions"><header><h2>Sessions</h2><button id="new" disabled>New</button></header><div id="sessions"></div></nav>
<div id="panes"><div id="tabs" role="tablist" aria-label="View"><button id="tab-chat" role="tab" type="button" aria-selected="true" aria-controls="pane-chat">Chat</button><button id="tab-files" role="tab" type="button" aria-selected="false" aria-controls="pane-files" tabindex="-1">Files</button><button id="tab-terminal" role="tab" type="button" aria-selected="false" aria-controls="pane-terminal" tabindex="-1">Terminal</button></div>
<section id="pane-chat" role="tabpanel" aria-labelledby="tab-chat" aria-label="Conversation"><header><h2 id="title">Conversation</h2><span id="state"></span></header>
<form id="tools" aria-label="Session actions"><label for="model">Model</label><select id="model" disabled></select><label for="rename">Title</label><input id="rename" maxlength="200" disabled><button id="renameGo" disabled>Rename</button><button id="fork" type="button" disabled>Fork</button><button id="changes" type="button" disabled>Changes</button></form>
<pre id="transcript" aria-live="polite"></pre><div id="diff" hidden><h2>Changes</h2><div id="files"></div><pre id="patch"></pre></div><div id="requests" aria-live="assertive"></div><form id="prompt"><label for="message">Prompt</label><textarea id="message" disabled></textarea><button id="send" disabled>Send</button><button id="cancel" type="button" disabled>Cancel</button></form></section>
${WEB_EDITOR_PANE}
${WEB_TERMINAL_PANE}</div></main>
<script>
const el = (id) => document.getElementById(id)
const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const id = (prefix) => prefix + '_' + Array.from(crypto.getRandomValues(new Uint8Array(26)), (n) => alphabet[n % 32]).join('')
const clientId = id('cli')
let token = '', directory = '', sessionId = '', turnId = '', readOnly = false, stream, seq = 0, epoch = 0
let items = new Map(), pending = new Map()
const toolNames = ['model','rename','renameGo','fork','changes']
const node = (tag, text, props) => { const item = document.createElement(tag); if (text !== undefined) item.textContent = text; return Object.assign(item, props || {}) }
const error =(value) => { el('error').textContent = value ? String(value.message || value) : '' }
const headers = (extra) => Object.assign({ Authorization: 'Bearer ' + token }, workspaceId ?{ 'x-mendcode-workspace': workspaceId } : {}, extra || {})
async function rest(method, target, body, extra) {
  const response = await fetch(target, { method, headers: headers(Object.assign(body === undefined ? {} : { 'Content-Type': 'application/json' }, extra || {})), body: body === undefined ? undefined : JSON.stringify(body) })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(result.error?.message || 'Request failed')
  return result
}
const call = (command) => rest('POST', '/command', { ...command, id: id('cmd'), clientId })
function paint(event) {
  if (event.seq <= seq) return
  seq = event.seq
  if (event.type === 'turn.started') { turnId = event.turnId; el('cancel').disabled = readOnly }
  if (['turn.completed','turn.failed','turn.interrupted'].includes(event.type)) { turnId = ''; el('cancel').disabled = true }
  if (event.type === 'item.started' && !(event.meta && event.meta.parentItemId)) items.set(event.itemId, { kind: event.kind, text: '', title: String(event.meta?.tool || ''), status: '' })
  const item = items.get(event.itemId)
  if (item && event.type === 'item.delta') item.text += event.text || ''
  if (item && event.type === 'item.completed') { item.text = event.text ?? item.text; item.status = event.status || '' }
  if (event.type === 'server.request') { pending.set(event.requestId, event); renderRequests() }
  if (event.type === 'server.request.resolved' && pending.delete(event.requestId)) renderRequests()
  if (event.type === 'foreground.state') { el('state').textContent = event.state === 'idle' ? '' : event.state; el('cancel').disabled = readOnly || event.state === 'idle' }
  let out = '', previous = ''
  for (const item of items.values()) {
    const line = item.kind === 'user_message' ? '› ' + item.text : item.kind === 'agent_message' ? '◆ ' + item.text : item.kind === 'tool_call' ? '  ▸ ' + (item.title || 'tool') + (item.status && item.status !== 'ok' ? ' [' + item.status + ']' : item.status ? '' : ' …') : ''
    if (!line) continue
    out += (out ? (item.kind === 'tool_call' && previous === 'tool_call' ? '\\n' : '\\n\\n') : '') + line; previous = item.kind
  }
  el('transcript').textContent = out
  el('transcript').scrollTop = el('transcript').scrollHeight
}
function decide(requestId, decision) {
  const request = pending.get(requestId)
  if (!request || readOnly) return
  call({ type: 'request.resolve', sessionId, requestId, decision }).catch(error)
}
function renderRequests() {
  el('requests').replaceChildren()
  for (const request of pending.values()) {
    const card = node('div', undefined, { className: 'request' }), actions = node('div')
    card.append(node('h2', (request.kind === 'approval' ? 'Approval: ' : 'Question: ') + request.title))
    if (request.detail) card.append(node('p', request.detail))
    const id = request.requestId
    if (request.kind === 'approval' && !request.planReview) {
      actions.append(node('button', 'Allow once', { type: 'button', disabled: readOnly, onclick: () => decide(id, { kind: 'approve', scope: 'once' }) }))
      actions.append(node('button', 'Allow for session', { type: 'button', disabled: readOnly, onclick: () => decide(id, { kind: 'approve', scope: 'session' }) }))
      actions.append(node('button', 'Deny', { type: 'button', disabled: readOnly, onclick: () => decide(id, { kind: 'deny' }) }))
    } else if (request.kind === 'question' && !request.questions && !request.planReview) {
      for (const option of request.options || []) actions.append(node('button', option.label, { type: 'button', disabled: readOnly || request.multiple === true, onclick: () => decide(id, { kind: 'answer', text: option.label }) }))
      const answer = node('input', undefined, { type: 'text', maxLength: 4000, disabled: readOnly, ariaLabel: 'Answer' })
      actions.append(answer)
      actions.append(node('button', 'Answer', { type: 'button', disabled: readOnly, onclick: () => answer.value.trim() && decide(id, { kind: 'answer', text: answer.value }) }))
    } else card.append(node('p', 'Answer this request in the terminal UI.'))
    card.append(actions)
    el('requests').append(card)
  }
}
async function loadModels() {
  const select = el('model'); select.replaceChildren()
  const report = await call({ type: 'models.list', sessionId })
  select.append(node('option', 'Default model', { value: '' }))
  for (const model of report.models || []) select.append(node('option', model.name || model.id, { value: model.id }))
  select.value = report.session?.model || ''
  select.disabled = readOnly || report.selectable === false
}
async function showChanges() {
  const panel = el('diff')
  if (!panel.hidden) { panel.hidden = true; return }
  const report = await call({ type: 'session.changes', sessionId })
  el('files').replaceChildren(); el('patch').textContent = (report.files || []).length ? '' : 'No changes'
  for (const file of report.files || []) el('files').append(node('button', file.path + ' +' + file.additions + ' -' + file.deletions, { type: 'button', onclick: () => { el('patch').textContent = file.binary ? 'Binary file' : file.diff + (file.truncated ? '\\n… truncated' : '') } }))
  panel.hidden = false
}
async function follow(selected) {
  stream?.abort(); stream = new AbortController()
  const local = ++epoch
  const response = await fetch('/event', { method: 'POST', signal: stream.signal, headers: headers({ 'Content-Type': 'application/json' }), body: JSON.stringify({ sessionId: selected, afterSeq: seq, clientId }) })
  if (!response.ok) throw new Error('Event stream failed; reconnect')
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const part = await reader.read()
    if (part.done) { if (local === epoch) throw new Error('Disconnected; reconnect'); return }
    buffer += decoder.decode(part.value, { stream: true })
    let end
    while ((end = buffer.indexOf('\\n\\n')) >= 0) {
      const line = buffer.slice(0,end); buffer = buffer.slice(end + 2)
      if (local !== epoch) return
      if (line.startsWith('data: ')) { const frame = JSON.parse(line.slice(6)); if (frame.kind === 'event') paint(frame.body); if (frame.kind === 'error') throw new Error(frame.error.message) }
    }
  }
}
async function select(session) {
  stream?.abort(); const local = ++epoch
  sessionId = session.sessionId; turnId = ''; items = new Map(); pending = new Map(); seq = 0; el('cancel').disabled = true
  el('title').textContent = session.title || sessionId; el('rename').value = session.title || ''; el('diff').hidden = true; renderRequests()
  const history = await call({ type: 'session.events', sessionId, limit: 500 })
  if (local !== epoch) return
  for (const event of history.events || []) paint(event)
  mark()
  el('rename').disabled = readOnly; el('renameGo').disabled = readOnly; el('fork').disabled = readOnly; el('changes').disabled = false
  void loadModels().catch(error)
  void follow(sessionId).catch((problem) => { if (problem.name !== 'AbortError') error(problem) })
}
function mark() { for (const button of el('sessions').children) { if (button.dataset.id === sessionId) button.setAttribute('aria-current','true'); else button.removeAttribute('aria-current') } }
async function list() {
  const result = await call({ type: 'session.list', roots: true, limit: 100 })
  el('sessions').replaceChildren()
  for (const session of result.sessions || []) { const button = document.createElement('button'); button.textContent = session.title || session.sessionId; button.dataset.id = session.sessionId; button.onclick = () => select(session).catch(error); el('sessions').append(button) }
  mark()
  return result.sessions || []
}
el('login').onsubmit = async (event) => {
  event.preventDefault(); error(); stream?.abort(); ++epoch; terminalReset(); editorReset(); workspacesReset(); token = el('token').value; el('token').value = ''
  for (const name of ['new','send','message','cancel', ...toolNames]) el(name).disabled = true
  try {
    const response = await fetch('/event', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId, hello: true }) })
    const hello = await response.json()
    if (!response.ok) throw new Error(hello.error?.message || 'Connection failed')
    directory = hello.directory; homeDirectory = directory; readOnly = hello.remote?.readOnly === true
    el('new').disabled = readOnly; el('send').disabled = readOnly; el('message').disabled = readOnly; el('disconnect').hidden = false
    editorConnected(); terminalConnected(); await loadWorkspaces()
    const sessions = await list(); if (sessions[0]) await select(sessions[0])
  } catch (problem) { token = ''; error(problem) }
}
el('new').onclick = async () => { try { const created = await call({ type: 'session.create', directory }); const sessions = await list(); await select(sessions.find((s) => s.sessionId === created.sessionId)) } catch (problem) { error(problem) } }
el('prompt').onsubmit = async (event) => {
  event.preventDefault(); if (!sessionId || readOnly || !el('message').value.trim()) return
  try { await call({ type: 'user.submit', sessionId, text: el('message').value, attachments: [] }); el('message').value = ''; error() } catch (problem) { error(problem) }
}
el('message').onkeydown = (event) => { if (event.ctrlKey && event.key === 'Enter') { event.preventDefault(); el('prompt').requestSubmit() } }
el('cancel').onclick = () => turnId && call({ type: 'turn.cancel', sessionId, turnId }).catch(error)
el('tools').onsubmit = async (event) => {
  event.preventDefault(); const title = el('rename').value.trim(); if (!sessionId || readOnly || !title) return
  try { await call({ type: 'session.rename', sessionId, title }); el('title').textContent = title; await list(); error() } catch (problem) { error(problem) }
}
el('fork').onclick = async () => {
  if (!sessionId || readOnly) return
  try { const forked = await call({ type: 'session.fork', sessionId, transcript: true }); const sessions = await list(); const next = sessions.find((s) => s.sessionId === forked.sessionId); if (next) await select(next); error() } catch (problem) { error(problem) }
}
el('changes').onclick = () => { if (sessionId) showChanges().catch(error) }
el('model').onchange = async () => {
  if (!sessionId || readOnly) return
  try { await call({ type: 'session.model.set', sessionId, choice: el('model').value ? { model: el('model').value } : null }); error() } catch (problem) { error(problem); loadModels().catch(error) }
}
function clearConversation() {
  stream?.abort(); ++epoch; sessionId = ''; turnId = ''; seq = 0; items = new Map(); pending = new Map(); renderRequests()
  el('transcript').textContent = ''; el('title').textContent = 'Conversation'; el('state').textContent = ''; el('model').replaceChildren(); el('rename').value = ''; el('diff').hidden = true
  for (const name of ['cancel', ...toolNames]) el(name).disabled = true
}
el('disconnect').onclick = () => {
  terminalReset(); editorReset(); workspacesReset(); homeDirectory = ''; clearConversation(); token = ''; el('sessions').replaceChildren()
  for (const name of ['new','send','message','cancel','path','open','up', ...toolNames]) el(name).disabled = true
  el('disconnect').hidden = true; error()
}
const panes = ['chat','files','terminal']
function showTab(name) {
  for (const pane of panes) { const tab = el('tab-' + pane); el('pane-' + pane).hidden = pane !== name; tab.setAttribute('aria-selected', String(pane === name)); tab.tabIndex = pane === name ? 0 : -1 }
  if (name === 'files') filesShown()
}
for (const pane of panes) el('tab-' + pane).onclick = () => showTab(pane)
el('tabs').onkeydown = (event) => {
  const at = panes.findIndex((pane) => el('pane-' + pane).hidden === false), step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
  if (!step) return
  event.preventDefault(); const next = panes[(at + step + panes.length) % panes.length]; showTab(next); el('tab-' + next).focus?.()
}
${WEB_WORKSPACES_SCRIPT}${WEB_EDITOR_SCRIPT}${WEB_TERMINAL_SCRIPT}</script></html>`
