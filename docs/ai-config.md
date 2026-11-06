`ai_config` and `ai.config` let you inspect local model/role inventory, plan a typed recipe, validate its diff, and explicitly save it. Start with `/ai-config` to preview a recipe in the TUI.

They never call a provider, activate a recipe, change the active session model, or start a workflow. The advisor is off.

## AI configuration previews

1. Open `/ai-config` and use ↑/↓ to select a model.
2. Press `p` to plan a recipe. Use `[`/`]` to select a feasible alternative.
3. Press `v` to validate the diff.
4. Press `a` to open exact-save confirmation. Enter saves; Esc cancels.

| Key | Does |
|---|---|
| `r` | Refreshes |
| PgUp/PgDn | Scrolls panels |
| `1`/`2`/`3` | Switches inventory/preview/validation below 70 columns |

You can pass plan options as JSON:

```text
/ai-config plan {"intent":"economical","taskKind":"repair","candidates":[{"role":"main"},{"role":"small"}]}
```

## Preview and save from the CLI

The CLI uses the same daemon contract, including previews saved to files. Inspect, plan, validate, then apply:

```sh
mendcode --dir /tmp/mendcode-data ai-config inspect --json
mendcode --dir /tmp/mendcode-data ai-config plan --input '{"intent":"balanced","taskKind":"repair","candidates":[{"model":"local:main"}]}' --json
mendcode --dir /tmp/mendcode-data ai-config validate --file preview.json --json
mendcode --dir /tmp/mendcode-data ai-config apply --file preview.json --yes --json
```

For `--file`, save the plan **data object** (not the CLI result envelope) as `preview.json`. Validate/apply accept that preview or a patch with explicit `--scope`, `--target`, and `--expected-hash`.

The CLI creates its own causal session after validation. Saving requires permission:

| Interface | Required to save |
|---|---|
| CLI apply | Explicit `--yes` |
| TUI | Confirmation |
| Agent calls | The engine's write-permission gate |
| Global tool writes | Also ask in edits mode |

Mixed `ai.config` operations are excluded from remote read-only access.

## Where recipes are saved

| Scope | Target | Condition |
|---|---|---|
| Project | `.mendcode/recipes/<name>.json` | Project target |
| Global | `<dataDir>/recipes/<name>.json` | Only with explicit global scope |

Both use the existing recipe format: `description`, optional `version`, and `roles`. Target names are lowercase slugs, and files/parents cannot be symlinks.

Saving protects existing files:

- Exact-byte SHA-256 checks reject stale previews.
- Replacements preserve a byte-exact 0600 backup and atomically rename a 0600 file.
- Invalid/unavailable choices, malformed existing files, outside targets, and sessions from another project are refused.
- Unknown fields are rejected rather than removed from an existing recipe.

## Activate a saved recipe

Use `recipe apply <name>` or `/model` to activate a saved recipe separately. Configured variant and effort choices are validated without silently changing them.

Recipes offer only executable single-model role bindings. Other runtime contracts are separate and never activated by saving a recipe:

| Runtime contract | Configure and start explicitly through |
|---|---|
| Cascade and critic execution | [/compound](compound.md) |
| Compaction profiles | [/compaction](compaction.md) |

## How previews compare choices

| Intent | Candidate ordering |
|---|---|
| `quality` | Preserves candidate order |
| `economical` and `balanced` | Order known local tariffs before unknown ones |

Pricing comes only from configured budget tariffs; subscription quota remains unknown in USD. The 32K-token estimate is a comparison, not an enforced runtime cap or quality ranking.

The inspector reports v2's actual autocompact threshold; the advisor remains off.
