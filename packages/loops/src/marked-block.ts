/**
 * The body after the last `marker` in a model's answer. Models format it as a fenced block
 * (```MARKER … ```), but also as **MARKER**, a heading or a bare line; all count. The body ends at a
 * closing fence, or at the end of the text.
 */
export function lastMarkedBlock(text: string, marker: string): string | undefined {
  const pattern = new RegExp(`^[ \\t>#*_\`~]*${marker}\\b[*_\`:\\s]*$`, "gm")
  const matches = [...text.matchAll(pattern)]
  const last = matches.at(-1)
  if (last?.index === undefined) return undefined
  const after = text.slice(last.index + last[0].length).replace(/^\r?\n/, "")
  const fence = /^\s*```/m.exec(after)
  return fence ? after.slice(0, fence.index) : after
}
