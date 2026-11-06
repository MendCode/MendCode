# Claude message threads

With an Anthropic API key, the native engine keeps each conversation in a **message thread** (Anthropic beta
`message-threads-2026-08-12`): the API holds the conversation for a few minutes, so each later request sends only its new
messages and the id of the previous response instead of the whole history. The price and the rate limits are the same;
the wait for the first token is shorter in long conversations, because the API no longer reads the whole history again.
Source: [Anthropic, Message threads](https://platform.claude.com/docs/en/build-with-claude/message-threads).

Feature `message_threads`, in every tier (minimalist included); no call, tool or prompt text of its own. Code:
`packages/engine-native/src/anthropic-threads.ts`, used by `anthropic-messages.ts`.

## When a thread is used

- The provider is Anthropic's own API (`https://api.anthropic.com`) with an API key. A gateway or proxy that speaks the
  same format, Claude on Vertex or Bedrock, a bearer login from a plugin, and the Claude Code engine never use one (the
  `claude` binary manages its own requests).
- The feature is on (`/tier message_threads off`, or `features.message_threads: false`, turns it off), safe mode is off,
  and `zeroDataRetention` is not set.

## What it sends

Every request is built in full first, as without a thread; the history MendCode stores stays the source of truth.

- **New thread** (`thread: {"type": "create"}`): the whole request, system prompt and tools included.
- **Continue** (`thread: {"type": "continue", "previous_message_id": …}`): only when the request extends the stored
  thread exactly: the same model, system prompt, tools, thinking and other fixed fields; the same earlier messages; the
  answer the thread stored next; then at least one new user message (your next prompt or the tool results). Only those
  new messages are sent, without the system prompt and tools. A thread is continued only from an answer that reached
  `message_stop`.
- **A new thread instead of a continue** after a compaction, an undo or a retraction (the history no longer starts with
  the thread), a changed system prompt or tool list (`tool_search` adding tools), a changed model or effort, the first
  image or document of a conversation, a refusal, an answer that ended in a tool call cut off by `max_tokens`, and a thread
  idle for about 5 minutes (the API keeps it 5 minutes after its last request).
- **Cache breakpoints** are placed as without a thread ([prompt cache](prompt-cache.md)); a continue keeps at most four,
  counting the system prompt and tool breakpoints of the request that created the thread.

## When the API cannot continue

- `404 thread_not_found`, or any other thread error on a continue (`thread_already_continued`,
  `thread_continue_in_flight`, a 400 without a code): the whole conversation is sent again in a new thread, at once.
- Not found again right after such a replay (a conversation the API cannot store), or `thread_unsupported_request`: the
  request goes without a thread, and so does that conversation from then on. When the API says the organization cannot use
  threads (HIPAA readiness, Inference hooks), no conversation of that provider tries again until the daemon restarts.

These refusals come before the model runs: they use no tokens.

## Zero data retention

Message threads are not eligible for zero data retention: the API holds a thread in memory (encrypted, never written to
durable storage) and deletes it no more than an hour after its last use. If your organization requires ZDR, set
`zeroDataRetention: true` (`settings.set { patch: { zeroDataRetention: true } }`) and no request uses a thread.

## Weight

Nothing at start: a provider allocates its thread table on the first threaded request. It remembers at most 64 threads
(an id, two short hashes and a few numbers each) and 256 conversations without one; the oldest are forgotten first. Each
request hashes the messages it would send, the same bytes it would otherwise upload.
