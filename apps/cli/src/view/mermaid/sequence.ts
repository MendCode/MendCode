import type { Line } from "../../ui/theme"
import { textWidth, wrap } from "../wrap"
import { Canvas, decodeLabel, MAX_ROWS, MERMAID_NOTES } from "./core"

type Arrow = { dashed: boolean; head: "filled" | "open" | "cross" | "async"; both?: boolean }
type SeqItem =
  | { kind: "activation"; actor: string; active: boolean }
  | { kind: "message"; from: string; to: string; text: string; arrow: Arrow }
  | { kind: "note"; place: "over" | "left" | "right"; actors: string[]; text: string }
  | { kind: "block"; op: "open" | "else" | "close"; keyword: string; label: string }
type Sequence = { participants: Map<string, string>; actors: Set<string>; items: SeqItem[] }

const BLOCK_OPEN = /^(loop|alt|opt|par|critical|break|rect)\b\s*(.*)$/i
const BLOCK_ELSE = /^(else|and|option)\b\s*(.*)$/i
/** Participant names may contain spaces ("Vista previa"), so the arrow operator, not whitespace, splits a message. */
const MESSAGE = /^(.+?)(?:\(\))?\s*(<<--?>>|--?>>?|--?x|--?\)|==?>>?|=>>?)\s*([+-])?\s*([^:]+?)\s*:\s*(.*)$/
const NOTE = /^note\s+(over|left of|right of)\s+([^:]+?)\s*:\s*(.*)$/i
const PARTICIPANT = /^(?:create\s+)?(participant|actor)\s+(.+?)(?:\s+as\s+(.+))?$/i
const PARTICIPANT_CONFIG = /\s*@\{.*\}\s*$/

function arrowOf(op: string): Arrow {
  if (op.startsWith("<<")) return { dashed: op.includes("--"), head: "filled", both: true }
  const dashed = op.startsWith("--") || op.startsWith("=")
  const tail = op.replace(/^(?:--?|==?)/, "")
  return { dashed, head: tail === ">>" ? "filled" : tail === ">" ? "open" : tail === "x" ? "cross" : "async" }
}

export function parseSequence(lines: string[]): Sequence | undefined {
  const seq: Sequence = { participants: new Map(), actors: new Set(), items: [] }
  const touch = (id: string) => {
    if (!seq.participants.has(id)) seq.participants.set(id, id)
  }
  const stack: string[] = []
  let inBox = false
  let numbering: number | undefined
  let step = 1
  const active = new Map<string, number>()
  const activation = (actor: string, enable: boolean) => {
    const count = active.get(actor) ?? 0
    if (!enable && count === 0) return false
    active.set(actor, count + (enable ? 1 : -1))
    touch(actor)
    seq.items.push({ kind: "activation", actor, active: enable })
    return true
  }
  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line.startsWith("%%")) continue
    if (/^autonumber\s+off$/i.test(line)) {
      numbering = undefined
      continue
    }
    const number = /^autonumber(?:\s+(\d+))?(?:\s+(\d+))?$/.exec(line)
    if (number) {
      numbering = Number(number[1] ?? 1)
      step = Number(number[2] ?? 1)
      if (!Number.isSafeInteger(numbering) || !Number.isSafeInteger(step) || step < 1) return undefined
      continue
    }
    const change = /^(activate|deactivate)\s+(.+)$/.exec(line)
    if (change) {
      if (!activation(change[2]!.trim(), change[1] === "activate")) return undefined
      continue
    }
    if (/^(title|links?|properties|details|end box)\b/i.test(line) || /^destroy\s/i.test(line)) continue
    if (/^box\b/i.test(line)) {
      inBox = true
      continue
    }
    const participant = PARTICIPANT.exec(line.replace(PARTICIPANT_CONFIG, ""))
    if (participant) {
      const id = participant[2]!.trim()
      if (participant[1]!.toLowerCase() === "actor") seq.actors.add(id)
      seq.participants.set(id, decodeLabel(participant[3] ?? id).join(" "))
      continue
    }
    if (/^end$/i.test(line)) {
      if (inBox && stack.length === 0) {
        inBox = false
        continue
      }
      const keyword = stack.pop()
      if (keyword === undefined) return undefined
      seq.items.push({ kind: "block", op: "close", keyword, label: "" })
      continue
    }
    const open = BLOCK_OPEN.exec(line)
    if (open) {
      stack.push(open[1]!.toLowerCase())
      seq.items.push({ kind: "block", op: "open", keyword: open[1]!.toLowerCase(), label: open[2]!.trim() })
      continue
    }
    const other = BLOCK_ELSE.exec(line)
    if (other) {
      if (!stack.length) return undefined
      seq.items.push({ kind: "block", op: "else", keyword: other[1]!.toLowerCase(), label: other[2]!.trim() })
      continue
    }
    const note = NOTE.exec(line)
    if (note) {
      const actors = note[2]!.split(",").map((a) => a.trim())
      actors.forEach(touch)
      const place = note[1]!.toLowerCase().startsWith("over") ? "over" : note[1]!.toLowerCase().startsWith("left") ? "left" : "right"
      seq.items.push({ kind: "note", place, actors, text: decodeLabel(note[3]!).join(" ") })
      continue
    }
    const message = MESSAGE.exec(line)
    if (message) {
      touch(message[1]!)
      touch(message[4]!)
      let text = decodeLabel(message[5]!).join(" ")
      if (numbering !== undefined) {
        text = `${numbering}. ${text}`
        numbering += step
      }
      if (message[3] === "+" && !activation(message[4]!, true)) return undefined
      seq.items.push({ kind: "message", from: message[1]!, to: message[4]!, arrow: arrowOf(message[2]!), text })
      if (message[3] === "-" && !activation(message[1]!, false)) return undefined
      continue
    }
    return undefined
  }
  return stack.length === 0 && seq.participants.size ? seq : undefined
}

export function renderSequence(seq: Sequence, maxWidth: number, { mirror = true }: { mirror?: boolean } = {}): { lines: Line[] } | { note: string } {
  const ids = [...seq.participants.keys()]
  const index = new Map(ids.map((id, i) => [id, i]))
  const labels = ids.map((id) => `${seq.actors.has(id) ? "♙ " : ""}${seq.participants.get(id)!}`)
  const boxWidth = labels.map((label) => textWidth(label) + 4)
  const left = boxWidth.map((w) => Math.floor((w - 1) / 2))
  const right = boxWidth.map((w, i) => w - 1 - left[i]!)
  const gaps = ids.slice(1).map((_, i) => Math.max(10, right[i]! + left[i + 1]! + 3))

  const messages = seq.items.filter((item): item is Extract<SeqItem, { kind: "message" }> => item.kind === "message")
  const spans = messages
    .map((m) => ({ a: Math.min(index.get(m.from)!, index.get(m.to)!), b: Math.max(index.get(m.from)!, index.get(m.to)!), need: textWidth(m.text) + 6 }))
    .sort((p, q) => p.b - p.a - (q.b - q.a))
  let selfRoom = 0
  for (const span of spans) {
    if (span.a === span.b) {
      if (span.a < gaps.length) gaps[span.a] = Math.max(gaps[span.a]!, span.need + 4)
      else selfRoom = Math.max(selfRoom, span.need + 4)
      continue
    }
    let current = 0
    for (let k = span.a; k < span.b; k++) current += gaps[k]!
    if (current < span.need) gaps[span.b - 1] = gaps[span.b - 1]! + (span.need - current)
  }

  let depth = 0
  let maxDepth = 0
  for (const item of seq.items) {
    if (item.kind !== "block") continue
    if (item.op === "open") maxDepth = Math.max(maxDepth, ++depth)
    else if (item.op === "close") depth--
  }
  const margin = maxDepth ? maxDepth * 2 + 2 : 0
  const available = maxWidth - margin * 2 - left[0]! - right.at(-1)! - 1
  if (gaps.reduce((total, gap) => total + gap, 0) + selfRoom > available) {
    const minimum = gaps.map((_, position) => Math.max(10, right[position]! + left[position + 1]! + 3))
    selfRoom = selfRoom ? 6 : 0
    const extra = available - selfRoom - minimum.reduce((total, gap) => total + gap, 0)
    if (extra < 0) return { note: MERMAID_NOTES.tooWide }
    minimum.forEach((gap, position) => { gaps[position] = gap + Math.floor(extra / Math.max(1, gaps.length)) })
  }
  const centers: number[] = []
  let x = margin + left[0]!
  ids.forEach((_, i) => {
    centers.push(x)
    x += gaps[i] ?? 0
  })

  let minX = 0
  let maxX = centers.length ? centers[centers.length - 1]! + right[ids.length - 1]! : 0
  maxX = Math.max(maxX, centers[centers.length - 1]! + selfRoom)
  const noteRect = (item: Extract<SeqItem, { kind: "note" }>) => {
    const tw = textWidth(item.text)
    const first = centers[index.get(item.actors[0]!)!]!
    const last = centers[index.get(item.actors[item.actors.length - 1]!)!]!
    if (item.place === "over") {
      const w = Math.max(tw + 4, last - first + 3)
      const x0 = Math.floor((first + last) / 2) - Math.floor((w - 1) / 2)
      return { x0, x1: x0 + w - 1 }
    }
    if (item.place === "left") return { x0: first - 3 - tw - 3, x1: first - 3 }
    return { x0: first + 3, x1: first + 3 + tw + 3 }
  }
  for (const item of seq.items) {
    if (item.kind !== "note") continue
    const rect = noteRect(item)
    minX = Math.min(minX, rect.x0)
    maxX = Math.max(maxX, rect.x1)
  }
  const shift = -minX
  const fragmentWidth = Math.max(0, ...seq.items.filter((item) => item.kind === "block").map((item) => textWidth(item.keyword) + textWidth(item.label) + maxDepth * 4 + 6))
  const width = Math.max(maxX - minX + 1 + margin, fragmentWidth)
  if (width > maxWidth) return { note: MERMAID_NOTES.tooWide }

  const rows: { top: number; rows: number }[] = []
  const messageRows = new Map<SeqItem, string[]>()
  let y = 3
  for (const item of seq.items) {
    const self = item.kind === "message" && item.from === item.to
    if (item.kind === "message") {
      const first = centers[index.get(item.from)!]!
      const last = centers[index.get(item.to)!]!
      messageRows.set(item, wrap(item.text, self ? Math.max(4, width - margin - first - 3) : Math.max(4, Math.abs(last - first) - 4)))
    }
    const size = item.kind === "message" ? messageRows.get(item)!.length + (self ? 2 : 1) : item.kind === "note" ? 3 : 1
    rows.push({ top: y, rows: size })
    y += size + 1
  }
  const bodyHeight = Math.max(3, y - 1)
  // Like mermaid's default `mirrorActors`, the participant boxes repeat below the last message after one more lifeline row.
  const lifeEnd = mirror ? bodyHeight + 1 : bodyHeight
  const height = mirror ? lifeEnd + 3 : bodyHeight
  if (height > MAX_ROWS) return { note: MERMAID_NOTES.tooComplex }

  const canvas = new Canvas(width, height)
  const cx = centers.map((c) => c + shift)
  const drawBox = (i: number, top: number) => {
    const x0 = cx[i]! - left[i]!
    const w = boxWidth[i]!
    canvas.glyph(x0, top, "┌", "box")
    canvas.glyph(x0 + w - 1, top, "┐", "box")
    canvas.glyph(x0, top + 2, "└", "box")
    canvas.glyph(x0 + w - 1, top + 2, "┘", "box")
    canvas.glyph(x0, top + 1, "│", "box")
    canvas.glyph(x0 + w - 1, top + 1, "│", "box")
    for (let k = 1; k < w - 1; k++) {
      canvas.glyph(x0 + k, top, "─", "box")
      canvas.glyph(x0 + k, top + 2, "─", "box")
    }
    canvas.text(x0 + 2, top + 1, labels[i]!, "text")
  }
  ids.forEach((_, i) => {
    drawBox(i, 0)
    canvas.junction(cx[i]!, 2, "S")
    for (let row = 3; row < lifeEnd; row++) canvas.glyph(cx[i]!, row, "┆", "edge")
    if (mirror) {
      drawBox(i, lifeEnd)
      canvas.junction(cx[i]!, lifeEnd, "N")
    }
  })

  // Block frames: sides first so lifelines and messages draw over them.
  const openStack: { row: number; depth: number }[] = []
  const frames: { top: number; bottom: number; depth: number }[] = []
  seq.items.forEach((item, i) => {
    if (item.kind !== "block") return
    if (item.op === "open") openStack.push({ row: rows[i]!.top, depth: openStack.length })
    else if (item.op === "close") {
      const opened = openStack.pop()
      if (opened) frames.push({ top: opened.row, bottom: rows[i]!.top, depth: opened.depth })
    }
  })
  for (const frame of frames) {
    const x0 = frame.depth * 2
    const x1 = width - 1 - frame.depth * 2
    for (let row = frame.top + 1; row < frame.bottom; row++) {
      canvas.glyph(x0, row, "│", "frame")
      canvas.glyph(x1, row, "│", "frame")
    }
  }

  const activations = new Map<string, number>()
  seq.items.forEach((item, i) => {
    if (item.kind === "activation") activations.set(item.actor, Math.max(0, (activations.get(item.actor) ?? 0) + (item.active ? 1 : -1)))
    const until = rows[i + 1]?.top ?? bodyHeight
    for (const [actor, count] of activations) {
      if (!count) continue
      const x = cx[index.get(actor)!]!
      for (let y = rows[i]!.top; y < until; y++) canvas.glyph(x, y, "║", "box")
    }
  })
  const stackNow: number[] = []
  seq.items.forEach((item, i) => {
    const top = rows[i]!.top
    if (item.kind === "activation") return
    if (item.kind === "block") {
      const level = item.op === "open" ? stackNow.length : item.op === "close" ? stackNow.length - 1 : stackNow.length - 1
      const x0 = Math.max(0, level) * 2
      const x1 = width - 1 - Math.max(0, level) * 2
      const [l, r, fill] = item.op === "open" ? ["┌", "┐", "─"] : item.op === "else" ? ["├", "┤", "╌"] : ["└", "┘", "─"]
      canvas.glyph(x0, top, l!, "frame")
      canvas.glyph(x1, top, r!, "frame")
      for (let k = x0 + 1; k < x1; k++) canvas.glyph(k, top, fill!, "frame")
      if (item.op !== "close") {
        canvas.text(x0 + 1, top, " ", "frame")
        canvas.text(x0 + 2, top, item.keyword, "keyword")
        canvas.text(x0 + 2 + item.keyword.length, top, " ", "frame")
        if (item.label) canvas.text(x0 + 3 + item.keyword.length, top, `${item.label} `, "label")
      }
      if (item.op === "open") stackNow.push(top)
      else if (item.op === "close") stackNow.pop()
      return
    }
    if (item.kind === "note") {
      const rect = noteRect(item)
      const x0 = rect.x0 + shift
      const x1 = rect.x1 + shift
      for (let row = 0; row < 3; row++) {
        for (let k = x0; k <= x1; k++) {
          const edgeX = k === x0 || k === x1
          const ch = row === 1 ? (edgeX ? "│" : " ") : k === x0 ? (row === 0 ? "┌" : "└") : k === x1 ? (row === 0 ? "┐" : "┘") : "─"
          canvas.glyph(k, top + row, ch, edgeX || row !== 1 ? "frame" : "text")
        }
      }
      const inner = x1 - x0 - 1
      canvas.text(x0 + 1 + Math.floor((inner - textWidth(item.text)) / 2), top + 1, item.text, "text")
      return
    }
    const a = cx[index.get(item.from)!]!
    const b = cx[index.get(item.to)!]!
    const dash = item.arrow.dashed ? "┄" : "─"
    const head = item.arrow.head === "cross" ? "✕" : item.arrow.head === "open" ? (b >= a ? "▷" : "◁") : b >= a ? "▶" : "◀"
    const wrapped = messageRows.get(item)!
    const arrowRow = top + wrapped.length
    if (a === b) {
      wrapped.forEach((text, offset) => canvas.text(a + 2, top + offset, text, "label"))
      canvas.glyph(a, arrowRow, "├", "edge")
      canvas.glyph(a + 1, arrowRow, dash, "edge")
      canvas.glyph(a + 2, arrowRow, dash, "edge")
      canvas.glyph(a + 3, arrowRow, "┐", "edge")
      canvas.glyph(a, arrowRow + 1, "┤", "edge")
      canvas.glyph(a + 1, arrowRow + 1, head === "▶" ? "◀" : head, "edge")
      canvas.glyph(a + 2, arrowRow + 1, dash, "edge")
      canvas.glyph(a + 3, arrowRow + 1, "┘", "edge")
      return
    }
    const lo = Math.min(a, b)
    const hi = Math.max(a, b)
    wrapped.forEach((text, offset) => canvas.text(Math.max(lo + 2, Math.floor((lo + hi - textWidth(text)) / 2)), top + offset, text, "label"))
    for (let k = lo + 1; k < hi; k++) canvas.glyph(k, arrowRow, dash, "edge")
    canvas.glyph(a, arrowRow, b > a ? "├" : "┤", "edge")
    canvas.glyph(b, arrowRow, b > a ? "┤" : "├", "edge")
    canvas.glyph(b > a ? b - 1 : b + 1, arrowRow, head, "edge")
    if (item.arrow.both) canvas.glyph(b > a ? a + 1 : a - 1, arrowRow, b > a ? "◀" : "▶", "edge")
  })
  return { lines: canvas.toLines() }
}

// ---------------------------------------------------------------------------------------------
// Entry

/** Renders a mermaid source as terminal lines (each at most `width` cells) or explains why it cannot. */
