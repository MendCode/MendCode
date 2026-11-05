// The browser extension and its native host, as text. They live in this module, which is imported only when the extension is
// installed or enabled, so a MendCode that never uses it holds none of them (an embedded file would be loaded by every process).

/** manifest.json */
export const manifest = String.raw`{
  "manifest_version": 3,
  "name": "MendCode",
  "description": "Lets MendCode work in its own tab group, in background tabs, on sites you allow.",
  "version": "0.1.0",
  "key": "__KEY__",
  "minimum_chrome_version": "116",
  "permissions": ["tabs", "tabGroups", "scripting", "nativeMessaging", "storage", "alarms"],
  "optional_host_permissions": ["http://*/*", "https://*/*"],
  "background": { "service_worker": "background.js" },
  "action": { "default_title": "MendCode", "default_popup": "popup.html" }
}
`

/** background.js */
export const background = String.raw`// MendCode browser extension (MV3 service worker). It does nothing until MendCode's native host answers, never reads
// cookies, and only touches tabs it opened itself, inside one tab group, on sites that are both allowed by MendCode
// (pushed as {type:"sites"}) and granted by the user in this browser (popup, chrome.permissions).
const HOST = "com.mendcode.browser"
const GROUP_TITLE = "MendCode"
const MAX_TEXT = 20000
let port = null
let config = null

async function loadConfig() {
  if (!config) config = await (await fetch(chrome.runtime.getURL("config.json"))).json()
  return config
}

async function connect() {
  if (port) return
  const { token } = await loadConfig()
  try {
    port = chrome.runtime.connectNative(HOST)
  } catch {
    port = null
    return
  }
  port.onMessage.addListener(onMessage)
  port.onDisconnect.addListener(() => {
    port = null
    void chrome.runtime.lastError
  })
  port.postMessage({ type: "hello", token, version: 1 })
}

async function sites() {
  const { sites: list } = await chrome.storage.local.get("sites")
  return Array.isArray(list) ? list : []
}

async function groupIds() {
  const { tabs } = await chrome.storage.session.get("tabs")
  return Array.isArray(tabs) ? tabs : []
}

async function remember(ids) {
  await chrome.storage.session.set({ tabs: ids })
}

async function allowed(url) {
  let origin
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false
    origin = parsed.origin
  } catch {
    return false
  }
  if (!(await sites()).includes(origin)) return false
  return chrome.permissions.contains({ origins: [origin + "/*"] })
}

async function owned(tabId) {
  const ids = await groupIds()
  if (!ids.includes(tabId)) throw new Error("not a tab MendCode opened")
  const tab = await chrome.tabs.get(tabId).catch(() => null)
  if (!tab) {
    await remember(ids.filter((id) => id !== tabId))
    throw new Error("the tab is gone")
  }
  if (!(await allowed(tab.url || ""))) throw new Error("the tab is on a site that is not allowed")
  return tab
}

async function open(url) {
  if (!(await allowed(url))) throw new Error("site not allowed: allow it in MendCode and in the extension popup")
  const ids = await groupIds()
  const existing = ids.length ? await chrome.tabs.get(ids[0]).catch(() => null) : null
  const tab = await chrome.tabs.create({ url, active: false, ...(existing ? { windowId: existing.windowId } : {}) })
  const groupId = await chrome.tabs.group({ tabIds: [tab.id], ...(existing && existing.groupId >= 0 ? { groupId: existing.groupId } : {}) })
  await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: "purple" })
  await remember([...ids, tab.id])
  return { tabId: tab.id, url: tab.pendingUrl || tab.url || url, title: tab.title || "" }
}

async function list() {
  const out = []
  for (const id of await groupIds()) {
    const tab = await chrome.tabs.get(id).catch(() => null)
    if (tab) out.push({ tabId: tab.id, url: tab.url || "", title: tab.title || "" })
  }
  await remember(out.map((tab) => tab.tabId))
  return out
}

async function inPage(tabId, func, args) {
  const [result] = await chrome.scripting.executeScript({ target: { tabId }, func, args })
  return result ? result.result : undefined
}

function readPage(max) {
  return { url: location.href, title: document.title, text: (document.body ? document.body.innerText : "").slice(0, max) }
}

function clickElement(selector) {
  const el = document.querySelector(selector)
  if (!el) return { error: "no element matches " + selector }
  if (el.disabled) return { error: "element is disabled" }
  el.click()
  return { clicked: (el.tagName || "").toLowerCase() }
}

function typeInto(selector, text, submit) {
  const el = document.querySelector(selector)
  if (!el) return { error: "no element matches " + selector }
  const kind = (el.type || "").toLowerCase()
  if (kind === "password" || el.autocomplete === "one-time-code" || /cc-/.test(el.autocomplete || "")) return { error: "password, card and one-time-code fields are never filled" }
  if (!("value" in el) && !el.isContentEditable) return { error: "element does not take text" }
  el.focus()
  if (el.isContentEditable) el.textContent = text
  else {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, text)
  }
  el.dispatchEvent(new Event("input", { bubbles: true }))
  el.dispatchEvent(new Event("change", { bubbles: true }))
  if (submit) {
    const form = el.form
    if (form && form.requestSubmit) form.requestSubmit()
    else el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }))
  }
  return { typed: text.length }
}

async function perform(request) {
  switch (request.op) {
    case "ping":
      return { version: 1 }
    case "open":
      return open(request.url)
    case "tabs":
      return list()
    case "read": {
      const tab = await owned(request.tabId)
      return inPage(tab.id, readPage, [MAX_TEXT])
    }
    case "click": {
      const tab = await owned(request.tabId)
      const result = await inPage(tab.id, clickElement, [request.selector])
      if (result && result.error) throw new Error(result.error)
      return result
    }
    case "type": {
      const tab = await owned(request.tabId)
      const result = await inPage(tab.id, typeInto, [request.selector, String(request.text), request.submit === true])
      if (result && result.error) throw new Error(result.error)
      return result
    }
    case "close": {
      await owned(request.tabId)
      await chrome.tabs.remove(request.tabId)
      await remember((await groupIds()).filter((id) => id !== request.tabId))
      return { closed: request.tabId }
    }
    default:
      throw new Error("unknown operation")
  }
}

async function onMessage(message) {
  if (message && message.type === "sites" && Array.isArray(message.sites)) {
    await chrome.storage.local.set({ sites: message.sites.filter((site) => typeof site === "string") })
    return
  }
  if (!message || typeof message.id !== "number") return
  try {
    const data = await perform(message)
    port && port.postMessage({ id: message.id, ok: true, data })
  } catch (error) {
    port && port.postMessage({ id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) })
  }
}

// The browser wakes the worker on these; nothing polls while MendCode is not running (the host exits and the retry alarm is one tick a minute).
chrome.runtime.onStartup.addListener(() => void connect())
chrome.runtime.onInstalled.addListener(() => void connect())
chrome.alarms.create("mendcode-reconnect", { periodInMinutes: 1 })
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "mendcode-reconnect") void connect()
})
void connect()
`

/** popup.html */
export const popupHtml = String.raw`<!doctype html>
<meta charset="utf-8">
<style>
  body { font: 13px system-ui, sans-serif; width: 280px; margin: 12px; color: CanvasText; background: Canvas; }
  button { font: inherit; padding: 6px 10px; margin-top: 8px; }
  code { word-break: break-all; }
  p { margin: 4px 0; }
</style>
<p><strong>MendCode</strong> works only in its own "MendCode" tab group.</p>
<p>This site: <code id="site">-</code></p>
<button id="grant">Allow MendCode on this site</button>
<button id="revoke">Remove access</button>
<p id="note"></p>
<script src="popup.js"></script>
`

/** popup.js */
export const popupScript = String.raw`// The per-site grant in this browser: chrome.permissions.request needs this click. MendCode must also have the site on its own list.
async function currentOrigin() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  try {
    const url = new URL(tab.url)
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : null
  } catch {
    return null
  }
}

async function main() {
  const origin = await currentOrigin()
  const note = document.getElementById("note")
  document.getElementById("site").textContent = origin || "not an http(s) page"
  document.getElementById("grant").onclick = async () => {
    if (!origin) return (note.textContent = "Open a web page first.")
    const ok = await chrome.permissions.request({ origins: [origin + "/*"] })
    note.textContent = ok ? "Granted in this browser. MendCode still needs the site on its own list." : "Not granted."
  }
  document.getElementById("revoke").onclick = async () => {
    if (!origin) return
    await chrome.permissions.remove({ origins: [origin + "/*"] })
    note.textContent = "Access removed."
  }
}
void main()
`

/** host.mjs */
export const host = String.raw`// MendCode native messaging host: the browser starts this with stdio; frames are the same on both sides
// (4-byte little-endian length + JSON), so the host only joins stdio to the daemon's local socket.
import net from "node:net"

const socket = net.connect(__SOCKET__)
socket.on("error", () => process.exit(1))
socket.on("close", () => process.exit(0))
process.stdin.on("end", () => socket.end())
process.stdin.pipe(socket)
socket.pipe(process.stdout)
`
