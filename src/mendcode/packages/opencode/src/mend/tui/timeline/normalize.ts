import type { TimelineToolClass, TimelineToolEvent, TimelineToolState } from "./types"
import type { MendPresentationProfile } from "../presentation"

const artifactTools = new Set(["write", "edit", "apply_patch"])
const commandTools = new Set(["bash", "shell"])
const simpleReadTools = new Set(["read", "glob", "grep", "codesearch"])
const planningTools = new Set(["task", "todowrite", "skill"])
const interactionTools = new Set(["question", "permission"])
const webTools = new Set(["webfetch", "websearch"])
const memoryTools = new Set(["memory", "memory_graph"])
const reviewTools = new Set(["review", "plan_review", "changes", "diff"])
const loopTools = new Set(["loop"])
const browserTools = new Set([
  "playwright_browser_navigate",
  "playwright_browser_click",
  "playwright_browser_type",
  "playwright_browser_snapshot",
  "playwright_browser_take_screenshot",
  "playwright_browser_console_messages",
  "playwright_browser_network_requests",
])

export function toolClass(tool: string, state?: TimelineToolState): TimelineToolClass {
  if (state === "error") return "failure"
  if (webTools.has(tool)) return "web"
  if (browserTools.has(tool) || tool.startsWith("playwright_browser_")) return "web"
  if (reviewTools.has(tool)) return "planning"
  if (loopTools.has(tool)) return "planning"
  if (memoryTools.has(tool)) return "planning"
  if (artifactTools.has(tool)) return "artifact"
  if (commandTools.has(tool)) return "command"
  if (simpleReadTools.has(tool)) return "simple-read"
  if (planningTools.has(tool)) return "planning"
  if (interactionTools.has(tool)) return "interaction"
  return "generic"
}

export function shouldRenderImageGenerationTool(tool: string) {
  return tool === "image_gen"
}

export function shouldRenderCompactTool(profile: MendPresentationProfile, tool: string) {
  if (shouldRenderImageGenerationTool(tool)) return false
  if (profile === "raw") return false
  if (tool === "task") return false
  if (tool === "loop") return false
  if (tool === "memory_graph") return false
  if (tool === "todowrite") return profile === "mendcode"
  if (toolClass(tool) === "artifact") return false
  if (profile === "minimal") return true
  return toolClass(tool) !== "artifact" && toolClass(tool) !== "command"
}

export function toolPresentationIcon(tool?: string, klass?: string, options: { asciiOnly?: boolean } = {}) {
  const ascii = options.asciiOnly === true
  if (tool === "read") return ascii ? "R" : "□"
  if (tool === "glob") return ascii ? "G" : "▦"
  if (tool === "grep" || tool === "codesearch") return ascii ? "S" : "⌕"
  if (tool === "write") return ascii ? "+" : "+"
  if (tool === "edit") return ascii ? "E" : "✎"
  if (tool === "apply_patch") return ascii ? "P" : "±"
  if (tool === "bash" || tool === "shell") return ascii ? "$" : "$"
  if (tool === "todowrite") return ascii ? "T" : "✓"
  if (tool === "task") return ascii ? "A" : "◔"
  if (tool === "webfetch" || tool === "websearch") return ascii ? "W" : "⌁"
  if (tool === "memory") return ascii ? "M" : "◉"
  if (tool === "memory_graph") return ascii ? "G" : "◎"
  if (tool === "loop") return ascii ? "L" : "⟳"
  if (tool === "review" || tool === "plan_review") return ascii ? "V" : "◫"
  if (tool === "diff" || tool === "changes") return ascii ? "D" : "⇄"
  if (tool?.startsWith("playwright_browser_")) return ascii ? "B" : "▣"
  if (klass === "failure") return ascii ? "x" : "×"
  if (klass === "planning") return ascii ? "T" : "◇"
  if (klass === "command") return "$"
  if (klass === "artifact") return ascii ? "F" : "◧"
  return ascii ? "*" : "◆"
}

export function toolPresentationIconForProfile(_profile: MendPresentationProfile, tool?: string, klass?: string) {
  return toolPresentationIcon(tool, klass, { asciiOnly: false })
}

export function compactToolTitle(
  tool: string,
  input: Record<string, unknown>,
  metadata?: Record<string, unknown>,
  output?: unknown,
) {
  const file = stringValue(input.filePath) || stringValue(input.path) || stringValue(input.file)
  if (tool === "read") return `${file || compactInput(input)}${readRange(input, output)}`.trim()
  if (tool === "grep" || tool === "codesearch")
    return `${quote(stringValue(input.pattern) || compactInput(input))}${matchCount(metadata?.matches)}`.trim()
  if (tool === "websearch") {
    const query = stringValue(input.query) || stringValue(input.q) || compactInput(input)
    return `${query ? quote(query) : "Web search"}${resultCount(metadata?.numResults)}`.trim()
  }
  if (tool === "todowrite") return "Todos"
}

export function normalizeToolEvent(input: {
  tool: string
  state: TimelineToolState
  input?: Record<string, unknown>
  metadata?: Record<string, unknown>
  output?: unknown
}): TimelineToolEvent {
  const eventInput = input.input ?? {}
  const klass = toolClass(input.tool, input.state)
  const summary = toolSummary(input.tool, eventInput, input.metadata, input.output)
  return {
    type: "tool",
    tool: input.tool,
    class: klass,
    state: input.state,
    input: eventInput,
    metadata: input.metadata,
    output: input.output,
    title: summary.title,
    lines: summary.lines,
    result: summary.result,
  }
}

export type MemoryToolPresentationTone = "active" | "success" | "error"

const memoryActionLabels: Record<string, string> = {
  add: "add",
  update: "update",
  delete: "delete",
  search: "search",
  context: "context",
  list: "list",
  categories: "categories",
  status: "status",
  overview: "overview",
  validate: "validate",
  upsert_fact: "upsert fact",
  link: "link",
  unlink: "unlink",
}

export function memoryToolPresentation(input: {
  tool: string
  state: TimelineToolState
  input?: Record<string, unknown>
  metadata?: Record<string, unknown>
}) {
  const metadataMemory = input.metadata?.mendMemoryTool
  const metadataAction =
    metadataMemory && typeof metadataMemory === "object"
      ? (metadataMemory as Record<string, unknown>).action
      : undefined
  const action = stringValue(input.input?.action) || stringValue(metadataAction) || "status"
  const label = memoryActionLabels[action] ?? action.replace(/_/g, " ")
  const tone: MemoryToolPresentationTone = input.state === "error" ? "error" : input.state === "pending" || input.state === "running" ? "active" : "success"
  return {
    action,
    label,
    title: input.tool === "memory_graph" ? `Memory graph ${label}` : `Memory ${label}`,
    tone,
  }
}

export function toolSummary(
  tool: string,
  input: Record<string, unknown>,
  metadata?: Record<string, unknown>,
  output?: unknown,
): Pick<TimelineToolEvent, "title" | "lines" | "result"> {
  const file = stringValue(input.filePath) || stringValue(input.path) || stringValue(input.file)
  if (tool === "webfetch") return webFetchSummary(input)
  if (tool === "websearch") return webSearchSummary(input, metadata, output)
  if (tool === "read") return { title: `Read ${file || compactInput(input)}${readRange(input, output)}`.trim(), lines: [] }
  if (tool === "glob") return { title: `List ${stringValue(input.pattern) || compactInput(input)}${matchCount(metadata?.count)}`.trim(), lines: [] }
  if (tool === "grep" || tool === "codesearch")
    return { title: `Search ${quote(stringValue(input.pattern) || compactInput(input))}${matchCount(metadata?.matches)}`.trim(), lines: [] }
  if (tool === "bash" || tool === "shell") return { title: `Shell ${stringValue(input.description) || stringValue(input.command) || ""}`.trim(), lines: [] }
  if (tool === "write") return { title: `Write ${file || compactInput(input)}`.trim(), lines: [] }
  if (tool === "edit") return { title: `Edit ${file || compactInput(input)}`.trim(), lines: [] }
  if (tool === "apply_patch") return { title: "Patch files", lines: [] }
  if (tool === "task") return { title: `Task ${stringValue(input.description) || compactInput(input)}`.trim(), lines: [] }
  if (tool === "todowrite") return todoWriteSummary(input, metadata, output)
  if (tool === "question") return questionSummary(input, metadata)
  if (tool === "skill") return { title: `Skill ${stringValue(input.name) || compactInput(input)}`.trim(), lines: [] }
  if (tool === "memory") return memorySummary(input, output)
  if (tool === "memory_graph") return memoryGraphSummary(input, output)
  return { title: `${tool} ${compactInput(input)}`.trim(), lines: [] }
}

function memorySummary(input: Record<string, unknown>, output?: unknown) {
  const action = stringValue(input.action) || "status"
  const scope = stringValue(input.scope)
  const id = stringValue(input.id)
  const query = stringValue(input.query)
  const title = [
    "Memory",
    memoryActionLabels[action] ?? action.replace(/_/g, " "),
    scope ? `[${scope}]` : "",
    id ? id : "",
    query ? quote(query) : "",
  ].filter(Boolean).join(" ")
  return {
    title,
    lines: memoryOutputLines(output),
  }
}

function memoryGraphSummary(input: Record<string, unknown>, output?: unknown) {
  const action = stringValue(input.action) || "overview"
  const id = stringValue(input.id)
  const from = stringValue(input.from)
  const to = stringValue(input.to)
  const query = stringValue(input.query)
  const title = [
    "Memory graph",
    action.replace(/_/g, " "),
    id ? id : "",
    from && to ? `${from} → ${to}` : "",
    query ? quote(query) : "",
  ].filter(Boolean).join(" ")
  return {
    title,
    lines: memoryOutputLines(output),
  }
}

function memoryOutputLines(output: unknown) {
  if (typeof output !== "string" || !output.trim()) return []
  return output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .slice(0, 4)
}

function webFetchSummary(input: Record<string, unknown>) {
  const url = stringValue(input.url) || stringValue(input.href) || ""
  const domain = domainFromUrl(url)
  const title = domain ? `Web ${domain}` : `Web ${compactInput(input)}`.trim()
  return {
    title,
    lines: [...new Set([stringValue(input.title), url].filter((line): line is string => Boolean(line?.trim())))],
    result: "fetched",
  }
}

function webSearchSummary(input: Record<string, unknown>, metadata?: Record<string, unknown>, output?: unknown) {
  const query = stringValue(input.query) || stringValue(input.q) || compactInput(input)
  return {
    title: `Search web ${query ? quote(query) : ""}${resultCount(metadata?.numResults)}`.trim(),
    lines: webSearchUrlLines(metadata, output),
    result: undefined,
  }
}

export function webSearchUrlLines(metadata?: Record<string, unknown>, output?: unknown) {
  return [...new Set([...(extractWebSearchUrls(metadata) || []), ...(extractWebSearchUrls(output) || [])])].slice(0, 3)
}

function extractWebSearchUrls(value: unknown, depth = 0): string[] {
  if (depth > 5 || value == null) return []
  if (typeof value === "string") {
    const parsed = parsedJsonValue(value)
    if (parsed !== undefined) return extractWebSearchUrls(parsed, depth + 1)
    return extractUrlsFromText(value)
  }
  if (Array.isArray(value)) return value.flatMap((item) => extractWebSearchUrls(item, depth + 1))
  if (typeof value !== "object") return []

  const record = value as Record<string, unknown>
  return [
    ...[record.url, record.href, record.link, record.sourceUrl, record.source_url, record.uri].flatMap(urlCandidate),
    ...[
      "results",
      "items",
      "data",
      "organic",
      "organicResults",
      "searchResults",
      "web",
      "webPages",
      "sources",
      "links",
      "entries",
      "documents",
      "hits",
      "value",
    ].flatMap((key) => extractWebSearchUrls(record[key], depth + 1)),
  ]
}

function parsedJsonValue(value: string) {
  const trimmed = value.trim()
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined
  try {
    return JSON.parse(trimmed)
  } catch {
    return undefined
  }
}

function extractUrlsFromText(value: string) {
  return Array.from(value.matchAll(/(?:https?:\/\/|www\.)[^\s<>")\]]+/g)).flatMap((match) => urlCandidate(match[0]))
}

function urlCandidate(value: unknown) {
  if (typeof value !== "string") return []
  const trimmed = value.trim().replace(/[),.;]+$/, "")
  if (!trimmed) return []
  if (/^https?:\/\//i.test(trimmed)) return [trimmed]
  if (/^www\./i.test(trimmed)) return [`https://${trimmed}`]
  if (/^[\w.-]+\.[A-Za-z]{2,}(?:[/?#].*)?$/i.test(trimmed)) return [`https://${trimmed}`]
  return []
}

function todoWriteSummary(input: Record<string, unknown>, metadata?: Record<string, unknown>, output?: unknown) {
  const todos = todoItems(input.todos)
  const fallbackTodos = todos.length ? todos : todoItems(metadata?.todos)
  const outputTodos = fallbackTodos.length ? fallbackTodos : parseTodoOutput(output)
  return {
    title: "Todos",
    lines: outputTodos.map((todo) => `${todoSymbol(todo.status)} ${todo.content}`),
  }
}

function todoItems(value: unknown): Array<{ content: string; status: string }> {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return []
    const todo = item as Record<string, unknown>
    const content = typeof todo.content === "string" ? todo.content.replace(/\s+/g, " ").trim() : ""
    if (!content) return []
    return [{ content, status: typeof todo.status === "string" ? todo.status : "" }]
  })
}

function parseTodoOutput(output: unknown): Array<{ content: string; status: string }> {
  if (typeof output !== "string" || !output.trim()) return []
  try {
    return todoItems(JSON.parse(output))
  } catch {
    return []
  }
}

function todoSymbol(status: string) {
  const normalized = status.toLowerCase().replace(/[-\s]+/g, "_")
  if (normalized === "completed" || normalized === "done" || normalized === "success") return "✓"
  if (normalized === "cancelled" || normalized === "canceled" || normalized === "failed" || normalized === "error") return "×"
  if (normalized === "in_progress" || normalized === "running" || normalized === "active") return "→"
  return "○"
}

function questionSummary(input: Record<string, unknown>, metadata?: Record<string, unknown>) {
  const questions = questionItems(input.questions)
  const answers = answerItems(metadata?.answers)
  const count = questions.length
  const title = count === 1 ? "Question" : `Questions (${count})`
  const lines = questions.flatMap((question, index) => {
    const answer = answers[index]
    const header = question.header ? `${question.header}: ` : ""
    const options = question.options.length ? `choices: ${question.options.join(", ")}` : ""
    return [
      ...wrapTimelineLine("? ", `${header}${question.question}`),
      ...(options ? wrapTimelineLine("  ", options) : []),
      ...(answer?.length ? wrapTimelineLine("→ ", answer.join(", ")) : []),
    ]
  })
  return { title, lines }
}

export function wrapTimelineLine(prefix: string, text: string, width = 76) {
  const words = text.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  const continuation = "  "
  let current = prefix

  const pushCurrent = () => {
    if (current.trim()) lines.push(current)
    current = continuation
  }

  for (const word of words) {
    const separator = current.trim() === prefix.trim() || current === continuation ? "" : " "
    const next = `${current}${separator}${word}`
    if (Bun.stringWidth(next) <= width) {
      current = next
      continue
    }

    pushCurrent()
    if (Bun.stringWidth(`${current}${word}`) <= width) {
      current = `${current}${word}`
      continue
    }

    let remaining = word
    while (Bun.stringWidth(`${current}${remaining}`) > width) {
      let cut = 0
      let measured = Bun.stringWidth(current)
      for (const char of remaining) {
        const charWidth = Bun.stringWidth(char)
        if (measured + charWidth > width) break
        measured += charWidth
        cut += char.length
      }
      lines.push(`${current}${remaining.slice(0, Math.max(1, cut))}`)
      remaining = remaining.slice(Math.max(1, cut))
      current = continuation
    }
    current = `${current}${remaining}`
  }

  pushCurrent()
  return lines.length ? lines : [prefix.trimEnd()]
}

function questionItems(value: unknown): Array<{ header: string; question: string; options: string[] }> {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return []
    const question = item as Record<string, unknown>
    const text = stringValue(question.question)?.replace(/\s+/g, " ").trim()
    if (!text) return []
    const options = Array.isArray(question.options)
      ? question.options.flatMap((option) => {
          if (!option || typeof option !== "object") return []
          const label = stringValue((option as Record<string, unknown>).label)?.replace(/\s+/g, " ").trim()
          return label ? [label] : []
        })
      : []
    return [{ header: stringValue(question.header)?.replace(/\s+/g, " ").trim() ?? "", question: text, options }]
  })
}

function answerItems(value: unknown): string[][] {
  if (!Array.isArray(value)) return []
  return value.map((answer) =>
    Array.isArray(answer)
      ? answer.flatMap((item) => {
          const text = stringValue(item)?.replace(/\s+/g, " ").trim()
          return text ? [text] : []
        })
      : [],
  )
}

function readRange(input: Record<string, unknown>, output: unknown) {
  if (typeof output === "string") {
    if (output.includes("<type>directory</type>")) {
      const truncated = output.match(/\(Showing (\d+) of (\d+) entries\./)
      if (truncated) return ` (${truncated[1]} of ${truncated[2]} entries)`
      const entries = output.match(/\((\d+) entries\)/)
      if (entries) return ` (${entries[1]} entries)`
      return ""
    }
    const explicit = output.match(/\(Showing lines (\d+)-(\d+) of (\d+)\./)
    if (explicit) return ` (${explicit[1]}-${explicit[2]} of ${explicit[3]})`
    const capped = output.match(/\(Output capped at [^)]+\. Showing lines (\d+)-(\d+)\./)
    if (capped) return ` (${capped[1]}-${capped[2]})`
    const eof = output.match(/\(End of file - total (\d+) lines\)/)
    const offset = numberValue(input.offset) || 1
    const limit = numberValue(input.limit)
    if (eof && limit) return ` (${offset}-${Math.min(offset + limit - 1, Number(eof[1]))} of ${eof[1]})`
  }
  const offset = numberValue(input.offset)
  const limit = numberValue(input.limit)
  if (!offset && !limit) return ""
  if (offset && limit) return ` (${offset}-${offset + limit - 1})`
  if (offset) return ` (from ${offset})`
  return ` (${limit} lines)`
}

function matchCount(value: unknown) {
  const count = numberValue(value)
  if (!count) return ""
  return ` (${count} ${count === 1 ? "match" : "matches"})`
}

function resultCount(value: unknown) {
  const count = numberValue(value)
  if (!count) return ""
  return ` (${count} ${count === 1 ? "result" : "results"})`
}

function usefulLines(values: Record<string, unknown>) {
  return Object.entries(values)
    .filter(([, value]) => typeof value === "string" && value.trim().length > 0)
    .map(([key, value]) => `${key.padEnd(7)} ${String(value).trim()}`)
}

function compactInput(input: Record<string, unknown>) {
  const primitives = Object.entries(input).filter(([, value]) => {
    if (typeof value === "string") return value.trim().length > 0
    return typeof value === "number" || typeof value === "boolean"
  })
  if (primitives.length === 0) return ""
  return `[${primitives.map(([key, value]) => `${key}=${value}`).join(", ")}]`
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function domainFromUrl(value: string) {
  if (!value) return ""
  try {
    return new URL(value).hostname.replace(/^www\./, "")
  } catch {
    return value.replace(/^https?:\/\//, "").split("/")[0]?.replace(/^www\./, "") || ""
  }
}

function quote(value: string) {
  if (!value) return value
  return value.startsWith('"') ? value : `"${value}"`
}
