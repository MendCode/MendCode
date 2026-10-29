---
summary: how long Anthropic keeps the prompt cache: 5m or 1h, and Claude Code's
docs: prompt-cache, claude-code, compaction
aliases: ttl, cache-lifetime, one-hour-cache
---
For: "keep the Anthropic cache longer", "my cache expires while the tests run", "1h cache", "does Claude Code get the 1h cache".

Anthropic keeps a cached prompt prefix 5 minutes after the last call that read or wrote it, or 1 hour when the request asks for it. A 1h write costs 2x the input price, a 5m write 1.25x; a read costs a tenth of the input price or less either way. Native engine only, on the Anthropic API and Claude on Vertex; every other provider is left as it is.

The user sets it in /settings, Behavior, row "cache ttl" (or you propose it with mendcode_settings; it saves on the user's Apply): [[setting:promptCacheTtl]] 5m (default, every tier) | 1h. It is read at each call. A host that refuses the field gets the same call again without it, once, and that session stays at 5 minutes.

Full tier, while the row says 5m (the user's /tier wait_cache on|off): a session whose calls were twice more than 5 and at most 60 minutes apart (a long test run, a slow answer from the user) writes at 1h from the second such call on. A wait past an hour puts it back at 5m. It learns from waits already seen; nothing can know that the next reply will start a long command. Sub-agent calls inside a session learn on their own. A daemon restart forgets it.

Worth it when waits of 5 to 60 minutes repeat: each one then reads the prefix instead of rewriting it at 1.25x. One such wait after the switch repays the higher write price. Steady work that never pauses 5 minutes gains nothing from 1h and only pays more per write.

Compaction while idle follows the call: after one written at 1h it starts 59 minutes later instead of 4. {{program}} context "$MENDCODE_SESSION_ID" says when ({{program}} docs compaction).

Claude Code as the engine manages its own cache. /settings row "claude ttl" ([[setting:claudeCacheTtl]], off in every tier): with cache ttl at 1h, each new Claude Code process is started with CLAUDE_CODE_PROMPT_CACHE_TTL=1h and CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL=1h (Claude Code 2.1.242 or later). At 5m nothing is passed and Claude Code keeps its defaults: on a subscription the main conversation already gets an hour, its sub-agents 5 minutes.

How long it has left, full tier, off until placed ([[feature:cache_countdown]]; the user runs /footer +warm, or /tier cache_countdown on outside full): "cache 12m", "cache cold · next sends 161K" after; "~" when the lifetime is assumed (ChatGPT). Where expiries cost: /usage tab Waste, {{program}} stats --waste.

Not possible: a lifetime other than 5m or 1h; a longer lifetime on OpenAI, ChatGPT, Bedrock or any other provider; pings that keep a cache warm.
