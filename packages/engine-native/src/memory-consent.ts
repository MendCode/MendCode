/** Only the current, original user message can authorize one fact. Expanded context is never consent. */
export function explicitMemoryConsent(prompt: string, fact: string) {
  if (/\b(?:translate|traduce|example|ejemplo)\b|```/i.test(prompt)) return false
  if (/\b(?:do not|don't|never|no)\s+(?:remember|recuerda|recuerdes|guardar)\b/i.test(prompt)) return false
  if (!/\b(?:remember|recuerda|recuerde|acuérdate)\b/i.test(prompt)) return false
  const normalize = (text: string) => text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()
  const source = normalize(prompt)
  const text = normalize(fact)
  if (["not", "no", "never", "nunca", "don t"].some((word) => source.includes(`${word} ${text}`))) return false
  if (source.includes(text)) return true
  // A narrow bilingual identity form; other paraphrases continue to ask.
  const name = /^(?:the user s name is|the user is named|el usuario se llama|mi nombre es|me llamo) (.+)$/.exec(text)?.[1]
  return !!name && (source.includes(`me llamo ${name}`) || source.includes(`my name is ${name}`) || source.includes(`mi nombre es ${name}`))
}

/** Words that make a request a standing instruction or an explicit save, in English and Spanish. */
const DURABLE_MARKER = /\b(?:always|never|from now on|going forward|remember|i prefer|i like|by default|siempre|nunca|de ahora en adelante|a partir de ahora|recuerda|recuerde|prefiero|por defecto)\b/i
const STOP_WORDS = new Set(["the", "and", "for", "with", "that", "this", "una", "uno", "unos", "unas", "con", "del", "las", "los", "por", "para", "que", "dame", "user", "usuario"])

const words = (text: string) => new Set(text.normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 3 && !STOP_WORDS.has(word)))

/**
 * Whether `fact` only restates what the user asked for in this turn: at least half of its distinctive words (and three of
 * them) already appear in `request`, and the request has no standing-instruction marker. Such a "memory" is the current
 * task, not a durable fact, so it is asked about instead of saved silently. It never decides on intent beyond that overlap.
 */
export function restatesRequest(request: string, fact: string) {
  if (!request.trim() || DURABLE_MARKER.test(request)) return false
  const asked = words(request)
  const stated = [...words(fact)]
  if (stated.length === 0) return false
  const shared = stated.filter((word) => asked.has(word)).length
  return shared >= 3 && shared / stated.length >= 0.5
}

export function memoryWrite(name: string, args: unknown) {
  if (!["memory", "memory_graph", "remember"].includes(name)) return false
  const action = (args as { action?: string } | undefined)?.action
  return name === "remember" || ["add", "upsert_fact", "propose", "update", "delete", "link"].includes(action ?? "")
}
