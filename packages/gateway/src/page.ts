import { createHash } from "node:crypto"

/**
 * The gateway's own page at `/_gw/`: create a passkey from an invite, sign in, approve a device code with a fresh
 * passkey check, manage your devices, and (admins) enable or disable accounts. Dependency-free; every value enters the
 * page through textContent. The script and style are pinned by hash in the Content-Security-Policy.
 */
const STYLE = `:root{color-scheme:dark;--bg:#07110d;--panel:#0b1b13;--fg:#f0f6f2;--muted:#9bb8a6;--border:#537a60;--accent:#7de8a0;--warn:#ffb8ad}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,sans-serif}
main{max-width:40rem;margin:0 auto;padding:24px 16px;display:flex;flex-direction:column;gap:16px}h1,h2{margin:0;font-weight:600}h1{font-size:1.25rem;color:var(--accent)}h2{font-size:1rem}
section{border:1px solid var(--border);background:var(--panel);border-radius:8px;padding:16px;display:flex;flex-direction:column;gap:12px}
button,input,select{font:inherit;color:inherit;background:transparent;border:1px solid var(--border);border-radius:6px;padding:8px 12px;min-height:40px}button{cursor:pointer}button:hover{border-color:var(--accent)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px}p{margin:0}.muted{color:var(--muted)}#error{color:var(--warn);min-height:1.5em}[hidden]{display:none!important}
ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}li{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
code{font-family:ui-monospace,monospace}a{color:var(--accent)}`

const SCRIPT = `const $ = (id) => document.getElementById(id)
const enc = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '')
const dec = (text) => Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4)), (c) => c.charCodeAt(0))
let csrf = ''
const say = (problem) => { $('error').textContent = problem ? String(problem.message || problem) : '' }
async function api(path, body) {
  const response = await fetch('/_gw/' + path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers: Object.assign({ 'content-type': 'application/json' }, csrf ? { 'x-mendcode-csrf': csrf } : {}), body: body === undefined ? undefined : JSON.stringify(body) })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error((result.error && result.error.message) || 'Request failed')
  return result
}
const creation = (o) => Object.assign({}, o, { challenge: dec(o.challenge), user: Object.assign({}, o.user, { id: dec(o.user.id) }), excludeCredentials: o.excludeCredentials.map((c) => Object.assign({}, c, { id: dec(c.id) })) })
const requestOptions = (o) => Object.assign({}, o, { challenge: dec(o.challenge), allowCredentials: o.allowCredentials.map((c) => Object.assign({}, c, { id: dec(c.id) })) })
const attestation = (c) => ({ id: c.id, rawId: enc(c.rawId), type: c.type, response: { clientDataJSON: enc(c.response.clientDataJSON), attestationObject: enc(c.response.attestationObject) } })
const assertion = (c) => ({ id: c.id, rawId: enc(c.rawId), type: c.type, response: { clientDataJSON: enc(c.response.clientDataJSON), authenticatorData: enc(c.response.authenticatorData), signature: enc(c.response.signature), userHandle: c.response.userHandle ? enc(c.response.userHandle) : undefined } })
async function passkey(options) { return assertion(await navigator.credentials.get({ publicKey: requestOptions(options) })) }
const node = (tag, text) => { const item = document.createElement(tag); if (text !== undefined) item.textContent = text; return item }
const when = (ms) => ms ? new Date(ms).toLocaleString() : 'never'
let invite = ''
const hash = new URLSearchParams(location.hash.slice(1))
if (hash.get('invite')) { invite = hash.get('invite'); history.replaceState(null, '', '/_gw/') }
async function refresh() {
  say(); $('approval').hidden = true
  let me
  try { me = await api('me') } catch { me = undefined }
  csrf = me ? me.csrf : ''
  $('signin').hidden = Boolean(me); $('account').hidden = !me; $('invite').hidden = !invite || Boolean(me)
  if (!me) return
  $('who').textContent = me.name + (me.role === 'admin' ? ' (admin)' : '')
  const list = $('devices'); list.replaceChildren()
  for (const device of me.devices) {
    const item = node('li'); item.append(node('span', device.name + ' · ' + device.scope + ' · last used ' + when(device.lastUsedAt)))
    const revoke = node('button', 'Remove'); revoke.type = 'button'; revoke.onclick = () => api('devices/revoke', { deviceId: device.id }).then(refresh).catch(say)
    item.append(revoke); list.append(item)
  }
  if (!me.devices.length) list.append(node('li', 'No paired devices.'))
  $('admin').hidden = me.role !== 'admin'
  if (me.role === 'admin') {
    const accounts = await api('admin/accounts'); const rows = $('accounts'); rows.replaceChildren()
    for (const account of accounts.accounts) {
      const item = node('li'); item.append(node('span', account.name + ' · ' + account.role + ' · ' + account.status + ' · ' + account.devices + ' devices'))
      if (account.id !== me.id && account.status !== 'invited') { const toggle = node('button', account.status === 'disabled' ? 'Enable' : 'Disable'); toggle.type = 'button'; toggle.onclick = () => api('admin/account', { accountId: account.id, status: account.status === 'disabled' ? 'active' : 'disabled' }).then(refresh).catch(say); item.append(toggle) }
      rows.append(item)
    }
  }
}
$('create').onclick = async () => {
  try { say(); const { flowId, publicKey } = await api('register/options', { code: invite }); const credential = await navigator.credentials.create({ publicKey: creation(publicKey) }); await api('register', { flowId, credential: attestation(credential) }); invite = ''; await refresh() } catch (problem) { say(problem) }
}
$('login').onclick = async () => {
  try { say(); const { flowId, publicKey } = await api('login/options', {}); await api('login', { flowId, credential: await passkey(publicKey) }); await refresh() } catch (problem) { say(problem) }
}
$('logout').onclick = () => api('logout', {}).then(refresh).catch(say)
let pending
$('lookup').onsubmit = async (event) => {
  event.preventDefault()
  try { say(); pending = await api('device/approve/options', { userCode: $('code').value }); $('device-name').textContent = pending.device.name; $('device-from').textContent = pending.device.from; $('device-at').textContent = when(pending.device.createdAt); $('approval').hidden = false } catch (problem) { say(problem) }
}
$('approve').onclick = async () => {
  try { say(); await api('device/approve', { flowId: pending.flowId, scope: $('scope').value, credential: await passkey(pending.publicKey) }); $('code').value = ''; await refresh() } catch (problem) { say(problem) }
}
$('deny').onclick = () => api('device/deny', { userCode: $('code').value }).then(() => { $('code').value = ''; return refresh() }).catch(say)
refresh().catch(say)`

const BODY = `<main><h1>MendCode</h1><p id="error" role="alert"></p>
<section id="invite" hidden><h2>Create your passkey</h2><p class="muted">Your device asks for your fingerprint, face or PIN. No password is created and nothing leaves your device but a public key.</p><div class="row"><button id="create" type="button">Create passkey</button></div></section>
<section id="signin" hidden><h2>Sign in</h2><p class="muted">Use the passkey you created for this address.</p><div class="row"><button id="login" type="button">Sign in with a passkey</button></div></section>
<section id="account" hidden><div class="row"><h2 id="who"></h2><a href="/">Open MendCode</a><button id="logout" type="button">Sign out</button></div>
<form id="lookup" class="row" aria-label="Approve a device"><label for="code">Device code</label><input id="code" autocomplete="off" autocapitalize="characters" maxlength="12" required><button>Look up</button></form>
<div id="approval" hidden><p>Approve <strong id="device-name"></strong>, asking from <code id="device-from"></code> at <span id="device-at"></span>? Approve only a code shown on your own screen.</p>
<div class="row"><label for="scope">Access</label><select id="scope"><option value="full">Full</option><option value="read-only">Read only</option></select><button id="approve" type="button">Approve with passkey</button><button id="deny" type="button">Deny</button></div></div>
<h2>Your devices</h2><ul id="devices"></ul></section>
<section id="admin" hidden><h2>Accounts</h2><p class="muted">Admins enable or disable accounts; they cannot read anyone's sessions. Invite with <code>gateway invite</code> on the host.</p><ul id="accounts"></ul></section></main>`

const hashOf = (text: string) => `'sha256-${createHash("sha256").update(text).digest("base64")}'`

export const GATEWAY_PAGE = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>MendCode sign-in</title><style>${STYLE}</style>${BODY}<script>${SCRIPT}</script></html>`
export const GATEWAY_PAGE_CSP = `default-src 'none'; script-src ${hashOf(SCRIPT)}; style-src ${hashOf(STYLE)}; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
