# Prompt cache modes

The `promptCache` setting tells the native engine what cache hints to send with each model call: `legacy` (the default
when unset), `off` or `smart`. Ported from v1's cache policy (`provider/cache-policy.ts`), reduced to what v2's adapters can
honour. Code: `packages/engine-native/src/engine.ts` (`cacheKeyFor`), `anthropic-messages.ts`, `openai-responses.ts`;
`settings.set { patch: { promptCache: "smart" } }`, `null` resets. It is read at every call, so a change applies to the next
one.

| Mode | Cache key | Anthropic breakpoints |
|---|---|---|
| `legacy` | one per session (`<sessionId>`), sub-agent calls `<sessionId>/subagent` | system prompt, last user message |
| `off` | none | none |
| `smart` | one per **lineage** (session plus compaction generation); sub-agent calls `<lineage>/subagent` | tools (last tool), system prompt, the previous user message (where the last request put its breakpoint), last user message |

`legacy` is exactly what v2 sent before the setting existed, so an unset setting changes nothing.

## Lineage keys (`smart`)

A cache key only routes a request to the machine that probably holds its prefix. A compaction replaces the whole history
with one summary message, so every request after it has a different prefix than the ones before: its key should change
too, or the old routing keeps sending it where nothing is cached. The lineage key is `<sessionId>` until the first
compaction and `<sessionId>~<8 hex>` after it, where the hex is a hash of the summary message the history now starts with.
So the key:

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

A provider caches the longest prefix two requests share (Anthropic: tools, then system, then messages; OpenAI and Chat Completions
hosts: tools, then the messages with the system prompt first). A request should therefore begin with the whole previous request of its
lineage and only append. `packages/engine-native/test/prefix-stability.test.ts` records the exact request of every call of a
multi-step turn and of the next turn through the real adapters (a local fake host, no network) and fails when that stops
being true; `packages/daemon/test/prefix-modes.test.ts` does the same with the real prompt of each mode (`minimal`, `focus`,
`full`), tools, project instructions, skills and memory.

- The system prompt has no date, git status or per-call id. The one part ranked for the user's latest prompt is the memory block: it
  is the last part of the prompt in `focus` and `full` (`minimal` and `custom` already end with it), and it keeps the order in
  which its memories first appeared in the session, so a prompt that only reshuffles the ranking leaves the text as it was. A
  memory that newly enters the block still changes the text, and with it everything after: measured at the first turn change of a
  fixture with 36 memories, 90.2 % of the previous request was shared in `minimal`, 85.9 % in `focus` and 76.6 % in `full`
  (Responses; the other adapters within 1.3 points); 100 % after this change in all three.
- The tool list keeps one order. A tool found with `tool_search` is appended after `tool_search`, and the key stays the same
  (the `smart` key hashes the list only up to `tool_search`), so finding a tool does not move the request to another cache
  route. It does end the shared prefix: the tool list comes before the system prompt and the conversation, so the one call
  after a find reads all of those uncached, and the calls after it hit again
  (`packages/engine-native/test/cache-discovery.test.ts`). Seen on the ChatGPT backend: the call after a find read nothing
  from the cache, and the call after that read the whole prefix again.
  On the ChatGPT backend the list no longer grows: the search is the Responses API's client-executed tool search and a found
  tool is defined in the search result, at the tail of `input`, so the call after a find reads the prefix from the cache like
  any other ([tool discovery](tool-discovery.md#deferred-loading-on-the-chatgpt-backend), with the canary's numbers). Every
  other provider, and a ChatGPT session whose backend refused the shape, keeps the behaviour above.
  Switching a feature on or off or a tier change restarts the cache in the same way.
- The ChatGPT backend reports cache reads in steps: in the canary of 2026-10-12 (gpt-6.1-sol, 9 calls of 5.7 to 6.0 K input
  tokens) every non-zero read was a multiple of 128 tokens (5,504 or 5,760) and the last 133 to 187 tokens of a request
  that repeated the one before were still read uncached. A miss was always 0. So a hit is never 100 %, and a prefix
  shorter than one step cannot show a read at all (the smallest cacheable size was not measured).
- Messages of earlier turns are not edited far from the compaction threshold. Old tool results are pruned by the compaction
  rules only once the context has reached 80 % of that threshold (`pruneDue`, `compaction-policy.ts`), and a prune makes the
  provider read uncached everything from the first pruned result on. At a new user turn the signed reasoning of earlier assistant messages is dropped (engine.ts, `appendUser`),
  which changes the request from the first of those messages on for the adapters that replay it (Anthropic thinking, Gemini).

- A portable compaction (manual, automatic or while idle) repeats the session's last main request and appends its summary prompt,
  so the one call that reads the whole history reads it from the cache. It keeps its own request, which shares nothing with the
  cache (no tools, another system prompt, pruned history), when the `compaction` role has a model of its own, when the engine has no
  such call on record (after a daemon restart, after a plan-mode call), when the stored history was edited since, or when the
  repeated request would not fit the model's input: with the default compaction point (90 %, or the window less 20k) that happens
  only when the last turn went well past the point, and with a point set to 95 % it is the usual case on a 200k window ([the summary request](compaction.md#the-summary-request-and-the-prompt-cache), with the numbers).
  `packages/engine-native/test/idle-compaction-prefix.test.ts` holds the three adapters to a fully shared prefix for the three kinds.

The key is only the session id and, after a compaction, a hash of the summary that is already in the model's own history.
Dream, `/btw` and the provider connection test do not go through the engine, so the setting does not reach them: they send
no key, and on Anthropic the `legacy` breakpoints.

## Scoped policy (B49)

`Settings.cache` adds the v1 policy shape: `mode: off|smart`, `scope: session|project`, `projects` keyed by normalized
project paths, `sessions: { mode: all|selected|none, include, exclude }`, and `providers: { ID: { mode, scope, models,
exclude_models } }`. Model lists match exact IDs (including the provider-qualified or API ID and basename), never globs.
Global off, project off, session exclusions/selection, provider off and model exclusions win before any enable selector.
When multiple positive selectors apply, the order is global, project, provider/model, explicit session.

`cacheProjects` stores project-local policy layers in the daemon database. The active project layer overlays `cache`,
merging project/provider maps and session fields while replacing explicitly supplied arrays. No project config or user
home files are written. Unconfigured policies preserve the existing `promptCache` setting; smart scopes are opt-in.

```bash
mendcode --dir /tmp/mend-data cache status --format json
mendcode --dir /tmp/mend-data cache enable --scope project
mendcode --dir /tmp/mend-data cache enable --global --provider openai --model gpt-6-astra
mendcode --dir /tmp/mend-data cache disable --session ses_example
mendcode --dir /tmp/mend-data cache disable --global --project-path /work/private
```

`on`/`off` alias enable/disable. `--model` requires `--provider`; project targets require `--global` and cannot combine
with other targets; session targets cannot combine with provider/model. `--global` edits the data directory's policy;
without it only the current project is edited. Status accepts the same selectors and `--format text|json` / `--json`.
JSON uses the regular CLI envelope. Protocol commands are `cache.status` and `cache.set`; client helpers are
`cacheStatus` and `setCache`. Both require full-access remote peers because configuration can contain private paths/IDs.

For structured smart policies, managed keys are allowed only for authenticated OpenAI API Responses at
`https://api.openai.com/v1` and OpenRouter Chat Completions at `https://openrouter.ai/api/v1`. They hash the account,
endpoint, provider/model, project, system prompt, resolved tool definitions, model parameters, role and compaction
generation; session scope additionally hashes the session ID. No prompt or credential appears in a key. ChatGPT OAuth
keeps a session key even if project scope was requested. Unverified hosts receive no managed key and keep legacy
annotations. Off sends neither a key nor breakpoints. Policy is reevaluated at each model call, including tool loops.

The footer's `cache` segment and the opt-in `Cache notices` transcript lines (see `docs/customize.md`) read the cache
counters of each `usage.recorded` event. `thinkingDropped: true` on that event is set by the Anthropic adapter when the
call asked for reasoning but the tool loop could not carry it.

The separate Codex and Claude Code process engines manage their own caches; structured controls currently govern the
native engine only. Dream, side chat and connection probes still use their existing adapter defaults. Provider hit/TTL
guarantees and Claude SDK lineage controls require an external canary/adapter. No keepalive or TTL refresh is scheduled: a
ping per lifetime costs without bound. What exists instead is one compaction of a large idle session just before its cache
expires ([compaction while idle](compaction.md#compaction-while-idle), feature `idle_compact`, full tier).
Local-fake CLI frames: `bun scripts/render-frames.ts .agents-frames/B49 --b49 100x30 180x50`.

## Cache lifetime

How long a provider keeps a prefix after the last call that read or wrote it. Only the compaction while idle uses it
(`cacheLifetime`, `packages/protocol/src/idle-compaction-data.ts`; a manual or automatic compaction repeats the last request whatever
time has passed); the terminal's "cache miss · idle Nm, past the cache lifetime"
note uses the lifetime of the call before (five minutes, or an hour for a call written at `1h`). The only longer retention MendCode
asks for is Anthropic's `ttl: "1h"`, and only under [the lifetime setting](#the-anthropic-lifetime-promptcachettl) or
[after long waits](#a-longer-lifetime-after-long-waits-wait_cache) (no `prompt_cache_retention` is sent to OpenAI); an adapter that
starts to must change its constant here.

| Provider | Lifetime | Who states it |
|---|---|---|
| Anthropic API (provider type `anthropic`) | 5 minutes (`ANTHROPIC_CACHE_LIFETIME_MS`); 1 hour (`ANTHROPIC_CACHE_LIFETIME_1H_MS`) after a call that was answered with `ttl: "1h"` in its request (`cacheTtl: "1h"` on its `usage.recorded`) | Anthropic's documentation: `cache_control: { type: "ephemeral" }` without `ttl` is 5 minutes, with `ttl: "1h"` one hour, each refreshed by a read. Not measured here |
| Claude on Vertex (type `google-vertex-anthropic`) | unknown without `ttl`, as before; 1 hour after a call answered with `ttl: "1h"` | Anthropic's documentation lists Google Cloud among the platforms with the 1-hour duration. Not measured here |
| OpenAI API (type `openai` at `https://api.openai.com`) | 5 minutes (`OPENAI_CACHE_LIFETIME_MS`) | OpenAI's guide: 5 to 10 minutes of inactivity without `prompt_cache_retention`; the lower bound. Not measured here |
| ChatGPT subscription (`chatgpt`) | 5 minutes (`CHATGPT_CACHE_LIFETIME_MS`) | **An assumption** with one measured lower bound: on 2026-10-12 (gpt-6.1-sol, one sample) an identical request 4 min 30 s after the first read 5,376 of 5,562 input tokens from the cache. Nothing longer was sampled |
| Every other provider (OpenAI-style hosts that are not OpenAI, Chat Completions hosts, Gemini, Bedrock, Vertex, Copilot, ...) | unknown | Nobody: no compaction while idle for it, never at a guessed time |

`cacheLifetimeMinutes: { "<provider id>": minutes }` (`settings.set`) replaces a row or fills an unknown one. A lifetime that is too
long here is the costly mistake (the compaction then reads at the full price); too short only compacts earlier than needed.

To measure the ChatGPT backend (one live test, not run yet): in one session send a prompt of at least 6,000 tokens, then the identical
request again after N minutes of silence, and read `cacheRead` of the second `usage.recorded` (`mendcode context <sessionID>`). Repeat
with a fresh session per N (2, 4, 6, 9, 15, 30, 60): the largest N whose second call still reads the prefix is the lifetime; a zero
read at a short N is the route miss described below, so take two samples per N. Then set `CHATGPT_CACHE_LIFETIME_MS` and say here that it is measured.

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

**What the engine can know.** The `ttl` goes on the request whose *answer* starts the wait. The engine does not know, when it sends a
call, that the reply will run a twenty-minute test. What it does know is how long this session waited between its earlier calls. So the
rule learns: it never asks for `1h` "before" a long wait, it asks for it once the session has shown that it waits.

**The rule** (`nextWaitCache`, `packages/protocol/src/idle-compaction-data.ts`; state per session, in the daemon's memory):

1. A session starts at `5m`. The gap is measured between the starts of two consecutive calls of the same prefix (the session's own
   calls; the sub-agent calls made inside it are counted apart).
2. A gap of more than 5 minutes and at most 60 is a *long wait*. On the call after the second one (`WAIT_CACHE_AFTER`), the session
   writes at `1h`, and stays there through short gaps and through waits of up to an hour.
3. A gap of more than 60 minutes, which neither lifetime covers, returns it to `5m` and clears the count.

The lifetime only ever changes on a call whose cache has already expired (rule 2 switches after a gap longer than the 5 minutes in
force, rule 3 after one longer than the hour). That is deliberate: since Anthropic does not say whether a changed `ttl` on a warm
prefix reads the old entry, a switch on a warm call could cost a whole rewrite. On a cold call everything is rewritten anyway, and the
only difference is the write price. For the same reason there is no "drop back after N short gaps": that would switch while warm.

**Break-even**, with the documented multipliers (`P` = tokens of the prefix, read price `r` = 0.1):

| | at `5m` | at `1h` | difference |
|---|---|---|---|
| Each token written | 1.25 | 2.0 | `1h` costs 0.75 more per token written |
| A wait of 5 to 60 minutes | the prefix is rewritten: 1.25·P | the prefix is read: 0.1·P | `1h` saves 1.15·P per wait (1.2·P at `r` = 0.05, 1.225·P at 0.025) |
| The switching call (cold) | 1.25·P | 2.0·P | 0.75·P, once |
| A switch on a warm call, if entries are per lifetime | 0.1·P | 2.0·P | 1.9·P: two later waits to repay. Never done |

Every token written at `1h` is part of the prefix, so the whole premium since the switch is at most 0.75·P of the prefix at the next
wait, and one covered wait (1.15·P) repays it. So after the switch: **one more wait of 5 to 60 minutes and `1h` has paid; none
before the session ends or is compacted and it has cost up to 0.75 of what was written.** In expectation it pays when another such
wait is more likely than 0.75 / 1.15 = 65 % (62 % and 61 % with the cheaper reads). Two waits already seen are the evidence for that;
it remains a prediction, which is why the feature is off below the `full` tier. Steady work that never pauses 5 minutes never
switches and pays nothing.

Limits: the state is lost when the daemon restarts (the session relearns from two waits); a session at `1h` that then works for hours
without a pause keeps paying the higher write price until a wait past an hour; a refusal of the field (above) leaves the session at
the provider's 5 minutes whatever the rule says.

**Not run yet (needs an Anthropic API key):** one request with `ttl: "1h"` and no beta header, to confirm it is accepted and that
`usage.cache_creation.ephemeral_1h_input_tokens` counts the write; the same prefix read after 6 minutes; and a warm `5m` prefix
re-sent with `ttl: "1h"`, to see whether it is read or rewritten (the fact the rule is built around not knowing).

## Misses in the middle of a run

In the 36-run gpt-6-luna evaluation (480 calls after the first of a run), 30 calls had no cached tokens at all. 14 of 54 calls
that followed a cold call missed, against 16 of 391 that followed a warm one. The request did not change on those calls: tool
count, tool-schema estimate and instruction size are identical to the call before, the key is the session id (the ChatGPT backend
is `session` passive), the gap to the previous call is tens of milliseconds in every case, hits and misses alike, and a miss is
always zero, never a partial hit as a changed prefix would give. That points to the provider's cache route or write
propagation (the entry from the call just before is not readable yet, or the call landed on another replica), not to the
harness. It is not proven: the evaluation kept no request bodies. What the harness controls is the price of a miss, which is the
whole prefix: about 21 K tokens before the lean catalogue and about 3 to 4 K after it.
