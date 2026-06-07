import { spawn } from "child_process"
import stripAnsi from "strip-ansi"
import { which } from "@/util/which"

const MAX_MARKDOWN_BYTES = 50_000
const MAX_MERMAID_BLOCKS = 8
const MAX_MERMAID_BYTES = 8_000
const MAX_TERMAID_OUTPUT_BYTES = 20_000
const TERMAID_TIMEOUT_MS = 2_000
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g

function resolveTermaid() {
  const configured = process.env.MENDCODE_TERMAID_BIN?.trim()
  if (configured) return configured
  return which("termaid")
}

function cleanOutput(input: string) {
  return stripAnsi(input).replace(CONTROL_CHARS, "").trimEnd()
}

function cleanLabel(input: string | undefined) {
  return (input ?? "")
    .replace(/[`"'{}]/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

export function planReviewInlineTitle(input: string | undefined) {
  const title = cleanLabel(input).replace(/^Plan:\s*/i, "")
  return title || undefined
}

function renderBox(label: string) {
  const text = cleanLabel(label) || "step"
  const width = Math.min(52, Math.max(10, Bun.stringWidth(text) + 2))
  const padded = ` ${text} `
  const inner = padded + " ".repeat(Math.max(0, width - Bun.stringWidth(padded)))
  return [`╭${"─".repeat(width)}╮`, `│${inner}│`, `╰${"─".repeat(width)}╯`]
}

function renderInlineBox(label: string) {
  const text = cleanLabel(label) || "step"
  return `┌ ${text} ┐`
}

function indentLines(lines: string[], depth: number) {
  const prefix = "  ".repeat(depth)
  return lines.map((line) => (line ? `${prefix}${line}` : line))
}

function centerLine(input: string, width: number) {
  const lineWidth = Bun.stringWidth(input)
  if (lineWidth >= width) return input
  return `${" ".repeat(Math.floor((width - lineWidth) / 2))}${input}`
}

function popTrailingHeading(input: string) {
  const match = /(^|[\r\n])([ \t]{0,3}#{1,6}[ \t]+([^\r\n]+)[ \t]*)(?:\r?\n[ \t]*)*$/.exec(input)
  if (!match) return { prefix: input }
  const headingStart = (match.index ?? 0) + match[1].length
  const title = cleanLabel(match[3])
  if (!title.match(/\b(diagram|diagrama|mermaid|flowchart|flujo)\b/i)) return { prefix: input }
  return {
    prefix: input.slice(0, headingStart),
    title,
  }
}

function renderSimpleFlowchart(input: string): string | undefined {
  const lines = input
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  const head = lines[0]?.toLowerCase()
  if (!head?.match(/^(flowchart|graph)\s+(td|tb|lr|rl|bt)\b/)) return undefined

  const nodePattern = String.raw`([A-Za-z][\w-]*)(?:\[([^\]]+)\]|\(([^)]+)\)|\{([^}]+)\})?`
  const edgePattern = new RegExp(
    `^\\s*${nodePattern}\\s*(?:--\\s*([^>-]+?)\\s*-->|-->|---|==>|-.->|[—–-]*→|→)\\s*${nodePattern}\\s*$`,
  )
  const labels = new Map<string, string>()
  const edges: Array<{ from: string; to: string; label?: string }> = []

  for (const line of lines.slice(1)) {
    const match = edgePattern.exec(line)
    if (!match) continue
    const [, from, fromSquare, fromRound, fromBrace, edgeLabel, to, toSquare, toRound, toBrace] = match
    if (!from || !to) continue
    labels.set(from, cleanLabel(fromSquare || fromRound || fromBrace || labels.get(from) || from))
    labels.set(to, cleanLabel(toSquare || toRound || toBrace || labels.get(to) || to))
    edges.push({ from, to, label: cleanLabel(edgeLabel) || undefined })
  }

  if (edges.length === 0) return undefined

  const outgoing = new Map<string, Array<{ to: string; label?: string }>>()
  const incoming = new Set<string>()
  for (const { from, to, label } of edges) {
    outgoing.set(from, [...(outgoing.get(from) ?? []), { to, label }])
    incoming.add(to)
  }
  const starts = [...outgoing.keys()].filter((node) => !incoming.has(node))
  const start = starts[0] ?? edges[0]?.from

  if (start && edges.length <= 16) {
    const renderNode = (node: string, path: Set<string>, depth = 0): string[] => {
      const next = outgoing.get(node) ?? []
      const lines = indentLines(renderBox(labels.get(node) ?? node), depth)
      if (next.length === 0) return lines

      if (next.length === 1 && !next[0].label) {
        const target = next[0].to
        lines.push(`${"  ".repeat(depth)}        │`)
        lines.push(`${"  ".repeat(depth)}        ▼`)
        if (path.has(target)) {
          lines.push(`${"  ".repeat(depth)}        ↺ ${labels.get(target) ?? target}`)
          return lines
        }
        return [...lines, ...renderNode(target, new Set([...path, target]), depth)]
      }

      for (let index = 0; index < next.length; index++) {
        const edge = next[index]
        const branch = index === next.length - 1 ? "└" : "├"
        const label = edge.label ? `${edge.label} →` : "→"
        lines.push(`${"  ".repeat(depth)}${branch}─ ${label}`)
        if (path.has(edge.to)) {
          lines.push(`${"  ".repeat(depth + 1)}↺ ${labels.get(edge.to) ?? edge.to}`)
          continue
        }
        lines.push(...renderNode(edge.to, new Set([...path, edge.to]), depth + 1))
      }
      return lines
    }

    const rendered = renderNode(start, new Set([start]))
    if (rendered.length > 3) return rendered.join("\n")
  }

  return edges
    .map(({ from, to, label }) => {
      const connector = label ? ` ── ${label} ─▶ ` : " ──▶ "
      return `${renderInlineBox(labels.get(from) ?? from)}${connector}${renderInlineBox(labels.get(to) ?? to)}`
    })
    .join("\n")
}

async function runTermaid(input: string, width: number): Promise<string | undefined> {
  const bin = resolveTermaid()
  if (!bin) return undefined

  return await new Promise<string | undefined>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (value: string | undefined) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve(value)
    }
    const child = spawn(
      bin,
      ["--width", String(Math.max(40, Math.min(160, width))), "--padding-x", "2", "--padding-y", "1", "--gap", "2"],
      {
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        windowsHide: true,
        env: { ...process.env, NO_COLOR: "1" },
      },
    )

    let stdout = ""
    let stderr = ""
    timer = setTimeout(() => {
      child.kill("SIGKILL")
      finish(undefined)
    }, TERMAID_TIMEOUT_MS)

    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk) => {
      stdout += chunk
      if (Buffer.byteLength(stdout, "utf8") > MAX_TERMAID_OUTPUT_BYTES) child.kill("SIGKILL")
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk
      if (Buffer.byteLength(stderr, "utf8") > MAX_TERMAID_OUTPUT_BYTES) child.kill("SIGKILL")
    })
    child.on("error", () => {
      finish(undefined)
    })
    child.on("close", (code) => {
      if (code !== 0) {
        finish(undefined)
        return
      }
      const output = cleanOutput(stdout || stderr)
      finish(output || undefined)
    })
    child.stdin.end(input)
  })
}

export async function renderPlanMarkdown(markdown: string, width: number): Promise<string> {
  const source =
    Buffer.byteLength(markdown, "utf8") > MAX_MARKDOWN_BYTES ? markdown.slice(0, MAX_MARKDOWN_BYTES) : markdown
  const blocks = [...source.matchAll(/```[ \t]*mermaid[^\r\n]*\r?\n([\s\S]*?)\r?\n[ \t]*```/gi)]
  if (blocks.length === 0) return source

  let result = ""
  let cursor = 0
  let rendered = 0

  for (const match of blocks) {
    const index = match.index ?? 0
    result += source.slice(cursor, index)
    cursor = index + match[0].length

    const diagram = match[1] ?? ""
    if (rendered >= MAX_MERMAID_BLOCKS || Buffer.byteLength(diagram, "utf8") > MAX_MERMAID_BYTES) {
      result += match[0]
      continue
    }

    const output = renderSimpleFlowchart(diagram) ?? (await runTermaid(diagram, width))
    if (!output) {
      result += match[0]
      continue
    }

    rendered++
    const heading = popTrailingHeading(result)
    result = heading.prefix
    const renderedDiagram = output.trimEnd()
    const block = heading.title ? [centerLine(heading.title, width), "", renderedDiagram].join("\n") : renderedDiagram
    result += ["```text", block, "```"].join("\n")
  }

  result += source.slice(cursor)
  return result
}
