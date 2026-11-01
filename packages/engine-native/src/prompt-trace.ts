import { createHash } from "node:crypto"

/**
 * The prompt-prefix diagnostic (`MENDCODE_DEBUG_PROMPT_PREFIX=1`, docs/prompt-cache.md): one log line per provider request with hashes of
 * the instructions, the tool list, the cache route and every input item, and where the request first differs from the previous one of the same
 * session and role. A provider caches by prefix, so the first difference is where an uncached read starts. No content, only 8-hex hashes.
 */
export type PromptTrace = (request: { sessionId: string; role: string; turnId?: string | undefined; route?: string | undefined; body: Record<string, unknown> }) => void

const hash = (value: unknown) => createHash("sha1").update(typeof value === "string" ? value : JSON.stringify(value) ?? "").digest("hex").slice(0, 8)
/** Requests remembered (one per session and role); the oldest is forgotten past this many. */
const REMEMBERED = 64
/** Item hashes written per line; a longer request writes its first difference and the newest items. */
const MAX_LISTED = 400

type Shape = { instructions: string; tools: string; route: string; items: string[] }

/** The parts of a request body in the way every adapter names them: the Responses `input`, Chat Completions and Anthropic `messages`, Gemini `contents`. */
function shapeOf(body: Record<string, unknown>, route: string | undefined): Shape {
  const items = body.input ?? body.messages ?? body.contents
  return {
    instructions: hash(body.instructions ?? body.system ?? body.systemInstruction ?? ""),
    tools: hash(body.tools ?? []),
    route: hash(route ?? body.prompt_cache_key ?? ""),
    items: Array.isArray(items) ? items.map(hash) : [],
  }
}

/** How a request differs from the previous one of its lineage, in the order a prefix cache reads them: tools, instructions, route, then the items. */
export function describeChange(before: Shape | undefined, now: Shape) {
  if (!before) return "first"
  const changed = [before.tools !== now.tools ? "tools" : "", before.instructions !== now.instructions ? "instructions" : "", before.route !== now.route ? "route" : ""].filter(Boolean)
  const shared = Math.min(before.items.length, now.items.length)
  let at = 0
  while (at < shared && before.items[at] === now.items[at]) at++
  if (at < shared) changed.push(`item[${at}]`)
  else if (now.items.length < before.items.length) changed.push(`shrunk@${now.items.length}`)
  return changed.length ? changed.join("+") : now.items.length === before.items.length ? "same" : "append"
}

export function createPromptTrace(write: (line: string) => void): PromptTrace {
  const previous = new Map<string, Shape>()
  const calls = new Map<string, number>()
  return ({ sessionId, role, turnId, route, body }) => {
    const key = `${sessionId}\n${role}`
    const now = shapeOf(body, route)
    const change = describeChange(previous.get(key), now)
    const number = (calls.get(key) ?? 0) + 1
    previous.delete(key)
    previous.set(key, now)
    calls.set(key, number)
    if (previous.size > REMEMBERED) {
      const oldest = previous.keys().next().value!
      previous.delete(oldest)
      calls.delete(oldest)
    }
    const listed = now.items.length > MAX_LISTED ? now.items.slice(-MAX_LISTED) : now.items
    write(`[PROMPT-PREFIX]: session=${sessionId} role=${role}${turnId ? ` turn=${turnId}` : ""} call=${number} instructions=${now.instructions} tools=${now.tools} route=${now.route} items=${now.items.length} change=${change}${now.items.length > MAX_LISTED ? ` hashes(last ${MAX_LISTED})=` : " hashes="}${listed.join(",")}`)
  }
}
