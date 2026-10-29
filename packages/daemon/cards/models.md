---
summary: providers, models, reasoning effort and per-role model recipes
docs: connect, providers, ai-config, advanced-config
aliases: model, providers, provider, recipes, recipe, effort, login, fast, variants
---
List: {{program}} models [provider] [--verbose]; roles in force: {{program}} control-plane models status. Model references are provider/model (catalog ids; API providers use provider:model).
Switch (the user): /model picks model and effort per session (levels are the model's catalog's, max/none too); F2/F3 step them. /connect adds a provider and its key (the key is typed in the terminal: never ask for it in chat, never print it).
CLI (the user's; your shell only lists): {{program}} providers login --provider ID [--api-key-env VAR] (env var name, never the value) | providers list | providers logout --provider ID. {{program}} control-plane models set-default <provider> <model> [--dry-run] sets the main role; use-preset <name> applies a named preset. A run: {{program}} run --model P/M --effort <effort> "...".
Roles: {{roles}}. A role that is unset follows main.
Window per model: in a session on it the user types /context-window 500k --always (reset --always removes it), saved as [[setting:modelContext]] {"chatgpt/gpt-6-astra": {window, compactAt?}} for every session on the model; a session's own /context-window wins. Lowered to maxContextWindow (models --verbose) when known: gpt-6-astra 872,000 (catalog 272,000); else the provider may refuse.
Recipes name a model per role: {{program}} recipe list | recipe apply <name> (or /model). Files: <data dir>/recipes/<name>.json or <project>/.mendcode/recipes/<name>.json:
  { "description": "Deep work", "version": "1", "roles": { "main": { "model": "gpt-6-sol", "effort": "high" } } }
Each model must be in the catalog and take the effort, or the recipe is refused. Applying one replaces those roles.
A custom or self-hosted provider, added by you, live: api.registerProvider ({{program}} docs extend). Whitelists and model limits are daemon settings ([[setting:provider]], [[setting:enabled_providers]], [[setting:disabled_models]] and the role models [[setting:models]]: change with mendcode_settings, saved on the user's Apply); the user's way: {{program}} providers login --provider-type openai-compatible --base-url <url>. Prices and spend limits: {{program}} docs budgets.
Files: <data dir>/providers.json holds provider entries (apiKey or, preferred, apiKeyEnv; never read a key out of it), tui/models.json favorites and per-model effort, models-dev-cache.json models.dev levels.
More for the user: /providers manages API-key providers, /variants picks a model variant, /fast toggles priority service ([[setting:serviceTier]]: OpenAI hosts only). Sub-agents and plan exit pick their own: [[setting:subagent_variant]], [[setting:plan_exit_agent]]. Sessions on Claude Code, pi or ACP models: {{program}} docs engines. Per-model token use in the right panel: /panel ledger (feature panel_models, balanced).
Planning a recipe offline: ai_config tool or /ai-config (plan, validate, save on the user's confirmation; never activates).
Adaptive effort (JEV): {{program}} docs reasoning.
