/**
 * Message threads (Anthropic beta `message-threads-2026-08-12`, docs/message-threads.md): the API keeps a conversation for a
 * few minutes, so a later request sends only what is new plus the id of the previous response. The history the engine
 * hands over stays the source of truth: every request is built in full first, and only when it extends the stored
 * conversation exactly (same fixed fields, same earlier messages, the stored reply next) is it cut down to its new messages.
 * Anything else (a compaction, an undo, a changed system prompt or tool list, the first image) starts a new thread.
 */

export const MESSAGE_THREADS_BETA = "message-threads-2026-08-12"
/** A thread expires 5 minutes after its last request; past this a continue would only come back as `thread_not_found`. */
const THREAD_IDLE_MS = 5 * 60_000 - 10_000
/** Threads and conversations remembered per provider; the oldest is forgotten past these. */
const MAX_THREADS = 64
const MAX_UNTHREADED = 256
/** A request with `thread` carries at most this many `cache_control` breakpoints; the create request's system and tool ones count again on every continue. */
const MAX_THREAD_BREAKPOINTS = 4
/** Fields that may change from one request of a thread to the next; every other one (system and tools included) must stay the same. */
const FREE_FIELDS = new Set(["messages", "max_tokens", "stop_sequences", "stream", "metadata", "service_tier"])
/** `error.details.unsupported` values that hold for the whole organization: no conversation of this provider tries a thread again. */
const ORGANIZATION_REFUSALS = new Set(["hipaa", "inference_hooks"])

type Body = Record<string, unknown>
type Block = Record<string, unknown>
type WireMessage = { role?: unknown; content?: unknown }

/** What the stream said at `message_stop`, enough to recognise the reply when it comes back in the next request. */
export type ThreadReply = { id: string; stop?: string | undefined; textLength: number; toolIds: string; fallback: boolean }

type ThreadState = { id: string; prefix: string; count: number; reply: string; images: boolean; at: number; replayed: boolean }

/** The bodies one request can be sent as, and what to remember once one of them is answered. */
export type ThreadPlan = {
  /** Only the new messages, with `thread: continue`; absent when this request cannot continue a stored thread. */
  continue?: Body
  /** The whole conversation with `thread: create` (the first request, or a replay). */
  create: Body
  /** Whether `create` replaces a thread this conversation already had. */
  replay: boolean
  /** The stored thread itself came from a replay: if continuing it fails again, the API cannot store this conversation. */
  afterReplay: boolean
  /** The response to `continue` (or to `create`, `replayed` when it followed a failed continue) finished: continue from its id next time. */
  record(sent: "continue" | "create", reply: ThreadReply, replayed: boolean): void
  /** This conversation goes without a thread from now on (the API cannot store it or refuses threads for it). */
  unthread(unsupported?: string): void
  /** The stored thread cannot be continued (a refusal, a reply the API did not store). */
  forget(): void
}

/** Anthropic's own API (where threads exist), not a gateway or proxy that speaks the same format. */
export function anthropicOwnHost(baseUrl: string | undefined) {
  if (!baseUrl) return true
  try {
    const parsed = new URL(baseUrl)
    return parsed.protocol === "https:" && parsed.hostname === "api.anthropic.com"
  } catch {
    return false
  }
}

const skipCacheControl =(key: string, value: unknown) => (key === "cache_control" ? undefined : value)
const hashOf = (text: string) => Bun.hash(text).toString(36)

function blocksOf(message: WireMessage): Block[] {
  return Array.isArray(message.content) ? (message.content as Block[]) : []
}

/**
 * An assistant message without its signed thinking blocks: the engine drops them from earlier turns when a new user turn starts
 * (the thread still holds them as the API stored them), so they do not decide whether the conversation still extends the thread.
 */
function withoutThinking(message: WireMessage): WireMessage {
  if (message.role !== "assistant" || !Array.isArray(message.content)) return message
  const blocks = message.content as Block[]
  if (!blocks.some((block) => block.type === "thinking" || block.type === "redacted_thinking")) return message
  return { ...message, content: blocks.filter((block) => block.type !== "thinking" && block.type !== "redacted_thinking") }
}

function carriesMedia(messages: readonly WireMessage[]) {
  return messages.some((message) => blocksOf(message).some((block) => block.type === "image" || block.type === "document"))
}

/** The assistant message as the reply's signature: its text length and its tool call ids (thinking blocks are left out). */
function replySignature(textLength: number, toolIds: string) {
  return `${textLength}:${toolIds}`
}

function wireReplySignature(message: WireMessage) {
  let textLength = 0
  const ids: string[] = []
  for (const block of blocksOf(message)) {
    if (block.type === "text" && typeof block.text === "string") textLength += block.text.length
    else if (block.type === "tool_use" && typeof block.id === "string") ids.push(block.id)
  }
  return replySignature(textLength, ids.join(","))
}

function breakpoints(blocks: unknown): number {
  if (!Array.isArray(blocks)) return 0
  return blocks.filter((block) => block && typeof block === "object" && (block as Block).cache_control).length
}

/** Drops message breakpoints past the limit, keeping the last ones (the newest turn is the one worth writing). */
function withinBreakpoints(messages: WireMessage[], fixed: number): WireMessage[] {
  let room = MAX_THREAD_BREAKPOINTS - fixed
  return messages.toReversed().map((message) => {
    if (!Array.isArray(message.content)) return message
    const content = (message.content as Block[]).toReversed().map((block) => {
      if (!block.cache_control) return block
      if (room-- > 0) return block
      const { cache_control: _dropped, ...rest } = block
      return rest
    }).toReversed()
    return { ...message, content }
  }).toReversed()
}

/** The thread error code of a refused request, read from the error text the HTTP layer kept. */
export function threadErrorCode(message: string): { code?: string; unsupported?: string } {
  const code = /"error_code"\s*:\s*"([a-z_]+)"/.exec(message)?.[1]
  const unsupported = /"unsupported"\s*:\s*"([a-z_]+)"/.exec(message)?.[1]
  return { ...(code ? { code } : {}), ...(unsupported ? { unsupported } : {}) }
}

/** One provider's threads, keyed by conversation and fixed fields. Nothing is allocated until a threaded request is planned. */
export function createMessageThreads(options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now
  let states: Map<string, ThreadState> | undefined
  let unthreaded: Set<string> | undefined
  let refusedEverywhere = false
  return {
    /** The ways to send `body` for `conversation`, or undefined when it goes without a thread. `betas` is the `anthropic-beta` value it is sent with (a fixed field). */
    plan(conversation: string, body: Body, betas: string): ThreadPlan | undefined {
      if (refusedEverywhere || unthreaded?.has(conversation)) return undefined
      if (!Array.isArray(body.messages) || body.context_management !== undefined || body.thread !== undefined) return undefined
      const messages = body.messages as WireMessage[]
      const fixed: Body = {}
      for (const [name, value] of Object.entries(body)) if (!FREE_FIELDS.has(name)) fixed[name] = value
      const key = `${conversation}\n${hashOf(`${betas}\n${JSON.stringify(fixed)}`)}`
      // Running hash of the conversation: prefixes[i] covers messages[0..i).
      const prefixes: string[] = [""]
      for (const message of messages) prefixes.push(hashOf(`${prefixes.at(-1)}\n${JSON.stringify(withoutThinking(message), skipCacheControl)}`))
      const stored = states?.get(key)
      const at = now()
      const fresh = stored && at - stored.at < THREAD_IDLE_MS ? stored : undefined
      let cut: WireMessage[] | undefined
      if (fresh && messages.length > fresh.count + 1 && prefixes[fresh.count] === fresh.prefix) {
        const reply = messages[fresh.count]!
        const next = messages.slice(fresh.count + 1)
        const sameReply = reply.role === "assistant" && wireReplySignature(reply) === fresh.reply
        // The first image or document of a conversation is something a stored thread may not take: a new thread instead.
        if (sameReply && next[0]?.role === "user" && (fresh.images || !carriesMedia(next))) cut = next
      }
      const remember = (state: ThreadState) => {
        states ??= new Map()
        states.delete(key)
        if (states.size >= MAX_THREADS) states.delete(states.keys().next().value!)
        states.set(key, state)
      }
      const plan: ThreadPlan = {
        create: { ...body, thread: { type: "create" } },
        replay: stored !== undefined,
        afterReplay: fresh?.replayed ?? false,
        record(sent, reply, replayed) {
          // Not stored by the API: a reply a fallback model wrote, or a tool call cut off by max_tokens. A refusal is not continued.
          if (reply.fallback || reply.stop === "refusal" || (reply.stop === "max_tokens" && reply.toolIds)) return plan.forget()
          remember({ id: reply.id, prefix: prefixes.at(-1)!, count: messages.length, reply: replySignature(reply.textLength, reply.toolIds), images: carriesMedia(messages), at, replayed: sent === "create" && replayed })
        },
        unthread(unsupported) {
          states?.delete(key)
          if (unsupported && ORGANIZATION_REFUSALS.has(unsupported)) refusedEverywhere = true
          unthreaded ??= new Set()
          if (unthreaded.size >= MAX_UNTHREADED) unthreaded.delete(unthreaded.values().next().value!)
          unthreaded.add(conversation)
        },
        forget() {
          states?.delete(key)
        },
      }
      if (cut && fresh) {
        const { system: _system, tools: _tools, ...rest } = body
        const fixedBreakpoints = breakpoints(body.system) + breakpoints(body.tools) + (body.cache_control ? 1 : 0)
        plan.continue = { ...rest, messages: withinBreakpoints(cut, fixedBreakpoints), thread: { type: "continue", previous_message_id: fresh.id } }
      }
      return plan
    },
    /** For tests: threads and conversations held. */
    size: () => ({ threads: states?.size ?? 0, unthreaded: unthreaded?.size ?? 0 }),
  }
}

export type MessageThreads = ReturnType<typeof createMessageThreads>
