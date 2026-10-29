import type { SessionTranscriptItem, SessionTranscriptTurn } from "@mendcode/protocol"

/**
 * A self-contained HTML page for a session transcript: inline CSS only, no script, no network (the CSP says so), light and
 * dark from the viewer's setting. Tool input/output and thinking sit behind CSS-only checkboxes, hidden until toggled
 * (printing shows everything). Text is escaped here and nowhere else; callers pass text that is already redacted.
 */
export type HtmlPage = { title: string; directory?: string | undefined; turns: SessionTranscriptTurn[]; truncated: boolean; exportedAt: number; timestamps?: boolean | undefined }

const ESCAPES: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }
export const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => ESCAPES[char]!)

/** Fenced blocks become `<pre>`, the rest keeps its line breaks with `code` spans; nothing else is interpreted. */
function body(text: string): string {
  const out: string[] = []
  let prose: string[] = []
  let code: string[] | undefined
  const flush = () => {
    const joined = prose.join("\n").trim()
    if (joined) out.push(`<p>${escapeHtml(joined).replace(/`([^`\n]+)`/g, "<code>$1</code>").replace(/\n/g, "<br>")}</p>`)
    prose = []
  }
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s{0,3}```/.test(line)) {
      if (code) { out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`); code = undefined }
      else { flush(); code = [] }
    } else if (code) code.push(line)
    else prose.push(line)
  }
  if (code) out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`)
  flush()
  return out.join("")
}

const stamp = (at: number | undefined, show: boolean | undefined) => show && at !== undefined ? `<time datetime="${new Date(at).toISOString()}">${new Date(at).toISOString().replace("T", " ").slice(0, 19)}</time>` : ""

function block(entry: SessionTranscriptItem, turn: SessionTranscriptTurn, shown: { metadata: boolean }, timestamps: boolean | undefined): string {
  const when = stamp(entry.at, timestamps)
  const attachments = entry.attachments?.length ? `<p class="attachments">Attachments: ${entry.attachments.map((attachment) => escapeHtml(attachment.name)).join(", ")}</p>` : ""
  switch (entry.kind) {
    case "user_message": {
      const label = entry.source === "shell" ? "User (shell)" : entry.source === "notice" ? "System notice" : "User"
      return `<section class="msg user"><h2>${label}${when}</h2>${body(entry.text)}${attachments}</section>`
    }
    case "agent_message": {
      if (!entry.text.trim()) return ""
      const meta = !shown.metadata && turn.metadata ? `<span class="meta">${escapeHtml(`${turn.metadata.model} · ${turn.metadata.provider} · ${turn.metadata.tokens} tokens${turn.metadata.durationMs !== undefined ? ` · ${(turn.metadata.durationMs / 1000).toFixed(1)}s` : ""}`)}</span>` : ""
      shown.metadata = true
      return `<section class="msg assistant"><h2>Assistant${meta}${when}</h2>${body(entry.text)}</section>`
    }
    case "reasoning":
      return entry.text.trim() ? `<section class="thinking"><h3>Thinking</h3>${body(entry.text)}</section>` : ""
    case "tool_call": {
      const status = entry.status && entry.status !== "ok" ? `<span class="status">${escapeHtml(entry.status)}</span>` : ""
      const input = entry.input ? `<h4>Input</h4><pre><code>${escapeHtml(entry.input)}</code></pre>` : ""
      const output = entry.text.trim() ? `<h4>Output</h4><pre><code>${escapeHtml(entry.text.trim())}</code></pre>` : ""
      return `<section class="tool"><h3>Tool <code>${escapeHtml(entry.tool ?? "tool")}</code>${status}${when}</h3>${input || output ? `<div class="tool-body">${input}${output}</div>` : ""}</section>`
    }
    case "compaction":
      return `<p class="note">Context compacted.</p>`
    default:
      return entry.text.trim() ? `<section class="msg other">${body(entry.text)}</section>` : ""
  }
}

const STYLE = `
:root{color-scheme:light dark;--bg:#fafaf9;--fg:#1c1b1a;--muted:#6b6a67;--card:#fff;--line:#e4e2de;--user:#eef3fb;--accent:#2b6cb0;--code:#f2f1ee;--bad:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#e8e6e3;--muted:#9a9893;--card:#1e1e1c;--line:#333330;--user:#1b2433;--accent:#7fb0e8;--code:#262624;--bad:#f0877d}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
.toggle{position:absolute;opacity:0;pointer-events:none}
header,main{max-width:860px;margin:0 auto;padding-left:16px;padding-right:16px}
header{padding-top:28px;padding-bottom:12px;border-bottom:1px solid var(--line)}
h1{margin:0 0 4px;font-size:22px;line-height:1.3;overflow-wrap:anywhere}
.sub{margin:0;color:var(--muted);font-size:13px;overflow-wrap:anywhere}
.toggles{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
.toggles label{cursor:pointer;border:1px solid var(--line);border-radius:6px;padding:3px 10px;font-size:13px;background:var(--card);user-select:none}
#tools:checked~header label[for=tools],#thinking:checked~header label[for=thinking]{border-color:var(--accent);color:var(--accent)}
#tools:focus-visible~header label[for=tools],#thinking:focus-visible~header label[for=thinking]{outline:2px solid var(--accent);outline-offset:2px}
main{padding-top:16px;padding-bottom:48px}
section{margin:12px 0;padding:10px 14px;border:1px solid var(--line);border-radius:8px;background:var(--card)}
section.user{background:var(--user)}
h2{margin:0 0 6px;font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);font-weight:600}
h3{margin:0;font-size:13px;font-weight:600;color:var(--muted)}
h4{margin:10px 0 4px;font-size:12px;color:var(--muted);font-weight:600}
p{margin:0 0 8px;overflow-wrap:anywhere}
p:last-child{margin-bottom:0}
code{font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--code);border-radius:4px;padding:1px 4px}
pre{margin:6px 0;padding:10px 12px;overflow-x:auto;background:var(--code);border-radius:6px}
pre code{padding:0;background:none;white-space:pre}
.meta,.status,time{margin-left:8px;font-weight:400;text-transform:none;letter-spacing:0}
.status{color:var(--bad)}
.note{color:var(--muted);font-size:13px;text-align:center}
.attachments{color:var(--muted);font-size:13px}
.thinking{display:none;border-style:dashed;color:var(--muted)}
#thinking:checked~main .thinking{display:block}
.tool-body{display:none}
#tools:checked~main .tool-body{display:block}
@media print{.toggles{display:none}.thinking,.tool-body{display:block}}
`

export function renderHtml(page: HtmlPage): string {
  const blocks: string[] = []
  let tools = false
  let thinking = false
  for (const turn of page.turns) {
    const shown = { metadata: false }
    for (const entry of turn.items) {
      if (entry.kind === "tool_call" && (entry.input || entry.text.trim())) tools = true
      if (entry.kind === "reasoning" && entry.text.trim()) thinking = true
      blocks.push(block(entry, turn, shown, page.timestamps))
    }
    if (turn.outcome === "failed") blocks.push(`<p class="note">Turn failed (${escapeHtml(turn.error?.code ?? "error")}): ${escapeHtml(turn.error?.message ?? "")}</p>`)
    else if (turn.outcome === "cancelled") blocks.push(`<p class="note">Turn cancelled.</p>`)
    else if (turn.outcome === "interrupted") blocks.push(`<p class="note">Turn interrupted.</p>`)
  }
  if (page.truncated) blocks.push(`<p class="note">Export truncated: content exceeds transcript limits.</p>`)
  const title = escapeHtml(page.title.trim() || "MendCode session")
  const exported = new Date(page.exportedAt).toISOString().slice(0, 10)
  const sub = [page.directory ? escapeHtml(page.directory) : "", `${page.turns.length} turn${page.turns.length === 1 ? "" : "s"}`, `exported ${exported}`].filter(Boolean).join(" · ")
  const toggles = [tools ? `<label for="tools">Tool details</label>` : "", thinking ? `<label for="thinking">Thinking</label>` : ""].join("")
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<meta name="generator" content="MendCode">
<title>${title}</title>
<style>${STYLE}</style>
</head>
<body>
<input type="checkbox" id="tools" class="toggle" aria-label="Show tool details">
<input type="checkbox" id="thinking" class="toggle" aria-label="Show thinking">
<header>
<h1>${title}</h1>
<p class="sub">${sub}</p>
${toggles ? `<div class="toggles">${toggles}</div>` : ""}
</header>
<main>
${blocks.filter(Boolean).join("\n")}
</main>
</body>
</html>
`
}
