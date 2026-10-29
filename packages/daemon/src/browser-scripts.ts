import { BROWSER_LIMITS } from "@mendcode/tools"

/**
 * Scripts evaluated inside the page. They are plain strings (the daemon has no DOM types) and take their inputs as JSON
 * literals, never by concatenating page-controlled text into code. Refs live in `window.__mendcodeRefs` until the next
 * snapshot or navigation.
 */

const INTERACTIVE = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=switch],[role=option],[role=combobox],[contenteditable=""],[contenteditable=true],[onclick],[tabindex]:not([tabindex="-1"])'

export const SNAPSHOT_SCRIPT = `(() => {
  const maxElements = ${BROWSER_LIMITS.maxElements}, maxText = ${BROWSER_LIMITS.maxTextChars}, maxLabel = ${BROWSER_LIMITS.maxLabelChars}
  const clip = (value, max) => {
    const text = String(value == null ? "" : value).replace(/\\s+/g, " ").trim()
    return text.length > max ? text.slice(0, max - 1) + "…" : text
  }
  const shown = (el) => {
    const box = el.getBoundingClientRect()
    if (box.width < 1 || box.height < 1) return false
    const style = getComputedStyle(el)
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) !== 0
  }
  const label = (el) => {
    const aria = el.getAttribute("aria-label")
    if (aria) return aria
    const by = el.getAttribute("aria-labelledby")
    if (by) {
      const text = by.split(/\\s+/).map((id) => { const node = document.getElementById(id); return node ? node.textContent : "" }).join(" ")
      if (text.trim()) return text
    }
    if (el.labels && el.labels.length) return Array.from(el.labels).map((node) => node.textContent).join(" ")
    if (el.tagName === "INPUT" && ["button", "submit", "reset"].includes(el.type)) return el.value
    const inner = el.innerText || el.textContent
    if (inner && inner.trim()) return inner
    return el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("alt") || el.getAttribute("name") || ""
  }
  const secret = (el) => el.type === "password" || /^(cc-|one-time-code)/.test(el.getAttribute("autocomplete") || "")
  const found = []
  let total = 0
  for (const el of document.querySelectorAll(${JSON.stringify(INTERACTIVE)})) {
    if (el.tagName === "INPUT" && el.type === "hidden") continue
    if (!shown(el)) continue
    total++
    if (found.length < maxElements) found.push(el)
  }
  window.__mendcodeRefs = found
  const lines = found.map((el, index) => {
    const tag = el.tagName.toLowerCase()
    const role = el.getAttribute("role")
    let kind = role || tag
    const extra = []
    if (tag === "a") { kind = role || "link"; extra.push("-> " + clip(el.getAttribute("href"), 120)) }
    else if (tag === "input") {
      kind = "input:" + (el.type || "text")
      if (el.type === "checkbox" || el.type === "radio") extra.push(el.checked ? "checked" : "unchecked")
      else if (!["button", "submit", "reset", "image", "file"].includes(el.type) && el.value) extra.push("value=" + JSON.stringify(secret(el) ? "(hidden)" : clip(el.value, maxLabel)))
    } else if (tag === "textarea") {
      if (el.value) extra.push("value=" + JSON.stringify(secret(el) ? "(hidden)" : clip(el.value, maxLabel)))
    } else if (tag === "select") {
      const options = Array.from(el.options)
      const chosen = options.filter((option) => option.selected).map((option) => option.label)
      extra.push("selected=" + JSON.stringify(clip(chosen.join(", "), maxLabel)))
      extra.push("options=" + JSON.stringify(options.slice(0, 12).map((option) => clip(option.label, 40))) + (options.length > 12 ? "+" + (options.length - 12) : ""))
    } else if (el.getAttribute("aria-checked")) extra.push(el.getAttribute("aria-checked") === "true" ? "checked" : "unchecked")
    if (el.disabled || el.getAttribute("aria-disabled") === "true") extra.push("disabled")
    return "[" + index + "] " + kind + " " + JSON.stringify(clip(label(el), maxLabel)) + (extra.length ? " " + extra.join(" ") : "")
  })
  const body = document.body ? document.body.innerText : ""
  const text = body.replace(/[ \\t]+\\n/g, "\\n").replace(/\\n{3,}/g, "\\n\\n").trim()
  return {
    url: location.href,
    title: document.title,
    text: text.length > maxText ? text.slice(0, maxText) : text,
    textCut: text.length > maxText,
    lines,
    total,
  }
})()`

export const PAGE_INFO_SCRIPT = "({ url: location.href, title: document.title, ready: document.readyState })"

export const readyScript = (): string => "document.readyState"

export const hasTextScript = (text: string): string => `Boolean(document.body && document.body.innerText.includes(${JSON.stringify(text)}))`

export const scrollScript = (direction: "up" | "down"): string =>
  `(() => { window.scrollBy(0, ${direction === "up" ? "-" : ""}Math.round(window.innerHeight * 0.8)); const max = Math.max(0, document.documentElement.scrollHeight - window.innerHeight); return { y: Math.round(window.scrollY), max: Math.round(max) } })()`

const withRef = (ref: number, body: string): string => `(() => {
  const el = (window.__mendcodeRefs || [])[${ref}]
  if (!el || !el.isConnected) return { error: "stale" }
  ${body}
})()`

/** Scrolls the element into view and returns where to press, refusing when something else sits on top of it. */
export const clickTargetScript = (ref: number): string => withRef(ref, `
  if (el.disabled || el.getAttribute("aria-disabled") === "true") return { error: "disabled" }
  if (el.tagName === "SELECT") return { error: "select" }
  el.scrollIntoView({ block: "center", inline: "center" })
  if (el.tagName === "A") el.removeAttribute("target")
  const box = el.getBoundingClientRect()
  if (box.width < 1 || box.height < 1) return { error: "hidden" }
  const x = box.left + box.width / 2, y = box.top + box.height / 2
  const hit = document.elementFromPoint(x, y)
  if (!hit || !(el.contains(hit) || hit.contains(el))) return { error: "covered", by: hit ? hit.tagName.toLowerCase() : "nothing" }
  return { x, y }`)

/** Focuses a text field and selects its content when it will be replaced; a select element is reported instead. */
export const focusFieldScript = (input: { ref: number; replace: boolean }): string => withRef(input.ref, `
  el.scrollIntoView({ block: "center", inline: "center" })
  if (el.disabled || el.readOnly) return { error: "disabled" }
  if (el.tagName === "SELECT") return { kind: "select" }
  const field = el.tagName === "INPUT" || el.tagName === "TEXTAREA"
  if (!field && !el.isContentEditable) return { error: "notText" }
  if (el.tagName === "INPUT" && !["text", "search", "email", "url", "tel", "password", "number", ""].includes(el.type)) return { error: "notText", type: el.type }
  el.focus()
  if (${input.replace}) { if (field) el.select(); else document.execCommand("selectAll") }
  else if (field && typeof el.setSelectionRange === "function") { try { el.setSelectionRange(el.value.length, el.value.length) } catch (error) {} }
  return { kind: "text" }`)

export const selectOptionScript = (input: { ref: number; wanted: string }): string => withRef(input.ref, `
  if (el.tagName !== "SELECT") return { error: "notSelect" }
  const wanted = ${JSON.stringify(input.wanted)}
  const options = Array.from(el.options)
  const match = options.find((option) => option.value === wanted) || options.find((option) => option.label.trim() === wanted.trim()) || options.find((option) => option.label.toLowerCase().includes(wanted.toLowerCase()))
  if (!match) return { error: "noOption", options: options.slice(0, 12).map((option) => option.label.trim().slice(0, 40)) }
  el.value = match.value
  el.dispatchEvent(new Event("input", { bubbles: true }))
  el.dispatchEvent(new Event("change", { bubbles: true }))
  return { selected: match.label.trim().slice(0, 80) }`)
