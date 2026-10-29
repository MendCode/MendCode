# Advanced agent and model configuration

Command results are masked and secret-detected before full filtered or truncated copies reach disk. Live tool output
holds incomplete lines and private-key blocks so split credentials are not emitted; an overlong pending line pauses live
output until the final result. Output storage uses owner-only real directories and exclusive files, refusing symlinked
output directories even if replaced after an earlier save. Existing disk and retention limits still apply.

The daemon owns these additive `settings.set` fields. `settings.get` returns the saved configuration; null patch values
clear a field. `$schema` is an editor/schema reference, never a URL the daemon fetches. Validation uses v2's protocol schemas.

```json
{
  "$schema": "https://example.test/mendcode-config.json",
  "shell": "/bin/zsh",
  "watcher": { "ignore": ["**/generated/**"] },
  "enabled_providers": ["chatgpt", "local"],
  "disabled_models": ["local/retired"],
  "default_agent": "build",
  "plan_exit_agent": "reviewer",
  "subagent_variant": "quick",
  "agent": {
    "build": { "temperature": 0.2, "top_p": 0.9, "color": "accent", "steps": 8 },
    "reviewer": { "description": "Review code", "mode": "primary", "prompt": "Review and verify." }
  },
  "tool_output": { "max_lines": 2000, "max_bytes": 51200 },
  "models": { "title": { "model": "local:fast" }, "summary": { "model": "local:large" } },
  "provider": {
    "local": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "http://localhost:8080/v1", "timeout": 300000, "chunkTimeout": 60000 },
      "whitelist": ["fast", "large"],
      "models": {
        "fast": {
          "name": "Fast", "family": "local", "release_date": "2026-01-01", "status": "beta",
          "cost": { "input": 1, "output": 3, "cache_read": 0.1 },
          "limit": { "context": 64000, "input": 60000, "output": 4096 },
          "modalities": { "input": ["text", "image"], "output": ["text"] },
          "temperature": true, "reasoning": true, "tool_call": true,
          "headers": { "X-Route": "fast" },
          "options": { "seed": 4 },
          "variants": { "quick": { "effort": "low", "temperature": 0.3 }, "retired": { "disabled": true } }
        },
        "large": { "limit": { "context": 200000, "output": 8192 } }
      }
    }
  }
}
```

Agent settings merge with trusted layer files and override builtins; nested `options` merge. Project files retain their
trust boundary. An invalid, hidden, disabled or subagent-only default fails session creation. Without an explicit default,
the first enabled visible primary is used, starting with build. `plan_exit_agent` aliases `planExitAgent` and takes precedence;
invalid implementation destinations fall back to a visible primary. Plan mode remains read-only until approval.
An explicit task model/variant overrides agent defaults; `subagent_variant` applies when neither the task nor its agent
chooses a variant. Hidden agents remain explicitly callable; they cannot be implementation destinations.

Model denies accept exact catalog IDs (`local:fast`) or donor IDs (`local/fast`); an empty provider allowlist permits none.
Provider whitelist/blacklist apply to raw model IDs and also bind runtime requests. Provider settings overlay `providers.json`.
Provider generation defaults, model options, selected variant and agent sampling apply in that order. Conversation,
authentication and tool-routing fields cannot be overwritten through generation parameters. Disabled variants are omitted.

Model metadata exposes costs (dollars per million tokens), context/input/output limits, modalities, status, capabilities
and release information. Output limits cap generated tokens; text-only models omit images with a note, models without
tool calls receive no tool specs, and models without temperature support omit sampling fields. Usage without a provider
cost uses configured input/output/cache pricing, including `context_over_200k`. Authentication headers are redacted in
provider/model reports. Total timeout defaults to 300000 ms and chunk idle timeout to 60000 ms; `false` disables either.

An existing `<dataDir>/models.dev.json` (up to 8 MB, models.dev provider/model shape) supplies local metadata, costs,
capabilities and variants. Explicit model entries overlay it. No catalog download is made. Known SDK names for OpenAI,
Anthropic and OpenAI-compatible endpoints select v2's native wire adapters. Other SDK packages are reported as unsupported;
an explicit supported wire `type` can be used for a compatible endpoint. Arbitrary SDK execution and live catalog/service
validation remain outside this local, dependency-free batch.

Tool output previews use the global line/UTF-8 byte caps. Larger masked outputs are saved to `<dataDir>/tool-output/` with
read/grep hints: up to 8 MB per excerpt, 64 MB total, one day retention. These disposable files are separate from attachment
blobs. Once the context has reached 80 % of the compaction threshold, older tool results are pruned from model history
after protecting the latest two user turns and 40k tool tokens; pruning requires over 20k reclaimable tokens and protects skills. Persisted transcript items remain available.

### Command output filters

`tool_output.filters` (or `features.output_filters`, `/tier output_filters on|off`) condenses what `shell` and `shell_output`
return before the model sees it. It follows the tier: on in balanced and full, off in minimalist and with no tier; your own
switch wins. The filters live in `packages/engine-native/src/output-filters/`, one file each, pure and run in this order:
`ansi` (colour codes, `\r` progress redraws), `tests` (bun/jest/vitest/pytest/go/cargo passing lines fold to a count),
`git` (status hints, diff `index` lines, transfer progress), `tsc` (diagnostics grouped under their file), `search`
(`grep`/`rg` hits grouped under their file) and `repeats` (runs of three or more identical lines, blank runs). A line that
looks like a failure (`error`, `fail`, `warn`, `✗`, `(fail)`…) is never folded, and nothing is reordered.

Nothing is lost: the full masked output is saved first (same `<dataDir>/tool-output/` store and limits) and the result
starts with `[filtered tests: 249 → 10 lines, ~2327 tokens saved. Full output: <path>]`; read the path with `read` offset/limit
or `grep`. With no way to save it, or a saving under 60 estimated tokens (the header must pay for itself), the output is
returned untouched. A filtered result still over the line/byte caps is cut as before and says the unfiltered copy is at the
path above. `meta.savedTokens` (chars / 4, an estimate, not billed) and `meta.filter` ride on the completed tool item;
`/usage` > Tools sums them per filter as "Tokens saved". The recorded-run test in
`packages/engine-native/test/output-filters.test.ts` is the budget: a 241-test passing run drops from over 2,000 to under 150
estimated tokens. Other tools (read, grep, edit…) are not filtered. No external binary and no model call is involved.

Frames: `bun scripts/render-frames.ts .agents-frames/B42 100x30 180x50 --b42`. The harness renders `/agent`, `/model`, its
summary role selection and the colored-agent conversation through the app's factories. Additional compact/wide sizes
are covered by the same harness tests.

## Local instructions and skills (B43)

`settings.set` accepts `instructions: ["rules/**/*.md", "/explicit/user/rules.md"]` and
`skills: { paths: ["/explicit/user/skills"], urls: ["https://example.test/skills"] }`.
`~` paths expand to the home directory; relative paths resolve in each session project. User instruction globs also
search project ancestors up to the repository root. AGENTS/CLAUDE/legacy CONTEXT fallback and global instructions
remain; real paths deduplicate matches. Each file is bounded to 16,000 characters and the combined block to 64,000.

The project's `.mendcode/project.json` can declare the same fields. Project declarations must stay inside the project;
external locations require an explicit user setting. Remote instruction/skill URL declarations are retained but never
fetched. `project config-show` lists their blocked reasons. Network/trust policy and importing upstream licensed
vendor prompt snapshots remain decisions; native family guidance and local custom/SYSTEM prompts work already.

`.agents`/`.claude` skills, commands and agents, `AGENTS.override.md`, instruction fallbacks and root markers, the shell
environment policy, proxy, strict config and web domain rules are in `docs/resources-config.md`.

Skills search extension layers, then explicit configured folders recursively with bounded depth/count; configured names win.
Only names/descriptions enter full-mode prompts; the skill tool and `/skills` load bodies on demand. Disabled skills
remain discoverable and cannot be loaded or injected. Changes apply at the next native call without restart.
