/**
 * The model's Markdown as Telegram HTML (`parse_mode: "HTML"`): headings and bold as <b>, lists as bullets, code blocks and tables as
 * <pre>, quotes as <blockquote>. Every tag it writes is closed in the same line or block, and all other text is escaped, so the result
 * parses; a message Telegram still refuses is sent as plain text instead.
 */
const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
const attribute = (text: string) => escape(text).replace(/"/g, "&quot;")

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/
const TABLE_ROW = /^\s*\|.*\|\s*$/
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/

/** Bold, italic, strike, code spans and links of one line; code spans and link targets are never read as emphasis. */
export function inlineHtml(text: string): string {
  const kept: string[] = []
  const keep = (html: string) => `\u0000${kept.push(html) - 1}\u0000`
  let rest = text.replace(/\u0000/g, "")
  rest = rest.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_all, _ticks: string, code: string) => keep(`<code>${escape(code.trim() || code)}</code>`))
  rest = rest.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_all, label: string, url: string) => keep(`<a href="${attribute(url)}">${emphasis(escape(label))}</a>`))
  return emphasis(escape(rest)).replace(/\u0000(\d+)\u0000/g, (_all, index: string) => kept[Number(index)] ?? "")
}

function emphasis(html: string) {
  return html
    .replace(/\*\*(?=[^\s*]|\*[^*\s])((?:[^*\n]|\*[^*\n]+\*)+?)\*\*(?!\*)/g, "<b>$1</b>")
    .replace(/(^|[^\w])__(?=\S)([^_\n]*?\S)__(?!\w)/g, "$1<b>$2</b>")
    .replace(/(^|[^*\w])\*(?=[^\s*])([^*<\n]*?[^\s*<])\*(?![*\w])/g, "$1<i>$2</i>")
    .replace(/(^|[^\w])_(?=[^\s_])([^_<\n]*?[^\s_<])_(?!\w)/g, "$1<i>$2</i>")
    .replace(/~~(?=\S)([^~\n]*?\S)~~/g, "<s>$1</s>")
}

/** A Markdown table as aligned columns in a <pre>: Telegram has no tables, and monospace keeps them readable. */
function table(rows: string[]) {
  const cells = rows.filter((row) => !TABLE_RULE.test(row)).map((row) => row.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim().replace(/\*\*|__|`/g, "")))
  const widths: number[] = []
  for (const row of cells) row.forEach((cell, index) => { widths[index] = Math.max(widths[index] ?? 0, cell.length) })
  const lines = cells.map((row) => row.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join("  ").trimEnd())
  if (lines.length > 1) lines.splice(1, 0, widths.map((width) => "─".repeat(width)).join("  "))
  return `<pre>${escape(lines.join("\n"))}</pre>`
}

export function markdownToTelegramHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n")
  const out: string[] = []
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    const fence = FENCE.exec(line)
    if (fence) {
      const body: string[] = []
      const marker = fence[1]!
      while (++index < lines.length && !lines[index]!.trim().startsWith(marker[0]!.repeat(marker.length))) body.push(lines[index]!)
      const language = fence[2] ? ` class="language-${attribute(fence[2])}"` : ""
      out.push(`<pre>${language ? `<code${language}>` : ""}${escape(body.join("\n"))}${language ? "</code>" : ""}</pre>`)
      continue
    }
    if (TABLE_ROW.test(line) && index + 1 < lines.length && TABLE_RULE.test(lines[index + 1]!)) {
      const rows = [line]
      while (index + 1 < lines.length && TABLE_ROW.test(lines[index + 1]!)) rows.push(lines[++index]!)
      out.push(table(rows))
      continue
    }
    if (/^\s{0,3}>/.test(line)) {
      const quoted = [line]
      while (index + 1 < lines.length && /^\s{0,3}>/.test(lines[index + 1]!)) quoted.push(lines[++index]!)
      out.push(`<blockquote>${quoted.map((entry) => inlineHtml(entry.replace(/^\s{0,3}>\s?/, ""))).join("\n")}</blockquote>`)
      continue
    }
    const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line)
    if (heading) { out.push(`<b>${inlineHtml(heading[1]!)}</b>`); continue }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push("──────────"); continue }
    const bullet = /^(\s*)[-*+]\s+(?:\[( |x|X)\]\s+)?(.*)$/.exec(line)
    if (bullet) {
      const depth = Math.floor(bullet[1]!.replace(/\t/g, "  ").length / 2)
      const mark = bullet[2] === undefined ? "•" : bullet[2] === " " ? "☐" : "☑"
      out.push(`${"   ".repeat(depth)}${mark} ${inlineHtml(bullet[3]!)}`)
      continue
    }
    out.push(inlineHtml(line))
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim()
}

/** Splits Markdown into parts; a code block cut between two parts is closed in the first and opened again in the next. */
export function balanceFences(parts: string[]): string[] {
  let open: string | undefined
  return parts.map((part) => {
    let text = open ? `${open}\n${part}` : part
    for (const line of part.split("\n")) {
      const fence = FENCE.exec(line)
      if (!fence) continue
      if (open) { if (line.trim().startsWith(open.trim().slice(0, 3))) open = undefined }
      else open = line.trim()
    }
    if (open) text = `${text}\n${open.slice(0, /^(`{3,}|~{3,})/.exec(open)?.[0].length ?? 3)}`
    return text
  })
}
