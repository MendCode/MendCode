/**
 * Browser terminal over the opt-in PTY API (server flag `--pty`). It is a line terminal: output is rendered as text with
 * cursor-left/right, carriage-return and erase-line handled and colors dropped; full-screen programs are not supported.
 */
export const WEB_TERMINAL_CSS = String.raw`
#term { flex: 1; min-height: 12em; margin: 0; overflow: auto; white-space: pre; border: 1px solid var(--border); padding: 12px }
#termLine { flex: 1; min-width: 12ch } #termState { color: #9bb8a6 }
`

export const WEB_TERMINAL_PANE = String.raw`<section id="pane-terminal" role="tabpanel" aria-labelledby="tab-terminal" hidden>
<header><h2>Terminal</h2><span id="termState" role="status"></span></header>
<pre id="term" tabindex="0" aria-label="Terminal output"></pre>
<form id="termForm"><label for="termLine">Command</label><input id="termLine" autocomplete="off" spellcheck="false" maxlength="4000" disabled><button id="termSend" disabled>Send</button><button id="termInt" type="button" disabled>Ctrl-C</button><button id="termEof" type="button" disabled>Ctrl-D</button><button id="termOpen" type="button" disabled>Start</button><button id="termClose" type="button" disabled>Close</button></form></section>`

export const WEB_TERMINAL_SCRIPT = String.raw`
let ptyId = '', socket, termCursor = 0, termLines = [''], termCol = 0
const termToken = /\u001b\[([0-9;?]*)[ -\/]*([@-~])|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[()][A-Za-z0-9]|\u001b[=>78]|[\s\S]/g
const termState = (text) => { el('termState').textContent = text || '' }
function termControls() {
  const live = Boolean(socket)
  el('termLine').disabled = !live; el('termSend').disabled = !live; el('termInt').disabled = !live; el('termEof').disabled = !live
  el('termOpen').disabled = readOnly || live || !token; el('termOpen').textContent = ptyId ? 'Reconnect' : 'Start'; el('termClose').disabled = !ptyId
}
function termWrite(text) {
  for (const match of text.matchAll(termToken)) {
    const token = match[0], last = termLines.length - 1
    if (match[2] !== undefined) {
      const n = parseInt(match[1], 10) || 0, line = termLines[last]
      if (match[2] === 'K') termLines[last] = n === 2 ? '' : n === 1 ? ' '.repeat(termCol) + line.slice(termCol) : line.slice(0, termCol)
      else if (match[2] === 'C') termCol += n || 1
      else if (match[2] === 'D') termCol = Math.max(0, termCol - (n || 1))
      else if (match[2] === 'G') termCol = Math.max(0, n - 1)
      else if (match[2] === 'J' && (n === 2 || n === 3)) { termLines = ['']; termCol = 0 }
    } else if (token === '\n') { termLines.push(''); termCol = 0 }
    else if (token === '\r') termCol = 0
    else if (token === '\b') termCol = Math.max(0, termCol - 1)
    else if (token === '\t') termWrite(' '.repeat(8 - termCol % 8))
    else if (token >= ' ' && token !== '\u007f' && token.charCodeAt(0) !== 27) { const line = termLines[last]; termLines[last] = line.slice(0, termCol).padEnd(termCol, ' ') + token + line.slice(termCol + 1); termCol += 1 }
  }
  if (termLines.length > 2000) termLines = termLines.slice(-2000)
  el('term').textContent = termLines.join('\n'); el('term').scrollTop = el('term').scrollHeight
}
async function termConnect() {
  termState('connecting'); error()
  try {
    if (!ptyId) { ptyId = (await rest('POST', '/pty', {})).id; termCursor = 0; termLines = ['']; termCol = 0 }
    const ticket = (await rest('POST', '/pty/' + ptyId + '/connect-token', undefined, { 'x-mendcode-ticket': '1' })).ticket
    const url = location.origin.replace(/^http/, 'ws') + '/pty/' + ptyId + '/connect?ticket=' + encodeURIComponent(ticket) + '&cursor=' + termCursor + (workspaceId ? '&workspace=' + encodeURIComponent(workspaceId) : '')
    const current = new WebSocket(url)
    current.binaryType = 'arraybuffer'; socket = current
    current.onopen = () => { termState('connected'); termControls(); void rest('PUT', '/pty/' + ptyId, { size: { cols: Math.max(20, Math.min(400, Math.floor((el('term').clientWidth || 640) / 8.5))), rows: 24 } }).catch(() => {}) }
    current.onmessage = (event) => {
      if (typeof event.data === 'string') { termCursor += event.data.length; termWrite(event.data); return }
      const bytes = new Uint8Array(event.data)
      if (bytes[0] === 0) { try { const value = JSON.parse(new TextDecoder().decode(bytes.subarray(1))).cursor; if (Number.isSafeInteger(value) && value >= 0) termCursor = value } catch (problem) {} }
    }
    current.onclose = () => { if (socket === current) { socket = undefined; termState(ptyId ? 'disconnected' : ''); termControls() } }
    termControls()
  } catch (problem) { socket = undefined; termState(''); termControls(); error(problem) }
}
function termSend(text) { if (socket) socket.send(text) }
async function termClose() {
  const id = ptyId; ptyId = ''
  const current = socket; socket = undefined; if (current) current.close()
  termState(''); termControls()
  if (id) await rest('DELETE', '/pty/' + id).catch(() => {})
}
function terminalReset() { void termClose(); termLines = ['']; termCol = 0; termCursor = 0; el('term').textContent = ''; el('termLine').value = '' }
function terminalConnected() { termControls() }
el('termOpen').onclick = () => { void termConnect() }
el('termClose').onclick = () => { void termClose() }
el('termInt').onclick = () => termSend('\u0003')
el('termEof').onclick = () => termSend('\u0004')
el('termForm').onsubmit = (event) => { event.preventDefault(); if (!socket) return; termSend(el('termLine').value + '\r'); el('termLine').value = '' }
`
