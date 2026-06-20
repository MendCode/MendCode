export type StyledPlanMarkdownSegment = {
  kind: "markdown" | "text"
  content: string
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
  return segments
}

export function visibleStyledPlanMarkdownLines(content: string) {
  return styledPlanMarkdownSegments(content).flatMap((segment) => segment.content.split("\n"))
}
