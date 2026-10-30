# Compaction panel

Transcript storage refuses symlinked `session-transcripts` directories on every save. Writes use exclusive random
temporary files and atomic replacement, with owner-only permissions; cleanup skips symlinks and multiply linked files.

`/compact` keeps its existing behavior: queue a compaction behind active work.
`/compaction` opens the latest compaction's progress, folded memory and follow-up
scratchpad. It also reopens completed panels from loaded session history.

The transcript uses a bordered cockpit by default. `/customize` → Compaction
selects `auto|minimal|cockpit|quiet`, stage progress and the scratchpad. `auto`
uses quiet for raw presentation, minimal for minimal, and cockpit for MendCode.
The same keys (`compactionStyle`, `compactionProgress`, `compactionScratchpad`)
work through extension settings and `tui.change`.

While the memory is being written a live panel sits above the prompt
(`compactionPanel`, `/customize` → Compaction → Compaction panel):
`panel` (default: phase, stage bar, tokens before → after, elapsed), `stats`
(context against the window or threshold, cache read/write, trend, saved,
progress; only numbers the events reported), `arcade` (a random game of snake,
breakout or 2048), `scratchpad` (the project note, editable in the panel) and
`quiet` (one line). Under 70 columns the frame is dropped; a mode that does not
fit the terminal height gives way to a smaller one. The transcript keeps a one-row
marker until the compaction ends.

Arcade controls: Tab or a click focuses the game, arrows or wasd/hjkl move,
space starts or pauses, `r` restarts, `n` picks another game, Esc/q/Tab/ctrl+c
leaves. The prompt gets no key while the game has focus. Games advance on the
render loop's frames only while focused (one step per move key with reduced
motion) and are dropped, with their focus, when the compaction ends.

Page keys: `m` or Enter folds/opens memory, arrows scroll it, `[`/`]` selects an
older/newer compaction, Esc returns. While packing, `e` focuses the scratchpad.
Type directly there; Enter adds a newline, arrows and editor bindings move the
cursor, Ctrl+_ undoes, Ctrl+Y redoes, and bracketed paste preserves lines. Changes autosave;
Esc or Ctrl+C leaves editing. Long drafts wrap with a small scrollbar. Compact
terminals use one bordered column; wider terminals have progress beside memory
and a full-width scratchpad below. Hints stay in the page header.

`session.compaction.set` targets the active session/turn and saves up to 8,000
characters. `compaction.updated` persists reason, state, follow-up and queued
identity for replay. Only a native engine history replacement confirms `packed`:
the daemon queues the latest non-empty follow-up once, ahead of waiting work,
and executes it as a regular turn. Skipped, failed, cancelled or interrupted
compactions retain their draft without sending it. Completed panels are read-only;
remote read-only clients cannot change scratchpads. Pasted secrets use the same
capture/redaction boundary as regular prompts.

The native engine installs a checkpoint plus a bounded recent tail. Progress
reports the method, retained turns and estimated tokens; opaque provider items
never appear in events or frames. Other engines' no-op compaction reports `skipped`.
Older histories without lifecycle events remain viewable with their recorded
summary/status. Arcade, stars, snake and blocks await the B59 restoration decision.

## Summary template and resume (v1 behavior)

A portable compaction asks for the v1 sectioned summary (`prompts/compaction.md`, replaceable per project through
the `compaction` prompt): Goal, Current User Intent, Request Trace, Resume Anchor / Active Work, Blocked / Needs
User, Confirmed Done, Key Decisions, Optional Follow-ups, Critical Context, Commands / Evidence, Session State
Snapshot, Transcript Reference and Relevant Files. Beside the history the engine gives the summarizer evidence blocks
built locally from the session: the latest real user request (verbatim, capped), a language hint, image attachments
(names, sizes, nearby text), the latest assistant phase (unfinished tools mean the request is not done), a snapshot of
the retained tail, the current `todo` list, recent commands and outputs, `task` subagent outputs, the compaction
reason and a link to the full transcript. A second compaction updates the first summary instead of starting over.

- Replies that print tool calls are rejected; a local rescue summary is written from the evidence instead. The same
  rescue is used, without any provider call, when the summarization prompt would not fit the model's input window.
  Replies with all required headings lose any preface; other formats (custom prompts) are kept as written. An empty
  reply installs nothing. A request that repeats the session's last call is first given one retry as the compaction's own request
  ([the summary request](#the-summary-request-and-the-prompt-cache)).
- The installed summary message ends with an engine-written anchor (not model-written): the latest real user request
  when the retained tail does not carry it, and the open TODOs. A weak summary therefore cannot lose the request, its
  constraints or the active work. Next comes a short "How To Resume" note: continue unfinished work, optional
  follow-ups are not instructions, answer in the user's language. Native checkpoints carry neither (the opaque
  state and the tail hold the context).
- Up to ten of the newest images from the compacted turns (20 MB at most, none already in the tail) stay attached to
  the summary message.
- The transcript is written to `session-transcripts/<session>-g<generation>.md` in the daemon data directory (owner
  only, secrets redacted, 4 MiB per file, 128 MiB and 30 days overall) and referenced in the prompt; it is evidence
  for the model, read through the normal `read` permissions.
- Not ported: v1's `summary.ts` (per-session file additions/deletions from snapshots; it is not part of compaction, see [changes](changes.md));
  the v1 background-task registry block (v2 has no such registry: the `task` outputs in history are used).

## Engine configuration

`settings.set { patch: { compaction: { ... } } }` persists the v1 field names.
`settings.get` reads them; `null` resets the whole object. Typed clients expose
`compactionConfig()` and `setCompactionConfig(config | null)`.

| Field | Default / behavior |
| --- | --- |
| `auto` | `true`; `false` disables automatic checks and the compaction while idle, while `/compact` still works |
| `prune` | `true`; prune old successful tool outputs only once the context has reached 80 % of the compaction threshold (before that a prune saves nothing and costs an uncached re-read of everything after the first pruned result), and only when it saves over 20k tokens; protect 40k tool tokens, recent turns, skills and errors; original transcript stays intact. `false` never prunes |
| `tail_turns` | `2`; recent user turns with their assistant/tool results; `0` preserves none |
| `preserve_recent_tokens` | 25% of usable input, bounded to 2k–8k; `0` preserves none; oversized turns keep a safe suffix without orphan results |
| `reserved` | `min(20k, model output limit)`; subtracted from an explicit input limit for the tail budget; otherwise reserve the model output window |
| `threshold` | unset: 90 percent of the window, or earlier so `reserved` tokens stay free for the reply when the window is a shared context window (an `inputLimit` needs no reserve). Set, exactly that percent of the input/context window; clamped to 1–100 |
| `token_limit` | Absolute trigger, capped to the model input window; wins over percent |
| `strategy` | `portable`; `auto` uses native when supported; `native` refuses unsupported transports or a differing compaction role |
| `portable_mode` | `legacy`; `incremental` updates the accepted summary with new complete turns and recent intent evidence |
| `timeout_ms` | `300000`; 1000–300000; cancels provider work and rejects late results. A summary the model does not finish in time is written locally from the evidence instead, so the window never stays over its limit |
| `max_summary_tokens` | `4096` in incremental mode; configurable 512–8192 |
| `on_native_error` | `stop`; `portable` explicitly allows one portable fallback, excluding cancellation, stale state, unsupported routes and 401/403 |

Provider/model `compaction` overrides accept `threshold` and `token_limit`.
Precedence is model → provider → global. Existing `compactAtTokens` and
`MENDCODE_COMPACT_AT_TOKENS` remain absolute global triggers. Unknown windows
retain the 160k fallback. Provider model metadata can supply `inputLimit` and
`outputLimit` in addition to `context`.

### Where a session compacts, and how to read it

The compaction point is the first of these that is set, never above the window (a provider's `inputLimit` when it states one, else
the context window): `compaction.token_limit` on the model's entry in `providers.json`, the same on its provider's entry, the
daemon's `MENDCODE_COMPACT_AT_TOKENS`, `compactAt` of the model's [`modelContext`](#per-model-window-modelcontext), the
`compactAtTokens` setting, `compaction.token_limit`. With none set it is a percentage
of the window: `compaction.threshold` of the model's entry, of the provider's entry, then of the `compaction` setting. When none
states one, the point is 90% of the window or the window less `reserved` (20k, or the model's output limit when smaller), whichever
comes first: the next request still has room for its reply (Codex caps at 90%, pi keeps 16k free, opencode 20k or the output
limit). A model whose window nobody states compacts at 160,000 tokens. So a 500k model compacts at 450,000 with nothing set, a
128k one at 108,000, and a 500k model at 400,000 with `compactAtTokens` 400000.

The window is the session's own `/context-window`, else the model's `modelContext` window, else the model list's.

`mendcode context <sessionID>` opens with three lines that state it for one session, each number with its source (then
[how far the compaction is](#notice-before-a-compaction), and whether a [compaction while idle](#compaction-while-idle) is scheduled):

```text
model gpt-6.1-sol · context window 500,000 tokens (model list)
compacts at 450,000 tokens: 90% of the window (default; compactAtTokens not set)
context now 212,340 tokens, 45% of the compaction point (provider's count after the last call)
```

With `--json` the same is `limits`: `model`, `contextWindow` and `contextWindowSource` (`session` for a `/context-window`
override, `model-setting` for the model's `modelContext` window, `engine`, `catalog`, `unknown`), `maxContextWindow` (the most
the provider is known to serve for the model), `inputLimit`, `compactAtTokens` and `compactAtSource` (`model-override`,
`provider-override`, `environment`, `model-setting`, `compactAtTokens`, `compaction.token_limit`, `threshold`, `no-window-default`, `engine`,
`last-call`, `engine-managed`), `thresholdPercent` and `thresholdSource`, `capped`, `autoCompact`, `contextTokens` and
`contextTokensSource` (`last-call`, `estimate`). The compaction point is the engine's own answer for the session as it stands
(current settings, model and window override), so it is right for a session that has not run since the daemon started; the
`compactAt` of a `usage.recorded` event is what held at that call and is used only when the engine has no report (`last-call`).
The tokens are the provider's count after the last recorded call; after a compaction packed the history, or before any call,
they are an estimate of the current history. An engine that runs the whole session (Claude Code, Codex, pi, ACP) packs its own
context: `engine-managed`, with the window it reports.

`mendcode models [provider] --verbose` adds `compactAtTokens` to each model the native engine runs: where a session on it compacts
under the settings in force (its `modelContext` included), and shows `maxContextWindow` when the most the provider serves is
known and `contextSetting` (`{ window?, compactAt? }`) when the model has a `modelContext` entry. `mendcode docs compaction` prints the saved `compactAtTokens` and `compaction` values of a running daemon.

The user sets `compactAtTokens` in `/settings`, section Behavior, row `compact at` (a preset with the arrows, or a typed count
such as `450k`, 8,000 to 2,000,000; `default` clears it). The `compaction` object has no `/settings` row and no CLI command: a
client sets it with `settings.set`. No model tool writes either.

### Notice before a compaction

Feature `compact_notice` (balanced and full; off in minimalist and with no tier; `/tier compact_notice on|off`). When a model
call leaves the context at 80% of the compaction point, the transcript says so once, in one muted line:

```text
── compaction in 20K tokens · about 2 turns (10K a turn) · /compact to pack it now
```

- **Tokens** are the compaction point minus the provider's count after that call: the same two numbers the footer's context
  meter divides.
- **Turns** are the footer forecast's own number ([layout](layout.md)): the tokens left divided by the average growth per turn
  over the last turns (at most eight; a tool loop's many calls are one turn, and a fall of more than a tenth starts the series
  again). It is said only with at least three turns to go by, and never for a context that is not growing or has more than 99
  turns of room; otherwise the line has the tokens only. `next turn` means the next one is expected to cross the point.
- **`/compact`** packs now instead of at the point. The line does not say whether that compaction would read the prompt cache:
  the terminal cannot tell (it depends on the engine having the last request on record and on it fitting the model's input,
  [the summary request](#the-summary-request-and-the-prompt-cache)).

It is said once per crossing. A compaction arms it again, and so does a context that falls under three quarters of the
threshold without one (an engine that packed on its own, undone turns); a context that wobbles around the threshold, as when
old tool results are pruned from 80% on, does not repeat it. A session opened above the threshold shows the line at the first
call the terminal sees.

What it is measured against is what the call itself states, as the context meter reads it:

| The call states | The line |
|---|---|
| where MendCode packs (`compactAt`) | `compaction in 20K tokens · … · /compact to pack it now` |
| the same, with `compaction.auto` false | `20K tokens to the compaction point · … · automatic compaction is off · /compact to pack it` |
| the engine's own window (Claude Code, Codex, pi, ACP: they pack by themselves) | `20K tokens to the model window · … · the engine compacts it by itself` |
| neither (plan mode, a sub-agent's call, an engine that reports no context) | nothing |

Nothing is said either when automatic compaction is off and the point is only the 160,000 default of a model whose window
nobody states: there is nothing to predict.

The threshold is the `compactNoticePercent` setting: a percentage of that limit from 10 to 99 (default 80), or `"off"`. In
`/settings`, section Behavior, row `compact notice` cycles default, 50, 60, 70, 90 and off. It replaces the `context at 81% of
the compaction threshold` toast that `Limit notices` raised at 80% and 95%; that profile key now covers provider quota only.

`mendcode context <sessionID>` prints the same estimate as its fourth line whenever a context and a limit are known, whether or
not the threshold is reached, and says where the notice stands:

```text
compaction in 30,000 tokens · about 3 turns (10,000 a turn) · /compact to pack it now · notice at 80% (reached)
```

With `--json` it is `limits.forecast`: `limit` (`compaction` or `window`), `auto`, `tokensLeft`, `turns` and `perTurn` (absent
with fewer than three main turns since the last compaction), `noticePercent` (absent when the notice is off) and `noticeDue`.

## The summary request and the prompt cache

A compaction runs when the context is at its largest, so what its request costs depends on whether the provider reads the history
from its [prompt cache](prompt-cache.md). It does only when the request begins with the session's last request. A portable
compaction (`/compact`, automatic, while idle) therefore sends one of two requests (`compact` in `packages/engine-native/src/engine.ts`):

- **Shared**: the last main call's request again (tool list, hosted tools, system prompt, model, effort, parameters, the same prune
  decision, the history as that call sent it and whatever was appended since), then the summary prompt as one more user message,
  ending with `Do not call any tool: reply with the summary text only.` Everything the summary needs is in that message: the
  compaction prompt, the `/compact <instructions>` text, the evidence blocks and what a `compact.prompt` hook returns.
- **Own**: no tools, the system prompt built for the summary prompt, old tool output pruned, the model of the `compaction` role. On
  Anthropic and OpenAI it shares nothing with the cache and the whole history is read at the full input price. It is the smaller
  request.

The shared request is sent when all of these hold; otherwise the own request, as before:

| Condition | Otherwise (`cachedPrefixOff` in the item's meta, where one is reported) |
| --- | --- |
| the engine has the session's last main call on record: made since the daemon started, not a plan-mode call, no compaction since, not a compound session | not reported |
| `compaction.strategy` is not `native` (under `auto` the native checkpoint is still tried first; the portable summary that follows a refusal or an unsupported transport is shared) | not reported |
| the summariser is the main call's model: the `compaction` role resolves to exactly what `main` resolves to, or the model picked for this `/compact` is that model. A `compaction` role with its own model, effort or variant is the user's choice of another summariser and keeps its own request | not reported |
| the stored history still starts with the messages that call sent (nothing was edited, removed or snipped since) | `history-changed` |
| it fits: the last call's context (the provider's count: its request plus its reply; an estimate without one), plus what the history gained since, plus the prompt, is within the model's input limit; when only a context window is stated, the summary's `max_summary_tokens` (4,096 unset) must fit in it too | `too-large` |

Elapsed time is not a condition. After the cache has expired neither request reads anything from it, and the shared one is then
larger by the tool list and by the old tool output the own request would have pruned (nothing, far from the compaction point). A
lifetime guessed too short would give up the whole cached read instead, and most providers state none.

**A reply that is not a summary.** The tools are in the shared request only to keep the prefix. When the reply calls one (`tool-call`),
is empty (`empty`), prints tool calls as text (`tool-call-cosplay`), or the provider refuses the request (`error`), that card closes
as an error and the own request is sent once, in the same compaction; its reply goes through the usual checks and the local rescue
summary. A cancellation or the `timeout_ms` deadline ends the compaction instead. A compaction while idle is never retried: it
installs nothing.

**Does an automatic compaction fit?** It starts when a turn ends at or above the compaction point. By default that leaves
`reserved` (20k) or 10 % of the window, whichever is more: 20,000 tokens of a 128k or 200k window, 40,000 of 400k, 100,000 of 1M. Measured on synthetic coding
sessions with the packaged prompt, the summary prompt is about 2,800 tokens for a conversation without tools, 7,800 to 8,600 with
tool work and todos, 10,500 with four sub-agent results and 16,600 at the caps of every evidence block; the summary's room adds
4,096 where only a window is stated. So a working session needs about 12,000 to 15,000 free tokens (8,000 to 10,500 against a
stated input limit), before counting how far the last turn went past the point. With the default point that fits every window
from 128k up unless the last turn went several thousand tokens past it (a point set to 95 % does not fit a 128k or 200k window);
an automatic compaction that does not fit sends its own request (`too-large`), never the local rescue summary because of this.

**What differs for the summariser.** It reads the unpruned history and the main system prompt, and under `portable_mode:
incremental` the whole history rather than only the part before the retained tail. A `prompt.system` hook for the `compaction`
role is not called (the main call's result is repeated); `context`, `chat.params` and `chat.headers` hooks see the role `main`,
since they must return what they returned for that call. `compact.before`, `compact.prompt`, `compact.after`, `compaction.updated`
and the usage event (no `compactAt`, so it is not a main call for the meter or the idle timer) are as for the own request.

The item of a shared request carries `cachedPrefix: true` in its meta; `/compaction` then lists
`repeats the cached prefix` under the memory stage. Whether the provider did read from the cache is in the call's usage
(`cacheRead`). Tests: `packages/engine-native/test/idle-compaction-prefix.test.ts` (the three API shapes, byte for byte, for idle,
manual and automatic) and `shared-compaction.test.ts` (each condition, the fit boundary, the retry).

Not measured live: the cached read of a shared compaction on each provider; whether a prohibition such as `tool_choice: "none"`
can be added without changing the cached prefix (it is not sent: on some backends it is part of the prefix); whether the model
honours the no-tool instruction at 400k tokens of context.

## Compaction while idle

Feature `idle_compact`: on in the `full` tier, off in `balanced`, `minimalist` and with no tier; `/tier idle_compact on|off` switches
it in any tier (`features.idle_compact`). Code: `packages/daemon/src/idle-compaction.ts` (the timer and its conditions),
`packages/protocol/src/idle-compaction-data.ts` (lifetimes and constants), `compactIdle` in `packages/kernel/src/session-actor.ts`,
`compact` with `idle` in `packages/engine-native/src/engine.ts`.

A provider keeps a prompt prefix for a few minutes after the last call ([prompt cache](prompt-cache.md#cache-lifetime)). A large
session left idle past that pays the full input price for its whole context on the next message. One compaction just before the
cache expires reads the history at the cached price one last time and leaves a small context, so the expiry stops mattering. Nothing
is pinged to keep a cache warm: that costs without bound.

**Whether it pays.** With `C` tokens of context, an input price `p`, a cached-read price `r·p` (`r` is about 0.1 for Anthropic and
OpenAI) and a summary of `S` output tokens at price `o`: compacting now costs `C·r·p + S·o`; not compacting costs `C·p`, but only if a
message comes after the expiry. So it pays when the chance of such a message is above `r + S·o / (C·p)`. At 100,000 tokens with a
2,000-token summary and output five times the input price that is 0.1 + 0.1 = 20 %; at 400,000 tokens 12.5 %; at 20,000 tokens 60 %. The
price that does not show in the sum is the detail a compaction always drops. Hence the rule: only from 100,000 tokens (`idleCompactAtTokens`), where the
summary's own cost is small beside the re-read and a session is worth resuming.

It runs only when all of these hold; `mendcode context <sessionID>` names the first that does not:

| Condition | Otherwise (`reason`) |
| --- | --- |
| the feature is on | `feature-off` |
| `compaction.auto` is not `false` | `auto-off` |
| `compaction.strategy` is not `native` (whether the native compaction endpoint reads the prompt cache is not known) | `native-strategy` |
| MendCode packs the session's history: the native engine, not Claude Code, Codex, pi or an ACP agent | `engine-managed` |
| the session is not a sub-agent's or a workflow's own | `child-session` |
| the session's latest model call was a main call made since this daemon started (a plan-mode turn schedules nothing: its request is not one the compaction can repeat) | `no-call` |
| no compaction (automatic, manual or this one) since that call | `already-compacted` |
| the context after that call is at least `idleCompactAtTokens` (default 100,000) | `below-threshold` |
| somebody states how long the call's provider keeps a prefix | `unknown-lifetime` |
| the cache has not expired yet | `cache-expired` |
| the session is idle: no running turn, nothing queued, not paused, no pending approval or question, no running background or child task | `busy` |

It applies to every session the daemon holds, with or without a terminal attached: a session resumed tomorrow gains the most.

**When.** The timer is set at each main model call (`usage.recorded` with `compactAt`), for the provider's lifetime counted from when
the call was sent (the event's time minus the call's duration), minus a margin of 60 s (`IDLE_COMPACT_MARGIN_MS`) that covers the
compaction's own start-up; a lifetime under two minutes fires at its half. So a 5-minute cache compacts 4 minutes after the last call
was sent, and an Anthropic call written at the 1-hour lifetime (`promptCacheTtl: "1h"`, or the `wait_cache` feature;
[prompt cache](prompt-cache.md#the-anthropic-lifetime-promptcachettl)) 59 minutes after it: the lifetime is the one that call asked
for and got (`cacheTtl` on its `usage.recorded`), not the setting's value now. A message or a turn before that cancels it, and that turn's own call sets the next one; a turn that made no model call (a
`!command`) leaves the time as it was. It runs at most once per idle period, whether it packed, was skipped or failed. The timer lives
in the daemon's memory and does not keep the process alive: after a daemon restart nothing is scheduled until the session's next call.
When the timer runs at or after the expiry (the machine slept), the cache is gone and nothing is compacted.

**The call.** It is the [shared request](#the-summary-request-and-the-prompt-cache), on the main call's model whatever the
`compaction` role says, and always a portable summary. It differs from a manual or automatic compaction in one way: it is only worth
running when it reads the cache, so where they would send their own request (no call on record, a changed history, a request that
does not fit) it is skipped, and a reply that calls a tool or is empty installs nothing instead of being retried at the full price.

**What you see.** It is a compaction turn like `/compact`: a message sent while it runs waits in the queue behind it and starts when it
ends. Its `compaction.updated` events carry `reason: "auto"` and `idle: true`, and the card's muted line reads
`Compacted while idle, before the prompt cache expired`; `/compaction` reopens it like any other. `mendcode context <sessionID>` adds
a line for it after the limits, and `--json` the same as `limits.idleCompaction` (`scheduled`, `at`, `reason`, `atTokens`, `provider`,
`lifetimeMinutes`, `lifetimeSource`):

```text
idle compaction at 14:32:10: chatgpt keeps the prompt cache 5m after a call (assumed)
idle compaction not scheduled: context below 100,000 tokens
```

Settings: `idleCompactAtTokens` (8,000 to 2,000,000; `/settings`, Behavior, row `idle compact`, typed or by preset like `compact at`)
and `cacheLifetimeMinutes` (`{ "<provider id>": minutes }`, 1 to 1,440, `settings.set` only), which replaces a built-in lifetime
and gives one to a provider that has none.

Native is opt-in. The Responses adapter accepts the official API and the existing
Codex subscription transport, using the same credential headers and no new auth
store. [Standalone compaction](https://developers.openai.com/api/docs/guides/compaction)
returns canonical opaque items, capped at 4 MiB. Active and one previous generation
persist atomically with engine history. Replay requires the same public binding,
model, effort/options, system prompt and tool contract. Changes use the retained
local provider-neutral source instead; opaque state never goes to another model.
An empty, failed, cancelled, timed-out or stale result leaves history untouched.
Tests use local fakes only; the external native-provider canary is pending.

## `/files` and `/context-window` (C7)

`context.query` gains `files` (at most 100: `{ path, reads, edits, tokens }` for every file a read, edit, write, notebook or
patch call of a successful result left in the history, biggest first) and `contextWindowOverride`. `/files` opens `/context` on
its new Files tab (`3`; Tab cycles Sections, Largest and Files).

`session.context-window { sessionId, tokens | null, always? }` (`/context-window 200k`, `1m`, `128000`, `reset`) gives a session its own window, 1,000 to 10,000,000 tokens. It is stored in the daemon's small-facts
table, replaces the model's window and the provider's input limit in the compaction threshold (an absolute `token_limit` still
applies, capped by the window), and shows in `/context`. Without an argument the command reports the current window. A window
above the model's known maximum (`maxContextWindow`) is lowered to it and the reply says so; with no known maximum the window is
kept as asked and the reply says the provider may refuse one beyond what it serves.

### Per-model window (`modelContext`)

`/context-window 500k --always` (also `--always 500k`) makes the window permanent for the session's model: the daemon writes it
to the `modelContext` setting under the model's reference (what `mendcode models` prints, such as `chatgpt/gpt-6-astra`), through
the same validation as `settings.set`, clears this session's own window, and every session on that model, now and later, uses
it. `/context-window reset --always` removes the model's window (a `compactAt` beside it stays). Replies:

```text
context window: 500,000 tokens for every session on chatgpt/gpt-6-astra (saved in the modelContext setting; /context-window reset --always removes it)
context window: 872,000 tokens for every session on chatgpt/gpt-6-astra (saved in the modelContext setting; /context-window reset --always removes it) · 1,000,000 is above the most this model serves (872,000), so it was lowered to that
context window: chatgpt/gpt-6-astra is back to the model list's window for every session (modelContext window removed)
```

The setting is `modelContext: { "<provider>/<model>": { window?, compactAt? } }`, each 1,000 to 10,000,000 tokens and at least
one of the two, at most 200 models. `window` replaces the model list's window and the provider's input limit, lowered to the
model's known maximum; `compactAt` replaces `compactAtTokens` for that model (capped by the window). Precedence: the session's
`/context-window`, then `modelContext`, then the model list. A client can also write it with `settings.set` (the whole map: the
patch replaces the key). It has no `/settings` row: the page edits one value per row, while this is a map keyed by model, and
the model is known in a session, where `/context-window --always` sets it.

The ChatGPT subscription's catalog is MendCode's own list of the account's models ([connect](connect.md#where-each-list-comes-from)).
A model's maximum is that list's `max_context_window` when it states one, else the value OpenAI's own Codex catalog publishes (`codex-rs/models-manager/models.json`: `gpt-6-astra`
272,000 by default, 872,000 at most; Codex lets its config raise `context_window` up to `max_context_window`). Other models have
no known maximum. So GPT-6-Astra at 500k like GPT-6.1-Sol: in a session on it, `/context-window 500k --always`.

## The `snip` tool

`/experimental snip on` (setting `experimental.snip`, off by default) gives the model a `snip` tool to drop its own stale tool output without waiting for compaction. With no arguments it lists the tool results in context (call id, tool, size in tokens, what the call was; at most the 40 largest, oldest first). With `ids` it replaces those outputs by a one-line note (`[Output snipped by the assistant: <reason>; rerun the tool if it is needed again.]`) in the history sent from the next request on, and saves the history so later turns keep the note. Results of `skill`, `tool_search` and `snip` are kept; unknown or already dropped ids are reported back. A snipped `read` also forgets which instruction files it had loaded, so they can load again.

The transcript the person sees is unchanged, no permission is involved (it only edits the model's own context), and images a tool result produced stay in context. Snipping changes the prompt prefix, so the provider's prompt cache restarts from the first snipped result.

## Recall after a compaction (`auto_recall`)

`/experimental auto_recall on` (setting `experimental.auto_recall`, off by default) keeps a compaction from forgetting the detail its summary dropped. Native engine only. Once a compaction of the session has finished (`compaction.updated` with state `packed`), each new request is matched against the turns that compaction packed away: every earlier turn's request and answer, verbatim, from the session's own events (reverted turns and notices are left out). The best three matches (BM25 over their words; accents, case and common English and Spanish words ignored; a request of three words or more needs two of them in a turn) come back right after the request as a `session_search` result the transcript shows as "Recalled N earlier turns". Together they stay within 9,000 characters, each turn with its number and age and a note that the files it mentions may have changed. A turn still in the kept tail is not repeated, and a request that matches nothing adds nothing.

The result is appended after the new request, never written into earlier messages, so the prompt cache prefix is unchanged; the next calls of the turn read it from the cache. The packed-away turns are read once per compaction (a 180,000-event session took about 0.35 s) and kept in memory until the next one. Sub-agents, workflows and `noReply` messages get no recall. The model's own `session_search` and `session_read` tools (`/experimental session_recall on`) stay separate: they search on request, this works on every request without being asked.

Why: on a 210k-token session, questions about the part a compaction packed away were answered 38% right from the summary and recent turns, and 83% with the matching earlier turns brought back (92% with the whole context). One run, question answering rather than coding; the benchmark on coding tasks decides whether it becomes a default.
