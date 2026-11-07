Choose which cache hints the native engine sends with each model call using `promptCache`. Leave it unset for `legacy`, turn it `off`, or choose `smart` for lineage-aware hints.

## Prompt cache modes

1. Set smart mode with `settings.set { patch: { promptCache: "smart" } }`.
2. To reset the setting, use `null`.

The setting is read at every call, so a change applies to the next one. This policy is ported from v1's cache policy (`provider/cache-policy.ts`), reduced to what v2's adapters can honour.

### Mode reference

| Mode | Cache key | Anthropic breakpoints |
|---|---|---|
| `legacy` | one per session (`<sessionId>`), sub-agent calls `<sessionId>/subagent` | system prompt, last user message |
| `off` | none | none |
| `smart` | one per **lineage** (session plus compaction generation); sub-agent calls `<lineage>/subagent` | tools (last tool), system prompt, the previous user message (where the last request put its breakpoint), last user message |

`legacy` is exactly what v2 sent before the setting existed, so an unset setting changes nothing.

## Lineage keys (`smart`)

A cache key only routes a request to the machine that probably holds its prefix. A compaction replaces the whole history with one summary message, giving later requests a different prefix.

The key should change too, or the old routing keeps sending requests where nothing is cached.

| History | Lineage key |
|---|---|
| Before the first compaction | `<sessionId>` |
| After compaction | `<sessionId>~<8 hex>`, where the hex hashes the summary message the history now starts with |

The key:

- is stable for every call between two compactions (main, plan and compaction calls; the compaction call itself still
  shares the prefix of the lineage it summarizes, and uses its key);
- changes exactly when the prefix does;
- survives a daemon restart (it is derived from the stored history, not kept in memory).

A sub-agent keeps its own key (`/subagent`) in `legacy` and `smart`: its requests start from a different prompt (its own
task, tools and agent), so sharing the main conversation's key would only mix unrelated prefixes.

## What each provider honours

| Provider (adapter) | `legacy` | `off` | `smart` |
|---|---|---|---|
| ChatGPT subscription and OpenAI-style hosts (Responses adapter) | `prompt_cache_key` in the body and the `session_id` routing header | neither | the same, with the lineage key. A managed key (see "Scoped policy") names the tool list up to `tool_search`, which a Responses body lists as `mendcode_tool_search` |
| Anthropic API (Messages adapter) | `cache_control` on the system prompt and on the last content block of the last user message | none at all | also on the last tool, so the tool list stays cached when the system prompt after it changes (Anthropic's cache order is tools, system, messages; memory injected per prompt changes the system text), and on the last block of the user message before the last one. A lookup only checks about 20 blocks back from a breakpoint, and a step with parallel tool calls adds two blocks per call, so the new breakpoint can sit too far from what is cached; the second one is where the previous request put its own. All four breakpoints Anthropic allows |
| OpenAI-compatible hosts (Chat Completions adapter: OpenRouter, Ollama, gateways, DeepSeek, GLM/z.ai) | nothing | nothing | nothing: there is no common cache field, hosts that cache do it by prefix on their own and report it in usage. Read as cache reads: `prompt_tokens_details.cached_tokens` (OpenAI, GLM/z.ai, OpenRouter), `prompt_cache_hit_tokens` (DeepSeek, whose `prompt_cache_miss_tokens` is the uncached input) and TogetherAI's top-level `cached_tokens`; the first one that reports a read wins |
| Claude Code and Codex engines | ignored: they run their own processes and manage their own caching (Claude Code can be handed the 1-hour lifetime: `claudeCacheTtl`, [Claude Code](claude-code.md)) | ignored | ignored |

## What keeps the prefix whole

A provider caches the longest prefix two requests share. A request should therefore begin with the whole previous request of its lineage and only append.

| Provider | Prefix order |
|---|---|
| Anthropic | Tools, then system, then messages |
| OpenAI and Chat Completions hosts | Tools, then messages with the system prompt first |

### Prefix regression tests

`packages/engine-native/test/prefix-stability.test.ts` records the exact request of every call of a multi-step turn and of the next turn through the real adapters. It uses a local fake host, no network, and fails when the append-only rule stops being true.

`packages/daemon/test/prefix-modes.test.ts` does the same with the real prompt of each mode (`minimal`, `focus`, `full`), tools, project instructions, skills and memory.

### Stable memory and tool order

The system prompt has no date, git status or per-call id. The memory block is the one part ranked for your latest prompt.

It is the last part of the prompt in `focus` and `full`; `minimal` and `custom` already end with it. Memories keep the order in which they first appeared in the session, so reshuffling the ranking leaves the text unchanged.

A memory that newly enters the block still changes the text, and with it everything after. At the first turn change of a fixture with 36 memories, the shared portion of the previous request measured:

| Mode | Before | After this change |
|---|---|---|
| `minimal` | 90.2 % | 100 % |
| `focus` | 85.9 % | 100 % |
| `full` | 76.6 % | 100 % |

These are Responses measurements; the other adapters were within 1.3 points.
### Tool discovery and cache routes

The tool list keeps one order. A tool found with `tool_search` is appended after `tool_search`, and the key stays the same: the `smart` key hashes the list only up to `tool_search`.

Finding a tool does not move the request to another cache route, but it does end the shared prefix. The tool list comes before the system prompt and conversation, so the one call after a find reads all of those uncached; later calls hit again (`packages/engine-native/test/cache-discovery.test.ts`).

Seen on the ChatGPT backend: the call after a find read nothing from the cache, and the call after that read the whole prefix again.

On the ChatGPT backend the list no longer grows. Search is the Responses API's client-executed tool search, and a found tool is defined in the search result at the tail of `input`.

The call after a find therefore reads the prefix from the cache like any other ([tool discovery](tool-discovery.md#deferred-loading-on-the-chatgpt-backend), with the canary's numbers).

Every other provider, and a ChatGPT session whose backend refused the shape, keeps the earlier behavior. Switching a feature on or off or changing tier restarts the cache in the same way.

### Cache-read steps

The ChatGPT backend reports cache reads in steps. In the canary of 2026-10-12 (gpt-6.1-sol, 9 calls of 5.7 to 6.0 K input tokens), every non-zero read was a multiple of 128 tokens (5,504 or 5,760).

The last 133 to 187 tokens of a request that repeated the one before were still read uncached. A miss was always 0.

A hit is therefore never 100 %, and a prefix shorter than one step cannot show a read at all. The smallest cacheable size was not measured.

### Pruning and turn boundaries
Messages of earlier turns are not edited far from the compaction threshold. Old tool results are pruned only once context reaches 80 % of that threshold (`pruneDue`, `compaction-policy.ts`).

A prune makes the provider read uncached everything from the first pruned result on. The first request fixes which results a turn prunes (`turnPrunes`, engine.ts).

Crossing 80 % mid-turn, or adding a queued prompt or background notice that moves the "two latest user turns" protection, no longer rewrites a result already sent by that turn.

The next turn decides again. Only context within 5 % of the compaction point (`pruneUrgent`) prunes again inside a turn, because compaction costs more than one uncached read.

At a new user turn, signed reasoning of earlier assistant messages is dropped (engine.ts, `appendUser`). This changes the request from the first of those messages on for adapters that replay it: Anthropic thinking and Gemini.

The system prompt is built once per turn. `SystemContext.prompt` is the prompt the turn started with, not the latest user message, so a queued prompt or notice cannot pick other memories into the block.

The block sits before the whole conversation. In `smart` mode its text is part of the cache route, so changing it reads everything uncached from a new route.

### Compaction requests

A portable compaction (manual, automatic or while idle) repeats the session's last main request and appends its summary prompt. The one call that reads the whole history therefore reads it from the cache.

Compaction keeps its own request, sharing nothing with the cache (no tools, another system prompt, pruned history), when:

- The `compaction` role has a model of its own.
- The engine has no such call on record: after a daemon restart or plan-mode call.
- The stored history was edited since.
- The repeated request would not fit the model's input.

With the default compaction point (90 %, or the window less 20k), the last case happens only when the last turn went well past the point.

With a point set to 95 %, it is the usual case on a 200k window ([the summary request](compaction.md#the-summary-request-and-the-prompt-cache), with the numbers).

`packages/engine-native/test/idle-compaction-prefix.test.ts` holds the three adapters to a fully shared prefix for the three kinds.

### Calls outside the engine

The key is only the session id and, after a compaction, a hash of the summary already in the model's own history.

Dream, `/btw` and the provider connection test do not go through the engine, so the setting does not reach them. They send no key, and on Anthropic the `legacy` breakpoints.

Code: `packages/engine-native/src/engine.ts` (`cacheKeyFor`), `anthropic-messages.ts`, `openai-responses.ts`.

## Scoped policy (B49)

`Settings.cache` adds the v1 policy shape:

- Mode: `mode: off|smart`.
- Scope: `scope: session|project`.
- Projects: `projects` keyed by normalized project paths.
- Sessions: `sessions: { mode: all|selected|none, include, exclude }`.
- Providers: `providers: { ID: { mode, scope, models,
exclude_models } }`.

Model lists match exact IDs, including the provider-qualified or API ID and basename, never globs.

Global off, project off, session exclusions/selection, provider off and model exclusions win before any enable selector. When multiple positive selectors apply, the order is global, project, provider/model, explicit session.

`cacheProjects` stores project-local policy layers in the daemon database. The active project layer overlays `cache`, merging project/provider maps and session fields while replacing explicitly supplied arrays.

No project config or user home files are written. Unconfigured policies preserve the existing `promptCache` setting; smart scopes are opt-in.

### Change policy from the CLI

```bash
mendcode --dir /tmp/mend-data cache status --format json
mendcode --dir /tmp/mend-data cache enable --scope project
mendcode --dir /tmp/mend-data cache enable --global --provider openai --model gpt-6-astra
mendcode --dir /tmp/mend-data cache disable --session ses_example
mendcode --dir /tmp/mend-data cache disable --global --project-path /work/private
```

`on`/`off` alias enable/disable.

| Selector | Rule |
|---|---|
| `--model` | Requires `--provider` |
| Project targets | Require `--global`; cannot combine with other targets |
| Session targets | Cannot combine with provider/model |
| `--global` | Edits the data directory's policy; without it only the current project is edited |

Status accepts the same selectors and `--format text|json` / `--json`. JSON uses the regular CLI envelope.

Protocol commands are `cache.status` and `cache.set`; client helpers are `cacheStatus` and `setCache`. Both require full-access remote peers because configuration can contain private paths/IDs.

### Managed keys

For structured smart policies, managed keys are allowed only for:

- Authenticated OpenAI API Responses at `https://api.openai.com/v1`.
- OpenRouter Chat Completions at `https://openrouter.ai/api/v1`.

They hash the account, endpoint, provider/model, project, system prompt, resolved tool definitions, model parameters, role and compaction generation. Session scope additionally hashes the session ID.

No prompt or credential appears in a key. ChatGPT OAuth keeps a session key even if project scope was requested.

Unverified hosts receive no managed key and keep legacy annotations. Off sends neither a key nor breakpoints. Policy is reevaluated at each model call, including tool loops.

### Cache counters and scope limits

The footer's `cache` segment and opt-in `Cache notices` transcript lines (see `docs/customize.md`) read the cache counters of each `usage.recorded` event.

`thinkingDropped: true` on that event is set by the Anthropic adapter when the call asked for reasoning but the tool loop could not carry it.

The separate Codex and Claude Code process engines manage their own caches; structured controls currently govern the native engine only. Dream, side chat and connection probes still use their existing adapter defaults.

Provider hit/TTL guarantees and Claude SDK lineage controls require an external canary/adapter. No keepalive or TTL refresh is scheduled: a ping per lifetime costs without bound.

Instead, one compaction of a large idle session happens just before its cache expires ([compaction while idle](compaction.md#compaction-while-idle), feature `idle_compact`, full tier).

Local-fake CLI frames: `bun scripts/render-frames.ts .agents-frames/B49 --b49 100x30 180x50`.

## Cache lifetime

Cache lifetime is how long a provider keeps a prefix after the last call that read or wrote it.

Only compaction while idle uses it (`cacheLifetime`, `packages/protocol/src/idle-compaction-data.ts`). Manual or automatic compaction repeats the last request whatever time has passed.

The terminal's "cache miss · idle Nm, past the cache lifetime" note uses the lifetime of the call before: five minutes, or an hour for a call written at `1h`.

The only longer retention MendCode asks for is Anthropic's `ttl: "1h"`, under [the lifetime setting](#the-anthropic-lifetime-promptcachettl) or [after long waits](#a-longer-lifetime-after-long-waits-wait_cache).

No `prompt_cache_retention` is sent to OpenAI. An adapter that starts to send it must change its constant here.

### Provider lifetimes

| Provider | Lifetime | Who states it |
|---|---|---|
| Anthropic API (provider type `anthropic`) | 5 minutes (`ANTHROPIC_CACHE_LIFETIME_MS`); 1 hour (`ANTHROPIC_CACHE_LIFETIME_1H_MS`) after a call that was answered with `ttl: "1h"` in its request (`cacheTtl: "1h"` on its `usage.recorded`) | Anthropic's documentation: `cache_control: { type: "ephemeral" }` without `ttl` is 5 minutes, with `ttl: "1h"` one hour, each refreshed by a read. Not measured here |
| Claude on Vertex (type `google-vertex-anthropic`) | unknown without `ttl`, as before; 1 hour after a call answered with `ttl: "1h"` | Anthropic's documentation lists Google Cloud among the platforms with the 1-hour duration. Not measured here |
| OpenAI API (type `openai` at `https://api.openai.com`) | 5 minutes (`OPENAI_CACHE_LIFETIME_MS`) until a longer one is observed | OpenAI's guide (checked 2026-11-03): in-memory retention is typically 5 to 10 minutes of inactivity and up to an hour; the extended `24h` retention is the default for some models and organizations (GPT-5.5 accepts only `24h`) and typically lasts about 30 minutes of inactivity, up to 24 hours. MendCode does not send `prompt_cache_retention`, so which applies depends on the account: the lower bound is the fallback and the observed lifetime (below) replaces it when longer |
| ChatGPT subscription (`chatgpt`) | 5 minutes (`CHATGPT_CACHE_LIFETIME_MS`) until the observed lifetime exists | **An assumption** with one measured lower bound: on 2026-10-12 (gpt-6.1-sol, one sample) an identical request 4 min 30 s after the first read 5,376 of 5,562 input tokens from the cache. On 2026-11-03 the stored calls of the author's sessions (432 pairs of 2 minutes or more) read the cache in 83 to 100 % of the gaps up to 20 minutes, 61 % at 20 to 30 and mostly under a quarter past 3 hours: the observed lifetime was about 19 minutes. No retention of ten hours showed |
| Every other provider (OpenAI-style hosts that are not OpenAI, Chat Completions hosts, Gemini, Bedrock, Vertex, Copilot, ...) | unknown | Nobody: no compaction while idle for it, never at a guessed time |

`cacheLifetimeMinutes: { "<provider id>": minutes }` (`settings.set`) replaces a row or fills an unknown one. A lifetime that is too
long here is the costly mistake (the compaction then reads at the full price); too short only compacts earlier than needed.

### Observed lifetime

The table's values are fallbacks: providers change retention without notice. Compaction while idle follows what each response shows (`observedCacheLifetime`, `packages/protocol/src/idle-compaction-data.ts`).

Every main call following an earlier call of the same session is a sample. It records the gap and whether cached tokens covered at least half the previous prompt, showing the conversation's prefix was read; instructions and tools alone are cached across sessions.

These are not samples:

- Gaps under 2 minutes.
- Calls or previous calls whose prompt is under 4,096 tokens.
- Calls whose previous call was compacted away.
- Calls that changed provider or `ttl`.

Gaps are grouped: 1, 2, 3, 5, 7, 10, 15, 20, 30, 45, 60, 90, 120, 180, 240, 360, 720, 1,440 minutes.

A group with three or more samples is alive when at least 80 % read the cache. The lifetime is the longest gap that read the cache before the first group that mostly missed.

| Observed | Replaces |
|---|---|
| a lifetime longer than the fallback | the documented or assumed one |
| a lifetime seen ending (a later group missed), shorter or longer | the assumed one (ChatGPT) |
| nothing, or too few samples | nothing: the fallback stays |

The provider's lifetime is never replaced when the `cacheLifetimeMinutes` entry is set. A provider with no fallback only gets an observed one once it was seen ending.

Samples are read from stored calls of the last 14 days when the provider's first call is seen after the daemon starts. They grow with each call, 400 at most per provider and lifetime request.

`mendcode context <sessionID>` shows `observed` as the source.

**Note:** A session of 100,000 tokens or more is compacted before the lifetime in force ends, so it never shows what the cache does later.

Longer gaps come from smaller sessions, other sessions left alone, and stored history. A changed prefix (a rewound or edited history) counts as a miss.

### Measure the ChatGPT backend

This is one live test, not run yet:

1. In one session, send a prompt of at least 6,000 tokens.
2. Send the identical request again after N minutes of silence.
3. Read `cacheRead` of the second `usage.recorded` with `mendcode context <sessionID>`.
4. Repeat with a fresh session per N (2, 4, 6, 9, 15, 30, 60). Take two samples per N: a zero read at a short N is the route miss described below.
5. Use the largest N whose second call still reads the prefix as the lifetime. Set `CHATGPT_CACHE_LIFETIME_MS` and say here that it is measured.

### The Anthropic lifetime (`promptCacheTtl`)

`promptCacheTtl: "5m" | "1h"` (`/settings`, Behavior, row `cache ttl`; `settings.set`, `null` resets; `5m` when unset, in every tier).
It is read at each call. Code: `packages/daemon/src/cache-ttl.ts` (which lifetime a call asks for), `anthropic-messages.ts` (the wire).

- `5m` sends what was always sent: `cache_control: { "type": "ephemeral" }`, no `ttl`.
- `1h` sends `cache_control: { "type": "ephemeral", "ttl": "1h" }` on **every** breakpoint of the request (two in `legacy`, four in
  `smart`). No beta header is added: the documentation shows the field alone.
- It reaches the provider types that speak Anthropic Messages with `cache_control`: `anthropic` and `google-vertex-anthropic`.
  Bedrock is left alone: MendCode's Bedrock adapter sends no cache breakpoints at all. Copilot, GitLab and OpenCode Zen reuse the
  Messages adapter under other provider types and are not given the field. The Claude Code and Codex engines manage their own caches
  ([Claude Code](claude-code.md) has an opt-in pass-through, `claudeCacheTtl`).
- **A host that refuses the field** (HTTP 400): the same call is sent again without `ttl`, once. If that one is answered, the
  conversation (session and model) is remembered and sends no `ttl` from then on, until the daemon restarts; if it also fails, its own
  error is reported and nothing is remembered. There is no retry loop.
- The call's `usage.recorded` carries `cacheTtl: "1h"` only when the request that was answered had the field, so the
  [compaction while idle](compaction.md#compaction-while-idle) starts 59 minutes after such a call instead of 4, and goes back to 4
  after a call without it (`5m`, or a refusal).

What Anthropic documents ([prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), read 2026-10-12):

| Fact | Documented |
|---|---|
| Wire field | `"cache_control": { "type": "ephemeral", "ttl": "1h" }`; without `ttl` the lifetime is 5 minutes |
| Beta header | none in the section or its examples; the FAQ says prompt caching "no longer requires the beta prefix". Claude Code's own page says that through a gateway "part of the one-hour request travels in the `anthropic-beta` header": whether the public API still needs one for `ttl` is **not stated**, hence the fallback above and the live test below |
| Price | a 5-minute write is 1.25x the base input price, a 1-hour write 2x, a read 0.1x (0.05x on Opus 5.5 and Sonnet 5.5, 0.025x on Fable 5.1 and Mythos 5.1) |
| Refresh | "refreshed for no additional cost each time the cached content is used"; the lifetime counts from the start of the request that reads or writes the entry |
| Models | no per-model list for `1h`; the price table has a 1-hour write price for every model listed |
| Platforms | "available on the Claude API, Amazon Bedrock, Amazon Bedrock (Opus 4.6 and earlier), Claude Platform on AWS, Google Cloud, and Microsoft Foundry" |
| Two lifetimes in one request | allowed, but "cache entries with longer TTL must appear before shorter TTLs". MendCode never mixes them: one lifetime for all breakpoints of a request |
| A `5m` and a `1h` entry of one prefix | **not stated** whether they are the same entry. The billing rule counts reads from "the highest cache hit" whatever its lifetime, which suggests a read does not care; nothing says what a changed `ttl` on a warm breakpoint costs |

### A longer lifetime after long waits (`wait_cache`)

Feature `wait_cache`: on in the `full` tier, off otherwise (`/tier wait_cache on|off`), and ignored while `promptCacheTtl` is `1h`.
It has no setting of its own.

#### What the engine can know

The `ttl` goes on the request whose *answer* starts the wait. When sending a call, the engine does not know that the reply will run a twenty-minute test.

It knows how long this session waited between earlier calls. The rule learns: it never asks for `1h` "before" a long wait, but once the session has shown that it waits.

**The rule** (`nextWaitCache`, `packages/protocol/src/idle-compaction-data.ts`; state per session, in the daemon's memory):

1. A session starts at `5m`. The gap is measured between the starts of two consecutive calls of the same prefix (the session's own
   calls; the sub-agent calls made inside it are counted apart).
2. A gap of more than 5 minutes and at most 60 is a *long wait*. On the call after the second one (`WAIT_CACHE_AFTER`), the session
   writes at `1h`, and stays there through short gaps and through waits of up to an hour.
3. A gap of more than 60 minutes, which neither lifetime covers, returns it to `5m` and clears the count.

The lifetime only changes on a call whose cache has already expired: rule 2 switches after a gap longer than the 5 minutes in force, rule 3 after one longer than the hour.

Anthropic does not say whether changing `ttl` on a warm prefix reads the old entry. A switch on a warm call could therefore cost a whole rewrite.

On a cold call everything is rewritten anyway; only the write price differs. For the same reason there is no "drop back after N short gaps": that would switch while warm.

**Break-even**, with the documented multipliers (`P` = tokens of the prefix, read price `r` = 0.1):

| | at `5m` | at `1h` | difference |
|---|---|---|---|
| Each token written | 1.25 | 2.0 | `1h` costs 0.75 more per token written |
| A wait of 5 to 60 minutes | the prefix is rewritten: 1.25·P | the prefix is read: 0.1·P | `1h` saves 1.15·P per wait (1.2·P at `r` = 0.05, 1.225·P at 0.025) |
| The switching call (cold) | 1.25·P | 2.0·P | 0.75·P, once |
| A switch on a warm call, if entries are per lifetime | 0.1·P | 2.0·P | 1.9·P: two later waits to repay. Never done |

Every token written at `1h` is part of the prefix. The whole premium since the switch is at most 0.75·P of the prefix at the next wait; one covered wait (1.15·P) repays it.

After the switch:

- One more wait of 5 to 60 minutes and `1h` has paid.
- None before the session ends or is compacted, and it has cost up to 0.75 of what was written.

In expectation it pays when another such wait is more likely than 0.75 / 1.15 = 65 % (62 % and 61 % with the cheaper reads).

Two waits already seen are evidence for that prediction, not a guarantee. This is why the feature is off below the `full` tier. Steady work that never pauses 5 minutes never switches and pays nothing.

#### Limits and pending live test

- State is lost when the daemon restarts; the session relearns from two waits.
- A session at `1h` that works for hours without a pause keeps paying the higher write price until a wait past an hour.
- A refusal of the field, described above, leaves the session at the provider's 5 minutes whatever the rule says.

**Not run yet (needs an Anthropic API key):** one request with `ttl: "1h"` and no beta header, to confirm it is accepted and that
`usage.cache_creation.ephemeral_1h_input_tokens` counts the write; the same prefix read after 6 minutes; and a warm `5m` prefix
re-sent with `ttl: "1h"`, to see whether it is read or rewritten (the fact the rule is built around not knowing).

## Misses in the middle of a run

In the 36-run gpt-6-luna evaluation (480 calls after the first of a run), 30 calls had no cached tokens at all.

| Previous call | Misses | Calls |
|---|---|---|
| Cold | 14 | 54 |
| Warm | 16 | 391 |

The request did not change on those calls by the available measures:

- Tool count, tool-schema estimate and instruction size were identical to the call before.
- The key was the session id; the ChatGPT backend is `session` passive.
- The gap was tens of milliseconds in every case, hits and misses alike.
- A miss was always zero, never a partial hit as a changed prefix would give.

This points to the provider's cache route or write propagation, not the harness: the previous entry may not yet be readable, or the call may have landed on another replica.

It is not proven; the evaluation kept no request bodies. The harness controls the price of a miss: the whole prefix, about 21 K tokens before the lean catalogue and about 3 to 4 K after it.

### Finding where a request stopped repeating the one before

Run the daemon with `MENDCODE_DEBUG_PROMPT_PREFIX=1` (off by default, no cost when off) and every provider request of the native
engine writes one line to the daemon log (the terminal's log file when it hosts the daemon, stderr otherwise):

```
[PROMPT-PREFIX]: session=ses_... role=main turn=trn_... call=7 instructions=9c1f02aa tools=51d3e7b0 route=0be2a4c1 items=23 change=item[4] hashes=...
```

The hashes are 8 hex digits of SHA-1 of the instructions (or `system`), tool list, cache route and each serialised input item.

Items are named `input`, `messages` or `contents`, as in the request body after plugins ran. The line contains no prompt text, tool output or key.

`change` compares with the previous request of the same session and role, in the order a prefix cache reads them:

| Value | Meaning |
|---|---|
| `first` | No earlier request to compare |
| `same` | Same observed prefix |
| `append` | New request only added items; the observed prefix is intact |
| List of `tools`, `instructions`, `route`, `item[k]` and `shrunk@n` | Changed prefix components; `item[k]` is the first differing input item, where a provider starts re-reading |

A miss (`cacheRead` near zero after a call of more than 10 K tokens) with `tools`, `instructions`, `route`, `item[k]` or `shrunk@n` shows a client-side prefix change. `same` and `append` do not.

An `append` or `same` miss with stable model, transport and other request parameters points to provider-side cache behavior. Hashes alone cannot identify routing, propagation or eviction as its cause.

Code: `prompt-trace.ts`. `test/prune-prefix.test.ts` and `test/turn-system-prefix.test.ts` run the engine against a fake Responses host and assert the append-only rule inside a turn.

### In-turn misses measured on one ChatGPT account (2026-11-01)

108 ChatGPT provider calls missed: the previous call was under 5 minutes earlier and over 10 K tokens, and the next read under 10 % of it. Of these, 67 were between two calls of one turn.

By what the request log can show without bodies:

| Observation | Count or share |
|---|---|
| Misses following `tool_search` | 12; 11 % of the 110 calls that did, against about 1 % of the others |
| Misses in sessions at 80 % of the compaction point, where the prune moved | About 14 to 21 |
| Prefix total falling by 40 to 60 % between two calls of one turn | 11 times; the same turn missed again each time a queued prompt joined |

The prune-and-join group described above was fixed by freezing the turn's prune set.

Repeated `tool_search` calls also used to change an earlier item (`searchLoads`, tool-discovery.md): the earlier answer lost the definition the later one carried.

The adapter now assigns definitions in forward history order, keeping each in its first successful search result. It appends an already-loaded notice to a repeated find.

An overlapping search loads new tools and acknowledges those already loaded. Failed searches never claim to load tools.

The remaining roughly 35 to 45 misses are unresolved. Without per-call prefix traces, attributing them to the provider is a hypothesis, not a measurement that the prefix stayed identical.

### Repeated-search regression and live canary (2026-11-01)

On baseline `e185314e`, four regression cases failed: first-search ownership, byte-for-byte preservation across repeated searches,
and complete engine tool loops in both `legacy` and `smart` cache modes. After the fix they pass. The mixed/failed/empty search
cases preserve prior input items, and the tool still executes after repeated discovery. Separate checks cover Responses function
fallback, Anthropic, Chat Completions and Gemini receipts; these formats keep their existing behavior.

#### Run the canary

`bun scripts/prompt-cache-canary.ts --live before|after [--dir <MendCode data directory>]` runs a single in-memory turn with the real engine and Responses adapter on `gpt-6-luna`, effort `low`.

The turn uses a stable prefix over 2 K tokens, search, repeated search, two deterministic tool calls, then a short answer. It prints `PROMPT-PREFIX` lines and returned input/cached/output usage.

Run the same script on each revision with its matching label; the label does not emulate the old code.

- At most six HTTP requests; aborts on an error.
- No daemon or database.
- Only a valid MendCode-owned subscription-backend login; refuses refresh and never falls back to another application's credentials.

The plan API route does not currently enable client-executed tool search.

#### Live verification status

Live verification is **blocked** in this run: MendCode's own credential loader returned `state: none` for the default data directory. No provider requests were made and no cache-token measurements were obtained.

A valid MendCode-owned subscription-backend login, or its actual data-directory location, is required for the before/after comparison within those credential boundaries.

No provider-side misses were established by this local regression; historical unexplained misses remain unresolved.
