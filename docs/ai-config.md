# AI configuration previews

`ai_config` and `ai.config` inspect local model/role inventory, plan a typed recipe, validate its diff, and explicitly save it. They never call a provider, activate a recipe, change the active session model, or start a workflow. The advisor is off.

The TUI uses `/ai-config`: ↑/↓ selects a model, `p` plans, `[`/`]` selects a feasible alternative, `v` validates, and `a` opens exact-save confirmation. Enter saves; Esc cancels. `r` refreshes; PgUp/PgDn scroll panels. Below 70 columns, `1`/`2`/`3` switches inventory/preview/validation. Plan options can be passed as JSON:

```text
/ai-config plan {"intent":"economical","taskKind":"repair","candidates":[{"role":"main"},{"role":"small"}]}
```

The CLI uses the same daemon contract, including previews saved to files:

```sh
mendcode --dir /tmp/mendcode-data ai-config inspect --json
mendcode --dir /tmp/mendcode-data ai-config plan --input '{"intent":"balanced","taskKind":"repair","candidates":[{"model":"local:main"}]}' --json
mendcode --dir /tmp/mendcode-data ai-config validate --file preview.json --json
mendcode --dir /tmp/mendcode-data ai-config apply --file preview.json --yes --json
```

For `--file`, save the plan **data object** (not the CLI result envelope) as `preview.json`. Validate/apply accept that preview or a patch with explicit `--scope`, `--target`, and `--expected-hash`. The CLI creates its own causal session after validation. Apply requires explicit `--yes`; the TUI requires confirmation; agent calls use the engine's write-permission gate. Global tool writes also ask in edits mode. Mixed `ai.config` operations are excluded from remote read-only access.

Project targets are `.mendcode/recipes/<name>.json`; global targets are `<dataDir>/recipes/<name>.json`, only with explicit global scope. Both use the existing recipe format (`description`, optional `version`, `roles`). Target names are lowercase slugs, and files/parents cannot be symlinks. Exact-byte SHA-256 checks reject stale previews. Replacements preserve a byte-exact 0600 backup and atomically rename a 0600 file. Invalid/unavailable choices, malformed existing files, outside targets, and sessions from another project are refused. Unknown fields are rejected rather than removed from an existing recipe.

`recipe apply <name>` or `/model` activates a saved recipe separately. Configured variant and effort choices are validated without silently changing them. `quality` preserves candidate order; `economical` and `balanced` order known local tariffs before unknown ones. Pricing comes only from configured budget tariffs; subscription quota remains unknown in USD. The 32K-token estimate is a comparison, not an enforced runtime cap or quality ranking.

Recipes offer only executable single-model role bindings. Cascade and critic execution are configured and started explicitly through [/compound](compound.md), and compaction profiles through [/compaction](compaction.md). They are separate runtime contracts, never activated by saving a recipe. The inspector reports v2's actual autocompact threshold; the advisor remains off.
