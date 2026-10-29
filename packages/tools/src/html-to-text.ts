/**
 * Dependency-free HTML -> markdown/plain-text converter. Single forward scan over the input
 * (no backtracking regexes over the whole document), so cost is linear in the input size.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®", trade: "™",
  hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", laquo: "«",
  raquo: "»", bull: "•", middot: "·", times: "×", divide: "÷", euro: "€", pound: "£", yen: "¥",
  cent: "¢", sect: "§", deg: "°", plusmn: "±", larr: "←", rarr: "→", uarr: "↑", darr: "↓",
  hearts: "♥", para: "¶", micro: "µ", frac12: "½", frac14: "¼", frac34: "¾", infin: "∞", ne: "≠",
  le: "≤", ge: "≥", check: "✓", zwnj: "‌", zwj: "‍", shy: "",
}

const ENTITY_PATTERN = /&(#x[0-9a-f]{1,8}|#[0-9]{1,8}|[a-z][a-z0-9]{1,31});/gi

export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text
  return text.replace(ENTITY_PATTERN, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "�"
      return String.fromCodePoint(code)
    }
    return NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()] ?? whole
  })
}

const SKIPPED_ELEMENTS: ReadonlySet<string> = new Set(["script", "style", "noscript", "svg", "nav", "footer", "iframe", "template", "select", "dialog"])
const BLOCK_ELEMENTS: ReadonlySet<string> = new Set(["p", "ul", "ol", "table", "blockquote", "pre", "h1", "h2", "h3", "h4", "h5", "h6"])
const LINE_ELEMENTS: ReadonlySet<string> = new Set([
  "div", "section", "article", "header", "main", "aside", "form", "figure", "figcaption", "dl", "dt", "dd", "tr",
  "address", "fieldset", "details", "summary", "caption",
])
const UNSAFE_LINK_PROTOCOLS: ReadonlySet<string> = new Set(["javascript:", "vbscript:", "data:"])
const MAX_NESTING = 20

class Writer {
  private parts: string[] = []
  private newlines = 0
  private started = false
  private pendingSpace = false

  write(text: string): void {
    if (this.started && this.newlines === 0 && this.pendingSpace) this.parts.push(" ")
    this.parts.push(text)
    this.newlines = 0
    this.started = true
    this.pendingSpace = false
  }

  /** Marker (bullet, heading hashes) that is followed by a single space before the next text. */
  marker(text: string): void {
    this.write(text)
    this.pendingSpace = true
  }

  text(decoded: string): void {
    const collapsed = decoded.replace(/ /g, " ").replace(/[ \t\r\n\f]+/g, " ")
    if (collapsed === "") return
    const trimmed = collapsed.trim()
    if (trimmed === "") {
      this.pendingSpace = true
      return
    }
    if (collapsed.startsWith(" ")) this.pendingSpace = true
    this.write(trimmed)
    this.pendingSpace = collapsed.endsWith(" ")
  }

  preformatted(text: string): void {
    if (text === "") return
    this.parts.push(text)
    this.started = true
    this.pendingSpace = false
    this.newlines = text.endsWith("\n") ? 1 : 0
  }

  newline(): void {
    if (this.started && this.newlines < 1) {
      this.parts.push("\n")
      this.newlines = 1
    }
    this.pendingSpace = false
  }

  block(): void {
    if (this.started) {
      while (this.newlines < 2) {
        this.parts.push("\n")
        this.newlines++
      }
    }
    this.pendingSpace = false
  }

  endLine(): void {
    if (this.newlines === 0) {
      this.parts.push("\n")
      this.newlines = 1
    }
  }

  dropSpace(): void {
    this.pendingSpace = false
  }

  snapshot(): { length: number; newlines: number; started: boolean; pendingSpace: boolean } {
    return { length: this.parts.length, newlines: this.newlines, started: this.started, pendingSpace: this.pendingSpace }
  }

  restore(state: { length: number; newlines: number; started: boolean; pendingSpace: boolean }): void {
    this.parts.length = state.length
    this.newlines = state.newlines
    this.started = state.started
    this.pendingSpace = state.pendingSpace
  }

  get length(): number {
    return this.parts.length
  }

  toString(): string {
    return this.parts.join("")
  }
}

function isNameChar(code: number): boolean {
  return (code >= 97 && code <= 122) || (code >= 65 && code <= 90) || (code >= 48 && code <= 57) || code === 45 || code === 58 || code === 95
}

/** Index just after the closing tag of `name` (case-insensitive), or the input length when absent. */
function skipPastClosingTag({ html, name, from }: { html: string; name: string; from: number }): { start: number; end: number } {
  let at = html.indexOf("</", from)
  while (at !== -1) {
    if (html.slice(at + 2, at + 2 + name.length).toLowerCase() === name) {
      const after = html.charCodeAt(at + 2 + name.length)
      if (Number.isNaN(after) || !isNameChar(after)) {
        const close = html.indexOf(">", at)
        return { start: at, end: close === -1 ? html.length : close + 1 }
      }
    }
    at = html.indexOf("</", at + 2)
  }
  return { start: html.length, end: html.length }
}

function readAttribute({ attrs, name }: { attrs: string; name: string }): string | undefined {
  let i = 0
  const n = attrs.length
  while (i < n) {
    while (i < n && /[\s/]/.test(attrs[i] as string)) i++
    const start = i
    while (i < n && !/[\s=/>]/.test(attrs[i] as string)) i++
    const key = attrs.slice(start, i).toLowerCase()
    while (i < n && /\s/.test(attrs[i] as string)) i++
    let value = ""
    if (attrs[i] === "=") {
      i++
      while (i < n && /\s/.test(attrs[i] as string)) i++
      const quote = attrs[i]
      if (quote === '"' || quote === "'") {
        const end = attrs.indexOf(quote, i + 1)
        value = attrs.slice(i + 1, end === -1 ? n : end)
        i = end === -1 ? n : end + 1
      } else {
        const valueStart = i
        while (i < n && !/\s/.test(attrs[i] as string)) i++
        value = attrs.slice(valueStart, i)
      }
    }
    if (key === name) return decodeEntities(value)
    if (i === start) i++
  }
  return undefined
}

function resolveHref({ href, baseUrl }: { href: string | undefined; baseUrl: string }): string | undefined {
  if (!href) return undefined
  const trimmed = href.trim()
  if (trimmed === "" || trimmed.startsWith("#")) return undefined
  try {
    const url = new URL(trimmed, baseUrl)
    return UNSAFE_LINK_PROTOCOLS.has(url.protocol) ? undefined : url.href
  } catch {
    return undefined
  }
}

type TableState = { rows: string[][]; row: string[]; cell: Writer | undefined }

function cellText(writer: Writer): string {
  return writer.toString().replace(/\s+/g, " ").trim().replace(/\|/g, "\\|")
}

function renderTable({ rows, markdown }: { rows: string[][]; markdown: boolean }): string {
  const lines: string[] = []
  rows.forEach((row, index) => {
    lines.push(markdown ? `| ${row.join(" | ")} |` : row.join(" | "))
    if (markdown && index === 0) lines.push(`| ${row.map(() => "---").join(" | ")} |`)
  })
  return lines.join("\n")
}

/** Converted main content shorter than this is not taken for the page: the whole document is converted instead. */
const MIN_MAIN_CHARS = 200

const ROLE_MAIN = /\srole\s*=\s*["']?main\b/i

/** Tags seen outside scripts, styles and comments that say where the page's own content is. */
type ContentMarks = { main?: { start: number; name: string }; articles: number[]; lastClose: Map<string, number> }

/**
 * The page's own content: the `<main>` element or the one with `role="main"`, else the only `<article>`. What stands before it
 * (skip links, menus, search boxes, language lists) and after it is site chrome. Undefined when the page marks none.
 */
function mainRegion({ html, marks }: { html: string; marks: ContentMarks }): string | undefined {
  const [onlyArticle] = marks.articles
  const found = marks.main ?? (marks.articles.length === 1 && onlyArticle !== undefined ? { start: onlyArticle, name: "article" } : undefined)
  if (!found) return undefined
  const close = marks.lastClose.get(found.name) ?? -1
  return html.slice(found.start, close > found.start ? close : html.length)
}

/** Markdown or plain text of a page: its main content when it marks one with enough text, otherwise the whole document. */
export function convertHtml({ html, baseUrl, markdown }: { html: string; baseUrl: string; markdown: boolean }): string {
  const withTitle = ({ title, body }: { title: string; body: string }) => (title === "" ? body : `${markdown ? "# " : ""}${title}${body ? `\n\n${body}` : ""}`)
  const whole = convertFragment({ html, baseUrl, markdown })
  const region = mainRegion({ html, marks: whole.marks })
  if (region !== undefined) {
    const main = convertFragment({ html: region, baseUrl, markdown })
    if (main.body.length >= MIN_MAIN_CHARS) return withTitle({ title: whole.title || main.title, body: main.body })
  }
  return withTitle(whole)
}

function convertFragment({ html, baseUrl, markdown }: { html: string; baseUrl: string; markdown: boolean }): { title: string; body: string; marks: ContentMarks } {
  const marks: ContentMarks = { articles: [], lastClose: new Map() }
  const root = new Writer()
  let out = root
  const writerStack: Writer[] = []
  const tables: TableState[] = []
  const lists: Array<{ ordered: boolean; count: number }> = []
  const links: Array<{ href: string | undefined; state: ReturnType<Writer["snapshot"]> }> = []
  let title = ""
  let preDepth = 0
  const n = html.length
  let i = 0

  const flushRow = () => {
    const table = tables[tables.length - 1]
    if (!table) return
    if (table.cell) endCell(table)
    if (table.row.length > 0) table.rows.push(table.row)
    table.row = []
  }
  const endCell = (table: TableState) => {
    if (!table.cell) return
    table.row.push(cellText(table.cell))
    table.cell = undefined
    out = writerStack.pop() ?? root
  }
  const startCell = () => {
    const table = tables[tables.length - 1]
    if (!table) return
    if (table.cell) endCell(table)
    writerStack.push(out)
    table.cell = new Writer()
    out = table.cell
  }

  const open = (name: string, attrs: string) => {
    const nestedList = (name === "ul" || name === "ol") && lists.length > 0
    if (BLOCK_ELEMENTS.has(name) && !nestedList) out.block()
    else if (LINE_ELEMENTS.has(name) || nestedList) out.newline()
    switch (name) {
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
        if (markdown) out.marker("#".repeat(Number(name[1])))
        break
      case "br":
        if (preDepth > 0) out.preformatted("\n")
        else if (out.length > 0) {
          out.newline()
        }
        break
      case "hr":
        out.block()
        if (markdown) out.write("---")
        out.block()
        break
      case "ul": case "ol":
        if (lists.length < MAX_NESTING) lists.push({ ordered: name === "ol", count: 0 })
        break
      case "li": {
        out.newline()
        const list = lists[lists.length - 1]
        const indent = "  ".repeat(Math.max(0, lists.length - 1))
        if (list?.ordered) out.marker(`${indent}${++list.count}.`)
        else out.marker(`${indent}-`)
        break
      }
      case "pre":
        preDepth++
        if (markdown && preDepth === 1) {
          out.write("```")
          out.preformatted("\n")
        }
        break
      case "code":
        if (markdown && preDepth === 0) out.write("`")
        break
      case "a": {
        const href = markdown ? resolveHref({ href: readAttribute({ attrs, name: "href" }), baseUrl }) : undefined
        if (href && links.length < 50) {
          const state = out.snapshot()
          out.write("[")
          links.push({ href, state })
        } else links.push({ href: undefined, state: out.snapshot() })
        break
      }
      case "table":
        if (tables.length < MAX_NESTING) tables.push({ rows: [], row: [], cell: undefined })
        break
      case "tr":
        flushRow()
        break
      case "td": case "th":
        startCell()
        break
      default:
        break
    }
  }

  const close = (name: string) => {
    switch (name) {
      case "ul": case "ol":
        lists.pop()
        if (lists.length > 0) {
          out.newline()
          return
        }
        break
      case "li":
        out.newline()
        return
      case "pre":
        if (preDepth > 0) preDepth--
        if (preDepth === 0 && markdown) {
          out.endLine()
          out.write("```")
        }
        break
      case "code":
        if (markdown && preDepth === 0) {
          out.dropSpace()
          out.write("`")
        }
        return
      case "a": {
        const link = links.pop()
        if (link?.href) {
          if (out.length === link.state.length + 1) out.restore(link.state)
          else {
            out.dropSpace()
            out.write(`](${link.href})`)
          }
        }
        return
      }
      case "tr":
        flushRow()
        break
      case "td": case "th": {
        const table = tables[tables.length - 1]
        if (table) endCell(table)
        return
      }
      case "table": {
        flushRow()
        const table = tables.pop()
        if (table && table.rows.length > 0) {
          out.block()
          out.preformatted(renderTable({ rows: table.rows, markdown }))
          out.block()
        }
        return
      }
      default:
        break
    }
    if (BLOCK_ELEMENTS.has(name)) out.block()
    else if (LINE_ELEMENTS.has(name)) out.newline()
  }

  const emitText = (raw: string) => {
    const decoded = decodeEntities(raw)
    if (preDepth > 0) out.preformatted(decoded)
    else out.text(decoded)
  }

  while (i < n) {
    const lt = html.indexOf("<", i)
    const textEnd = lt === -1 ? n : lt
    if (textEnd > i) emitText(html.slice(i, textEnd))
    if (lt === -1) break
    i = lt
    if (html.startsWith("<!--", i)) {
      const end = html.indexOf("-->", i + 4)
      i = end === -1 ? n : end + 3
      continue
    }
    const next = html.charCodeAt(i + 1)
    if (next === 33 || next === 63) {
      const end = html.indexOf(">", i + 2)
      i = end === -1 ? n : end + 1
      continue
    }
    const closing = next === 47
    const nameStart = i + (closing ? 2 : 1)
    let nameEnd = nameStart
    while (nameEnd < n && isNameChar(html.charCodeAt(nameEnd))) nameEnd++
    if (nameEnd === nameStart) {
      emitText("<")
      i++
      continue
    }
    const name = html.slice(nameStart, nameEnd).toLowerCase()
    let k = nameEnd
    let quote = 0
    let lastSignificant = 0
    while (k < n) {
      const code = html.charCodeAt(k)
      if (quote !== 0) {
        if (code === quote) quote = 0
      } else if ((code === 34 || code === 39) && lastSignificant === 61) quote = code
      else if (code === 62) break
      if (code !== 32 && code !== 9 && code !== 10 && code !== 13) lastSignificant = code
      k++
    }
    if (k >= n) break
    const selfClosing = html.charCodeAt(k - 1) === 47
    const tagEnd = k + 1
    if (closing) marks.lastClose.set(name, i)
    else if (name === "main" || (k - nameEnd > 10 && ROLE_MAIN.test(html.slice(nameEnd, k)))) marks.main ??= { start: i, name }
    else if (name === "article") marks.articles.push(i)
    if (!closing && SKIPPED_ELEMENTS.has(name)) {
      i = selfClosing ? tagEnd : skipPastClosingTag({ html, name, from: tagEnd }).end
      continue
    }
    if (!closing && name === "title") {
      const span = skipPastClosingTag({ html, name, from: tagEnd })
      if (title === "") title = decodeEntities(html.slice(tagEnd, span.start)).replace(/[\s ]+/g, " ").trim()
      i = span.end
      continue
    }
    if (closing) close(name)
    else {
      open(name, name === "a" ? html.slice(nameEnd, k) : "")
      if (selfClosing && name !== "br" && name !== "hr") close(name)
    }
    i = tagEnd
  }

  while (tables.length > 0) {
    flushRow()
    const table = tables.pop()
    if (table && table.rows.length > 0) {
      out.block()
      out.preformatted(renderTable({ rows: table.rows, markdown }))
    }
  }
  const body = root
    .toString()
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trim()
  return { title, body, marks }
}

export const htmlToMarkdown = (input: { html: string; baseUrl: string }): string => convertHtml({ ...input, markdown: true })
export const htmlToText = (input: { html: string; baseUrl: string }): string => convertHtml({ ...input, markdown: false })
