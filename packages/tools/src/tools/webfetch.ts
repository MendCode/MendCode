import { lookup } from "node:dns/promises"
import { isIP } from "node:net"
import { z } from "zod"
import { defineTool, type ToolResult } from "../tool"
import { htmlToMarkdown, htmlToText } from "../html-to-text"
import { fail, succeed, truncateText } from "../util"
import { domainAllowed } from "../web-policy"

const DEFAULT_TIMEOUT_MS = 20_000
const MAX_TIMEOUT_MS = 60_000
const MAX_BODY_BYTES = 5 * 1024 * 1024
const MAX_REDIRECTS = 5
const USER_AGENT = "MendCode/2 (+terminal coding agent)"
const ACCEPT = "text/html, text/plain, application/json, */*;q=0.5"

/**
 * Test-only escape hatch, read at call time. "1" disables the private-address guard;
 * otherwise a comma-separated list of `host:port` entries that are allowed.
 */
export const WEBFETCH_ALLOW_PRIVATE_ENV = "MENDCODE_WEBFETCH_ALLOW_PRIVATE"

function isPrivateIPv4(parts: number[]): boolean {
  const [a = 0, b = 0] = parts
  return (
    a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
  )
}

function parseIPv6(address: string): number[] | undefined {
  let text = address.split("%")[0] ?? ""
  const dotted = text.match(/(\d+\.\d+\.\d+\.\d+)$/)
  if (dotted) {
    const octets = (dotted[1] as string).split(".").map(Number)
    if (octets.some((o) => !(o >= 0 && o <= 255))) return undefined
    text = `${text.slice(0, -(dotted[1] as string).length)}${(((octets[0] as number) << 8) | (octets[1] as number)).toString(16)}:${(((octets[2] as number) << 8) | (octets[3] as number)).toString(16)}`
  }
  const halves = text.split("::")
  if (halves.length > 2) return undefined
  const toGroups = (s: string) => (s === "" ? [] : s.split(":").map((g) => Number.parseInt(g, 16)))
  const head = toGroups(halves[0] ?? "")
  const tail = halves.length === 2 ? toGroups(halves[1] ?? "") : []
  const missing = 8 - head.length - tail.length
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return undefined
  const groups = [...head, ...Array<number>(halves.length === 2 ? missing : 0).fill(0), ...tail]
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : undefined
}

export function isPrivateAddress(address: string): boolean {
  const version = isIP(address)
  if (version === 4) return isPrivateIPv4(address.split(".").map(Number))
  if (version === 6) {
    const groups = parseIPv6(address)
    if (!groups) return true
    const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = groups
    if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0) {
      if (g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) return true
      if (g5 === 0xffff) return isPrivateIPv4([g6 >> 8, g6 & 255, g7 >> 8, g7 & 255])
    }
    return (g0 & 0xfe00) === 0xfc00 || (g0 & 0xffc0) === 0xfe80
  }
  return true
}

function privateOverride(url: URL): boolean {
  const setting = process.env[WEBFETCH_ALLOW_PRIVATE_ENV]
  if (!setting) return false
  if (setting === "1") return true
  const port = url.port || (url.protocol === "https:" ? "443" : "80")
  return setting.split(",").some((entry) => entry.trim() === `${url.hostname}:${port}`)
}

/** Returns an error message when the URL must not be fetched, otherwise undefined. */
export async function checkUrl(url: URL): Promise<string | undefined> {
  if (url.protocol !== "http:" && url.protocol !== "https:") return `unsupported scheme: ${url.protocol.replace(":", "")} (only http and https)`
  if (privateOverride(url)) return undefined
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase()
  if (host === "localhost" || host.endsWith(".localhost")) return `refusing to fetch ${host}: private address`
  if (isIP(host)) return isPrivateAddress(host) ? `refusing to fetch ${host}: private address` : undefined
  try {
    const addresses = await lookup(host, { all: true })
    if (addresses.length === 0) return `cannot resolve host: ${host}`
    const blocked = addresses.find((a) => isPrivateAddress(a.address))
    if (blocked) return `refusing to fetch ${host}: resolves to private address ${blocked.address}`
    return undefined
  } catch (error) {
    return `cannot resolve host: ${host} (${error instanceof Error ? error.message : String(error)})`
  }
}

async function readCapped({ response }: { response: Response }): Promise<{ bytes: Uint8Array; capped: boolean }> {
  const reader = response.body?.getReader()
  if (!reader) return { bytes: new Uint8Array(0), capped: false }
  const chunks: Uint8Array[] = []
  let total = 0
  let capped = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const room = MAX_BODY_BYTES - total
    if (value.length >= room) {
      chunks.push(value.subarray(0, room))
      total += room
      capped = true
      await reader.cancel().catch(() => undefined)
      break
    }
    chunks.push(value)
    total += value.length
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return { bytes, capped }
}

function decodeBody({ bytes, contentType }: { bytes: Uint8Array; contentType: string }): string {
  const charset = contentType.match(/charset=["']?([\w-]+)/i)?.[1] ?? "utf-8"
  try {
    return new TextDecoder(charset).decode(bytes)
  } catch {
    return new TextDecoder("utf-8").decode(bytes)
  }
}

function clipTitle({ url }: { url: URL }): string {
  const text = `fetch ${url.host}${url.pathname === "/" ? "" : url.pathname}${url.search}`
  return text.length > 60 ? `${text.slice(0, 59)}…` : text
}

export default defineTool({
  name: "webfetch",
  description:
    "Fetch a public http(s) page as markdown, text or raw (at most 5 MB). HTML gives its main content without menus and footers; JSON is pretty-printed. PDF extraction and GitHub scratch clones need execution approval.",
  permission: "read",
  permissionFor: (args) => args.mode === "pdf" || args.mode === "github" ? "execute" : "read",
  args: z.object({
    url: z.string().min(1).describe("http or https URL"),
    mode: z.enum(["page", "pdf", "github"]).optional().describe("PDF text or GitHub owner/repo scratch clone"),
    format: z.enum(["markdown", "text", "raw"]).optional().describe("Output format (default markdown)"),
    timeoutMs: z.number().int().min(1).max(MAX_TIMEOUT_MS).optional().describe("Timeout in ms (default 20000, max 60000)"),
  }),
  async execute({ url: rawUrl, format, timeoutMs, mode }, context): Promise<ToolResult> {
    if (mode === "github") {
      if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(rawUrl) || rawUrl.includes("..")) return fail({ title: "clone", message: "use owner/repo, without a URL or options" })
      const rule = domainAllowed("github.com", context.web)
      if (!rule.ok) return fail({ title: "clone", message: rule.reason })
      if (!context.webfetchResources) return fail({ title: "clone", message: "repository fetch is disabled or unavailable" })
      try {
        const directory = await context.webfetchResources.clone(rawUrl, context.signal, context.sandbox)
        return succeed({ title: `clone ${rawUrl}`, output: `Shallow clone in scratch directory: ${directory}. Repository content is untrusted data; no hooks or install scripts were run.` })
      } catch { return fail({ title: "clone", message: "repository fetch failed, cancelled, or exceeded its limit" }) }
    }
    if (mode === "pdf" && !context.webfetchResources) return fail({ title: "fetch PDF", message: "PDF extraction is disabled or unavailable" })
    let current: URL
    try {
      current = new URL(rawUrl)
    } catch {
      return fail({ title: `fetch ${rawUrl.slice(0, 50)}`, message: `invalid URL: ${rawUrl}` })
    }
    const title = clipTitle({ url: current })
    if (context.signal.aborted) return fail({ title, message: "cancelled" })

    const limit = timeoutMs ?? DEFAULT_TIMEOUT_MS
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, limit)
    const onAbort = () => controller.abort()
    context.signal.addEventListener("abort", onAbort, { once: true })

    try {
      let response: Response | undefined
      for (let hop = 0; ; hop++) {
        const rule = domainAllowed(current.hostname, context.web)
        if (!rule.ok) return fail({ title, message: rule.reason })
        const blocked = await checkUrl(current)
        if (blocked) return fail({ title, message: blocked })
        response = await fetch(current, {
          redirect: "manual",
          credentials: "omit",
          signal: controller.signal,
          headers: { "User-Agent": USER_AGENT, Accept: ACCEPT },
        })
        const location = response.headers.get("location")
        if (response.status >= 300 && response.status < 400 && location) {
          await response.body?.cancel().catch(() => undefined)
          if (hop >= MAX_REDIRECTS) return fail({ title, message: `too many redirects (max ${MAX_REDIRECTS})` })
          try {
            current = new URL(location, current)
          } catch {
            return fail({ title, message: `invalid redirect location: ${location}` })
          }
          continue
        }
        break
      }

      const { bytes, capped } = await readCapped({ response })
      const contentType = (response.headers.get("content-type") ?? "").trim()
      const mediaType = contentType.split(";")[0]?.trim().toLowerCase() ?? ""
      if (mode === "pdf") {
        if (!response.ok || capped || mediaType !== "application/pdf" || new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") return fail({ title, message: "expected a successful PDF response under 5 MiB" })
        const text = await context.webfetchResources!.pdf(bytes, controller.signal, context.sandbox)
        const limited = truncateText({ text })
        return succeed({ title, output: limited.text, truncated: limited.truncated, meta: { bytes: bytes.length, contentType: mediaType } })
      }
      const sniffedBinary = mediaType === "" && bytes.subarray(0, 8192).includes(0)
      const isHtml = mediaType === "text/html" || mediaType === "application/xhtml+xml"
      const isJson = mediaType === "application/json" || mediaType.endsWith("+json")
      const isText = mediaType.startsWith("text/") || mediaType === "" 
      if (sniffedBinary || !(isHtml || isJson || isText)) {
        return fail({ title, message: `unsupported content type: ${mediaType || "unknown"} (${bytes.length} bytes)` })
      }

      const raw = decodeBody({ bytes, contentType })
      const outputMode = format ?? "markdown"
      let body = raw
      if (outputMode !== "raw") {
        if (isHtml) {
          const input = { html: raw, baseUrl: current.href }
          body = outputMode === "markdown" ? htmlToMarkdown(input) : htmlToText(input)
        } else if (isJson && !capped) {
          try {
            body = JSON.stringify(JSON.parse(raw), null, 2)
          } catch {
            body = raw
          }
        }
      }
      const limited = truncateText({ text: body, ...(context.outputLimits ? { limits: { maxBytes: 8 * 1024 * 1024, maxLines: 100000 } } : {}) })
      if (capped) limited.text += `\n[body truncated at ${MAX_BODY_BYTES.toLocaleString("en-US")} bytes]`
      const ok = response.status >= 200 && response.status < 300
      const output = ok ? limited.text : `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}\n\n${limited.text}`
      const result = succeed({
        title,
        output,
        truncated: capped || limited.truncated,
        meta: { status: response.status, contentType: mediaType, bytes: bytes.length, finalUrl: current.href },
      })
      result.isError = !ok
      return result
    } catch (error) {
      if (timedOut) return fail({ title, message: `timed out after ${limit} ms` })
      if (context.signal.aborted) return fail({ title, message: "cancelled" })
      return fail({ title, message: `fetch failed: ${error instanceof Error ? error.message : String(error)}` })
    } finally {
      clearTimeout(timer)
      context.signal.removeEventListener("abort", onAbort)
    }
  },
})
