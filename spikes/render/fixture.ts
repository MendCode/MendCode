// Deterministic transcript + token stream shared by every variant of the render spike.
export type Message = { role: "user" | "assistant" | "tool"; text: string }

function rng(seed: number) {
  let s = seed >>> 0
  return () => ((s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0) / 4294967296)
}

const WORDS = "the queue actor turn event store blob daemon client render stream token session compaction memory usage quota scope timer".split(" ")

export function fixture(count = 10_000): Message[] {
  const r = rng(7)
  const out: Message[] = []
  for (let i = 0; i < count; i++) {
    const role = i % 3 === 0 ? "user" : i % 3 === 1 ? "assistant" : "tool"
    const words = 8 + Math.floor(r() * (role === "assistant" ? 120 : 30))
    let text = Array.from({ length: words }, () => WORDS[Math.floor(r() * WORDS.length)]).join(" ")
    if (role === "tool") text = `$ bun test\n${Array.from({ length: 1 + Math.floor(r() * 6) }, (_, k) => `  line ${k}: ${text.slice(0, 60)}`).join("\n")}`
    out.push({ role, text: `${role === "user" ? "❭ " : role === "tool" ? "⚙ " : ""}${text}` })
  }
  return out
}

/** Calls `onToken` 50 times per second until `seconds` elapse, then resolves. */
export function streamTokens(onToken: (token: string) => void, seconds = 60) {
  const r = rng(11)
  return new Promise<void>((resolve) => {
    const start = Date.now()
    const timer = setInterval(() => {
      onToken(`${WORDS[Math.floor(r() * WORDS.length)]} `)
      if (Date.now() - start >= seconds * 1000) {
        clearInterval(timer)
        resolve()
      }
    }, 20)
  })
}

/** Word-wraps text to `width` columns. */
export function wrap(text: string, width: number): string[] {
  const lines: string[] = []
  for (const raw of text.split("\n")) {
    let line = ""
    for (const word of raw.split(" ")) {
      if (line.length + word.length + 1 > width && line) {
        lines.push(line)
        line = word
      } else line = line ? `${line} ${word}` : word
    }
    lines.push(line)
  }
  return lines
}
