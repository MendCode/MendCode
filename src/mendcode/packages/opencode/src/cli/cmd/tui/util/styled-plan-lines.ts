export type StyledPlanMarkdownSegment = {
  kind: "markdown" | "text"
  content: string
}

function isMarkdownHeading(line: string | undefined) {
  return /^ {0,3}#{1,6}\s+\S/.test(line ?? "")
}

function firstLine(content: string) {
  return content.split("\n")[0]
}

function lastLine(content: string) {
  return content.split("\n").at(-1)
}

function separateGeneratedTextFromHeadings(segments: StyledPlanMarkdownSegment[]) {
  return segments.map((segment, index) => {
    if (segment.kind !== "markdown") return segment

    const previous = segments[index - 1]
    const next = segments[index + 1]
    let content = segment.content

    if (previous?.kind === "text" && isMarkdownHeading(firstLine(content))) {
      content = `\n${content}`
    }
    if (next?.kind === "text" && isMarkdownHeading(lastLine(content))) {
      content = `${content}\n`
    }

    return content === segment.content ? segment : { ...segment, content }
  })
}

export function styledPlanMarkdownSegments(content: string): StyledPlanMarkdownSegment[] {
  const segments: StyledPlanMarkdownSegment[] = []
  const markdown: string[] = []
  const text: string[] = []
  let inTextFence = false

  const flushMarkdown = () => {
    if (markdown.length === 0) return
    segments.push({ kind: "markdown", content: markdown.join("\n") })
    markdown.length = 0
  }
  const flushText = () => {
    if (text.length === 0) return
    segments.push({ kind: "text", content: text.join("\n") })
    text.length = 0
  }

  for (const line of content.split("\n")) {
    if (/^\s*```text\s*$/i.test(line)) {
      flushMarkdown()
      inTextFence = true
      continue
    }
    if (inTextFence && /^\s*```\s*$/.test(line)) {
      flushText()
      inTextFence = false
      continue
    }
    if (inTextFence) text.push(line)
    else markdown.push(line)
  }

  flushText()
  flushMarkdown()
  return separateGeneratedTextFromHeadings(segments)
}

export function visibleStyledPlanMarkdownLines(content: string) {
  return styledPlanMarkdownSegments(content).flatMap((segment) => segment.content.split("\n"))
}
