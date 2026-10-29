---
summary: context getting full: compaction, snip, context window, prompt cache
docs: compaction, prompt-cache, usage-limit
aliases: compact, context-full, summarize, snip, window, cache, prompt-cache, memory-full
---
For: "the context is filling up", "why did it forget", "when does it compact".

Read numbers, never guess: {{program}} context "$MENDCODE_SESSION_ID" (--json: limits) prints the model, window and its source, where it compacts and why, tokens in context. {{program}} models [provider] --verbose: contextWindow, maxContextWindow, compactAtTokens.

Window: the session's /context-window 200k|1m|128000|reset (1,000 to 10,000,000), else the model's [[setting:modelContext]], else the model list. For every session on the model: /context-window 500k --always (reset --always), never above its known maximum ({{program}} docs models).
Compaction point, the first set, never above the window: compaction.token_limit of the model's or provider's providers.json entry; MENDCODE_COMPACT_AT_TOKENS of the daemon; compactAt of modelContext; [[setting:compactAtTokens]] (8,000 to 2,000,000); token_limit of [[setting:compaction]]. None set: threshold percent of the window (default 95). No window stated: 160,000.
Claude Code (claude_compact, balanced): compacts at that point, else 200k; /compact runs its own.
For every session: /settings, Behavior, row "compact at" (450k; "default" clears), or propose {"compactAtTokens":450000} with mendcode_settings. compaction { auto (false: only /compact), threshold, token_limit, tail_turns, prune, strategy, ... } has no row.
While idle (full tier; /tier idle_compact on|off): a native session of [[setting:idleCompactAtTokens]] tokens or more (default 100000; /settings row "idle compact") compacts once just before the provider's prompt cache expires; the context command says when or why not. Other providers: [[setting:cacheLifetimeMinutes]] {id: minutes}.
Notice (/tier compact_notice off): at [[setting:compactNoticePercent]] percent of the point (80; "off"; /settings row "compact notice") the transcript says once the tokens and turns left.

The user types: /compact queues a compaction behind running work. /compaction reopens the latest: progress, written memory, a note run once after. /context shows what fills the window; /files lists the files in context. Near a usage limit a checkpoint is saved (/tier limit_checkpoint off); /limit resumes ({{program}} docs usage).

What survives: a checkpoint summary (goal, request, decisions, files, commands, todos) plus the last turns; the transcript stays in /timeline and /export. What it dropped: re-read the file or ask, never guess; with /experimental auto_recall on, matching earlier turns return verbatim after each request. [[setting:handoffTokenCap]]: earlier conversation another engine gets after a switch (16000; 0 off).

Model tool: snip (/experimental snip on): alone it lists the largest tool outputs; with ids it replaces them by a note; the cache restarts from the first.

Prompt cache: [[setting:promptCache]] legacy (default) | off | smart (a key per compaction lineage); [[setting:cache]] and [[setting:cacheProjects]] narrow it by project, session, provider. A compaction changes the prefix: the next call is a cache miss.

Not possible: compacting from a tool; undoing it; per-message "forget" except snip.
