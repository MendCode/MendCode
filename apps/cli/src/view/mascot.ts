import type { Line } from "../ui/theme"

// Official v1 ASCII art. Each character occupies one terminal cell.
function cleanAsciiLiteral(value: string) {
  const lines = value.replace(/^\n/, "").trimEnd().split("\n")
  const indentation = Math.min(
    ...lines.filter((line) => line.trim()).map((line) => line.match(/^\s*/)?.[0].length ?? 0),
  )
  return lines.map((line) => line.slice(indentation)).join("\n")
}

export const defaultHomeMascot = cleanAsciiLiteral(String.raw`
      .-.
     (o o)
    /|[+]|\
   /_|___|_\
      \_/
`)

export const defaultActivityMascotStates: Record<string, string> = {
  idle: String.raw`
  .-.
 (o o)
 /[+]\
`,
  thinking: String.raw`
  .-.
 (o -)
 /[+]\
`,
  planning: String.raw`
  .-.
 (o .)
 /[+]\
`,
  memory: String.raw`
   .-.
  (o m)
  /[+]\
`,
  compacting: String.raw`
   .-.
  (o c)
  /[+]\
`,
  reading: String.raw`
  .-.
 (o o)
 /[+]\
`,
  searching: String.raw`
  .-.
 (o ?)
 /[+]\
`,
  sending: String.raw`
  .-.
 (* *)
 /[+]\
`,
  patching: String.raw`
  .-.
 (o ^)
 /[+]\
`,
  editing: String.raw`
  .-.
 (o >)
 /[+]\
`,
  running: String.raw`
  .-.
 (o !)
 /[+]\
`,
  installing: String.raw`
  .-.
 ($ $)
 /[+]\
`,
  testing: String.raw`
  .-.
 (o T)
 /[+]\
`,
  subagents: String.raw`
  .-.
 (o S)
 /[+]\
`,
  browsing: String.raw`
  .-.
 (o @)
 /[+]\
`,
  retrying: String.raw`
  .-.
 (! !)
 /[+]\
`,
  blocked: String.raw`
  .-.
 (- -)
 /[+]\
`,
  done: String.raw`
  .-.
 (^ ^)
 /[+]\
`,
  error: String.raw`
  .-.
 (x x)
 /[+]\
`,
}

for (const [phase, text] of Object.entries(defaultActivityMascotStates)) {
  defaultActivityMascotStates[phase as keyof typeof defaultActivityMascotStates] = cleanAsciiLiteral(text)
}

export const defaultActivityMascotHover = cleanAsciiLiteral(String.raw`
  .-.
 (^ ^)
 /[+]\
`)

export function mascotRows(phase = "idle"): Line[] {
  return (phase === "hover" ? defaultActivityMascotHover : defaultActivityMascotStates[phase] ?? defaultActivityMascotStates.idle!).split("\n").map((text) => [{ text, fg: "text" }])
}

/** Live signals choose the same phase families as v1; stale tool history never overrides the current item. */
export function mascotPhase(input: { state: string; connected: boolean; retry: boolean; current?: { kind: string; tool?: string }; failed?: boolean }) {
  if (!input.connected || input.state === "waiting_approval" || input.state === "cancelling") return "blocked"
  if (input.retry) return "retrying"
  if (input.state === "idle") return input.failed ? "error" : "done"
  if (input.state === "compacting" || input.current?.kind === "compaction") return "compacting"
  if (input.current?.kind === "reasoning") return "thinking"
  if (input.current?.kind === "tool_call") {
    const tool = input.current.tool?.toLowerCase() ?? ""
    const phases: Array<[RegExp, string]> = [
      [/task|subagent/, "subagents"], [/memory|remember/, "memory"], [/web|fetch|browser|chrome/, "browsing"],
      [/install|pnpm|npm|bun/, "installing"], [/test|typecheck|lint|build/, "testing"], [/patch|diff/, "patching"],
      [/edit|write|update/, "editing"], [/read|open|cat/, "reading"], [/search|grep|glob|list/, "searching"],
      [/plan|spec|review/, "planning"],
    ]
    return phases.find(([pattern]) => pattern.test(tool))?.[1] ?? "running"
  }
  return "sending"
}
