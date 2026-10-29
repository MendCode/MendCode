// Ported from MendCode v1 markdown-render.ts; pure terminal layout.
import { preparedMermaidSourceLines, cleanMermaidLabel, preparedMermaidLines, blankRow, renderCompactBox, cleanLabel, writeVisual, padVisual, renderBox, cleanConnectorLabel, centerVisual } from "./legacy-shared"

function renderInlineBox(label: string) {
  const text = cleanMermaidLabel(label) || cleanLabel(label) || "step"
  return `┌ ${text} ┐`
}

function renderBoxConnection(input: {
  from: string
  to: string
  label?: string | undefined
  connector?: string | undefined
  width: number
}) {
  const left = renderBox(input.from)
  const right = renderBox(input.to)
  const leftWidth = Math.max(...left.map((line) => Bun.stringWidth(line)))
  const rightWidth = Math.max(...right.map((line) => Bun.stringWidth(line)))
  const connector = input.connector ?? "────▶"
  const label = cleanConnectorLabel(input.label)
  const connectorWidth =
    input.connector && !label ? Bun.stringWidth(connector) : Math.max(8, Math.min(28, Bun.stringWidth(label || connector) + 4))
  const availableWidth = Math.max(40, input.width - 4)
  const rowWidth = leftWidth + connectorWidth + rightWidth

  if (rowWidth > availableWidth) {
    const from = renderInlineBox(input.from)
    const to = renderInlineBox(input.to)
    const line = `${from} ${connector} ${to}${label ? `  ${label}` : ""}`
    return Bun.stringWidth(line) <= availableWidth ? [line] : [`${from} ${connector} ${to}`, ...(label ? [`  ${label}`] : [])]
  }

  return [
    `${padVisual(left[0]!, leftWidth)}${" ".repeat(connectorWidth)}${padVisual(right[0]!, rightWidth)}`,
    `${padVisual(left[1]!, leftWidth)}${centerVisual(connector, connectorWidth)}${padVisual(right[1]!, rightWidth)}`,
    `${padVisual(left[2]!, leftWidth)}${centerVisual(label, connectorWidth)}${padVisual(right[2]!, rightWidth)}`,
  ]
}

function renderSequenceDiagram(input: string, width: number): string | undefined {
  const lines = preparedMermaidLines(input)
  if (lines[0]!?.toLowerCase() !== "sequencediagram") return undefined

  const aliases = new Map<string, string>()
  const messages: Array<{ from: string; to: string; label: string; dashed: boolean }> = []
  const events: Array<
    | { kind: "message"; message: (typeof messages)[number] }
    | { kind: "frame"; edge: "start" | "region" | "end"; label: string }
    | { kind: "note"; label: string }
  > = []
  const participants: string[] = []
  const addParticipant = (id: string, label?: string | undefined) => {
    aliases.set(id, cleanMermaidLabel(label || aliases.get(id) || id) || id)
    if (!participants.includes(id)) participants.push(id)
  }

  for (const line of lines.slice(1)) {
    const participant = /^(?:participant|actor)\s+([A-Za-z][\w.:-]*)(?:\s+as\s+(.+))?$/i.exec(line)
    if (participant) {
      addParticipant(participant[1]!, participant[2]! || participant[1]!)
      continue
    }

    const fragment = /^(alt|opt|loop|par|critical|break)\b\s*(.*)$/i.exec(line)
    if (fragment) {
      events.push({ kind: "frame", edge: "start", label: `${fragment[1]!}${fragment[2]! ? ` · ${cleanMermaidLabel(fragment[2]!)}` : ""}` })
      continue
    }

    const region = /^(else|and|option)\b\s*(.*)$/i.exec(line)
    if (region) {
      events.push({ kind: "frame", edge: "region", label: `${region[1]!}${region[2]! ? ` · ${cleanMermaidLabel(region[2]!)}` : ""}` })
      continue
    }

    if (/^end$/i.test(line)) {
      events.push({ kind: "frame", edge: "end", label: "end" })
      continue
    }

    const note = /^note\s+(?:(?:(?:left|right)\s+of|over)\s+[^:]+\s*:\s*|\s*:\s*)(.+)$/i.exec(line)
    if (note) {
      events.push({ kind: "note", label: cleanMermaidLabel(note[1]!) })
      continue
    }

    const message = /^([A-Za-z][\w.:-]*?)(?:\(\))?\s*(-->>|->>|-->|->|--x|-x|==>>|=>>|==>|=>|-\)|--\))\s*[+-]?\s*([A-Za-z][\w.:-]*)\s*:\s*(.+)$/.exec(
      line,
    )
    if (!message) continue
    const from = message[1]!
    const to = message[3]!
    addParticipant(from)
    addParticipant(to)
    const parsedMessage = {
      from,
      to,
      label: cleanMermaidLabel(message[4]!),
      dashed: message[2]!.startsWith("--") || message[2]!.startsWith("="),
    }
    messages.push(parsedMessage)
    events.push({ kind: "message", message: parsedMessage })
  }

  if (messages.length === 0 && events.length === 0) return undefined
  if (participants.length >= 2 && participants.length <= 5) {
    const labels = participants.map((id) => aliases.get(id) ?? id)
    const columnWidth = Math.max(12, Math.max(...labels.map((label) => Bun.stringWidth(label) + 4)))
    const gap = Math.max(8, Math.min(18, Math.floor(width / Math.max(6, participants.length * 2))))
    const totalWidth = participants.length * columnWidth + (participants.length - 1) * gap
    const availableWidth = Math.max(40, width - 4)

    if (totalWidth <= availableWidth) {
      const centers = participants.map((_, index) => index * (columnWidth + gap) + Math.floor(columnWidth / 2))
      const renderParticipantRow = () => {
        const rows = [blankRow(totalWidth), blankRow(totalWidth), blankRow(totalWidth)]
        labels.forEach((label, index) => {
          const box = renderCompactBox(label, columnWidth - 2)
          const start = index * (columnWidth + gap)
          for (let row = 0; row < box.length; row++) writeVisual(rows[row]!, start, padVisual(box[row]!, columnWidth))
        })
        return rows.map((row) => row.join("").trimEnd())
      }
      const lifelineRow = () => {
        const row = blankRow(totalWidth)
        for (const center of centers) row[center]! = "│"
        return row.join("").trimEnd()
      }

      const frameRow = (edge: "start" | "region" | "end", label: string) => {
        const left = edge === "start" ? "┌" : edge === "end" ? "└" : "├"
        const right = edge === "start" ? "┐" : edge === "end" ? "┘" : "┤"
        const row = Array.from({ length: totalWidth }, () => "─")
        row[0]! = left
        row[totalWidth - 1]! = right
        writeVisual(row, 2, ` ${label} `)
        return row.join("").trimEnd()
      }

      const noteRow = (label: string) => {
        const row = Array.from({ length: totalWidth }, () => " ")
        const text = `╞ ${label} ╡`
        writeVisual(row, Math.max(0, Math.floor((totalWidth - Bun.stringWidth(text)) / 2)), text)
        return row.join("").trimEnd()
      }

      const rows: string[] = [...renderParticipantRow(), lifelineRow()]
      for (const event of events.slice(0)) {
        if (event.kind === "frame") {
          rows.push(frameRow(event.edge, event.label))
          continue
        }
        if (event.kind === "note") {
          rows.push(noteRow(event.label), lifelineRow())
          continue
        }
        const message = event.message
        const fromIndex = participants.indexOf(message.from)
        const toIndex = participants.indexOf(message.to)
        if (fromIndex < 0 || toIndex < 0) continue

        const start = centers[fromIndex]!
        const end = centers[toIndex]!
        const low = Math.min(start, end)
        const high = Math.max(start, end)
        const label = cleanLabel(message.label)
        const labelRow = blankRow(totalWidth)
        const arrowRow = blankRow(totalWidth)
        for (const center of centers) {
          labelRow[center]! = "│"
          arrowRow[center]! = "│"
        }

        const labelStart = Math.max(low + 1, low + Math.floor((high - low - Bun.stringWidth(label)) / 2))
        writeVisual(labelRow, labelStart, label)
        const lineGlyph = message.dashed ? "╌" : "─"
        for (let index = low + 1; index < high; index++) arrowRow[index]! = lineGlyph
        arrowRow[start]! = fromIndex < toIndex ? "├" : "┤"
        arrowRow[end]! = fromIndex < toIndex ? "▶" : "◀"
        rows.push(labelRow.join("").trimEnd(), arrowRow.join("").trimEnd(), lifelineRow())
      }
      rows.push(...renderParticipantRow())
      return rows.join("\n")
    }
  }

  const rows: string[] = []

  for (const [index, event] of events.slice(0).entries()) {
    if (index > 0) rows.push("")
    if (event.kind === "frame") {
      rows.push(`┌─ ${event.label} ─┐`)
      continue
    }
    if (event.kind === "note") {
      rows.push(`╞ ${event.label} ╡`)
      continue
    }
    const message = event.message
    rows.push(
      ...renderBoxConnection({
        from: aliases.get(message.from) ?? message.from,
        to: aliases.get(message.to) ?? message.to,
        label: message.label,
        connector: message.dashed ? "╌╌╌▶" : "────▶",
        width,
      }),
    )
  }

  return rows.join("\n")
}

export function renderZenUml(input: string, width: number): string | undefined {
  const lines = preparedMermaidSourceLines(input)
  if (!/^zenuml$/i.test(lines[0]!?.trim() ?? "")) return undefined
  const sequenceSource = ["sequenceDiagram"]
  let sequenceMessages = 0
  for (const raw of lines.slice(1)) {
    const line = raw.trim()
    const message = /^([A-Za-z_][\w.-]*?)\s*(-->>|->>|-->|->|=>|=>>|\-\))\s*([A-Za-z_][\w.-]*?)(?:\s*:\s*(.+))?$/i.exec(line)
    if (message) {
      sequenceSource.push(`${message[1]!}${message[2]!}${message[3]!}: ${cleanMermaidLabel(message[4]!) || "call"}`)
      sequenceMessages++
      continue
    }
    const branch = /^(if\s*\((.+)\)|opt\s+(.+)|loop\s+(.+))\s*\{?$/i.exec(line)
    if (branch) sequenceSource.push(`${/^loop/i.test(branch[1]!) ? "loop" : /^opt/i.test(branch[1]!) ? "opt" : "alt"} ${cleanMermaidLabel(branch[2]! || branch[3]! || branch[4]!)}`)
    else if (/^}\s*else/i.test(line)) sequenceSource.push(`else ${cleanMermaidLabel(line.replace(/^}\s*else\s*/i, "").replace(/[{}]/g, ""))}`)
    else if (line === "}") sequenceSource.push("end")
  }
  if (sequenceMessages > 0) {
    const rendered = renderSequenceDiagram(sequenceSource.join("\n"), width)
    if (rendered) return ["ZenUML", rendered].join("\n")
  }
  const output: string[] = ["ZenUML"]
  let depth = 0
  let rendered = 0
  for (const raw of lines.slice(1)) {
    const line = raw.trim()
    if (!line) continue
    if (line === "}") {
      depth = Math.max(0, depth - 1)
      output.push(`${"  ".repeat(depth)}└─ end`)
      continue
    }
    const closeBranch = /^}\s*(else(?:\s+if\s*\(.+\))?|catch|finally)\s*\{?$/i.exec(line)
    if (closeBranch) {
      depth = Math.max(0, depth - 1)
      output.push(`${"  ".repeat(depth)}├─ ${cleanMermaidLabel(closeBranch[1]!)}`)
      if (line.endsWith("{")) depth++
      continue
    }
    const branch = /^(if\s*\(.+\)|else(?:\s+if\s*\(.+\))?|opt|par|try|catch|finally|loop)\s*\{?$/i.exec(line)
    if (branch) {
      output.push(`${"  ".repeat(depth)}┌─ ${cleanMermaidLabel(branch[1]!)} ─┐`)
      if (line.endsWith("{")) depth++
      continue
    }
    const message = /^([A-Za-z_][\w.-]*?)\s*(-->>|->>|-->|->|=>|=>>|\-\))\s*([A-Za-z_][\w.-]*?)(?:\s*:\s*(.+))?$/i.exec(line)
    if (message) {
      const connector = message[2]!.startsWith("--") || message[2]!.startsWith("=") ? "╌╌╌▶" : "────▶"
      output.push(`${"  ".repeat(depth)}${renderInlineBox(message[1]!)} ${connector} ${renderInlineBox(message[3]!)}${message[4]! ? `  ${cleanMermaidLabel(message[4]!)}` : ""}`)
      rendered++
      continue
    }
    const call = /^([A-Za-z_][\w.-]*)\s*\.\s*(.+)$/.exec(line)
    if (call) {
      output.push(`${"  ".repeat(depth)}${renderInlineBox(call[1]!)} · ${cleanMermaidLabel(call[2]!)}`)
      rendered++
      continue
    }
    if (!/^(?:title|hide|show)\b/i.test(line)) output.push(`${"  ".repeat(depth)}• ${cleanMermaidLabel(line)}`)
  }
  return rendered > 0 ? output.join("\n") : undefined
}
