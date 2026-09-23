# Fast compaction and model workflows

MendCode beta4 adds two opt-in controls to the existing `mendcode.json` or
`mendcode.jsonc` configuration: provider-aware compaction and bounded compound
model workflows. Full Prompt Mode can inspect the runtime inventory and prepare
the change, but a recommendation is not an execution request.

## Start with the actual runtime

Use the shared backend so the TUI and CLI observe the same project and provider
state:

```sh
mendcode ai config inspect
```

The result is a redacted inventory of providers, models, advertised variants,
roles, auth category, capability metadata, configuration sources, effective
values, and missing information. It does not make provider inference calls.
Secrets, API keys, OAuth tokens, and raw provider options are never part of the
inventory.

Full Prompt Mode may also use the native `ai_config` tool when that tool is
actually present in the current session. Its actions mirror the same backend:

```text
inspect → plan → validate → apply
```

If the tool is unavailable, use the CLI commands and report the limitation. A
documented provider, installed package, or configured credential is not proof
that the current session can use it.

## Configuration shape

The fields are additive. Omitting them preserves existing portable compaction,
single-model chat, and older configuration behavior.

```json
{
  "compaction": {
    "strategy": "auto",
    "portable_mode": "incremental",
    "timeout_ms": 60000,
    "max_summary_tokens": 4096,
    "on_native_error": "portable"
  },
  "ai": {
    "version": 1,
    "orchestration": {
      "enabled": true,
      "profiles": {
        "economical": {
          "strategy": "cascade",
          "primary": { "role": "build" },
          "escalation": { "role": "plan" },
          "limits": {
            "maxModelRequests": 2,
            "maxTotalTokens": 64000,
            "maxRuntimeMs": 300000,
            "unknownCost": "allow-with-token-cap"
          }
        },
        "reviewable": {
          "strategy": "critic",
          "primary": { "role": "build" },
          "critic": { "role": "plan" },
          "limits": {
            "maxModelRequests": 3,
            "maxTotalTokens": 96000,
            "maxRuntimeMs": 600000,
            "unknownCost": "block"
          }
        }
      }
    }
  }
}
```

This is a template, not a live model recommendation. `build`, `plan`, and any
`compaction` role are existing role names only when the user's
`~/.mendcode/models.yaml` defines them. Direct references use the actual
inventory, for example:

```json
{ "providerID": "<observed-provider>", "modelID": "<observed-model>", "variant": "<observed-variant>" }
```

Replace every placeholder with an observed value before validation. The
validator reports unconfigured roles, unknown providers/models, and unavailable
variants; it does not silently select a different model. The legacy `review`
role is not a substitute for the independent `critic` leg.

Field limits are intentional:

- `strategy` is `portable`, `auto`, or `native`. `portable` is the rollback
  baseline; `auto` may use a tested native binding; explicit `native` stops when
  the exact provider/auth/model transport is unsupported.
- `portable_mode` is `legacy` or `incremental`. Incremental mode keeps the last
  accepted summary, uncovered complete turns, current work state, and a bounded
  recent tail. It does not run a background summarizer.
- `timeout_ms` is 1,000–300,000 and `max_summary_tokens` is 512–8,192.
- `on_native_error` is `stop` or `portable`. A genuine fallback is bounded and
  does not apply after cancellation or permission rejection.
- Profile names match `[a-z][a-z0-9_-]{0,47}` and at most 16 profiles may be
  configured.
- `ModelRef` is exactly `{role}` or `{providerID,modelID,variant?}`. Fields may
  not be mixed, and model/variant identity is resolved when a workflow run is
  created.
- `single`, `cascade`, and `critic` require respectively at least 1, 2, and 3
  bounded model requests. Every profile also requires positive token/runtime
  limits and `unknownCost`.

The example's `economical` and `reviewable` profiles are valid shapes, but they
may not be feasible in a particular installation. A critic must differ from the
primary by provider/model/variant; a same-model cascade is accepted only with a
warning because it does not change the quality route.

## Preview, validate, and apply

For a recommendation, provide only models the user wants to compare. The
advisor ranks feasibility first. It compares known prices only when the catalog
contains them, treats missing prices as `null` rather than free, and marks
quality as `unknown` without comparable dated evidence. Subscription quota is
not API billing.

```sh
mendcode ai config plan --file plan-request.json
mendcode ai config validate --file preview.json
```

`plan-request.json` contains `candidates`, `intent`, and `taskKind`, with
optional `selectedRoles`, `scope`, `target`, and `profileName`. The plan returns
the proposed `ai`/`compaction` patch, alternatives, rationale, warnings, an
observed target, and its exact SHA-256 content digest. Planning never writes.

Validation checks the patch against the actual runtime and target without
writing. It reports schema, role/auth, cost-limit, native-binding, and stale
digest issues. It never launches a model workflow.

Apply only after the user explicitly chooses the patch and target:

```sh
mendcode ai config apply \
  --file preview.json \
  --scope project \
  --target /absolute/project/mendcode.jsonc \
  --expected-hash <sha256-of-the-exact-file-text>
```

Apply requires `scope` (`project` or `global`), the exact patch and digest, and
the normal backend permission for the target. When no project config exists,
the selected project root receives `mendcode.jsonc`; when multiple supported
files exist, choose the exact observed target. The writer:

- changes only top-level `ai` and `compaction` paths;
- preserves comments, formatting context, and unrelated keys;
- re-reads the exact text before replacement and rejects a stale digest;
- replaces the file atomically and keeps a scoped `.mendcode-backups` copy; and
- returns changed keys, before/after hashes, effective values, and warnings.

The CLI creates a dedicated control session on the existing shared backend.
When its policy requires approval, confirm the exact target and preview digest
in an interactive terminal; non-interactive input does not silently approve.
Global changes require both external-directory and edit permission. HTTP
callers cannot use a supplied session ID to inherit its per-turn allow grants.
The native tool keeps its own trusted permission context. These actions do not
invoke a model, and the control session remains as an audit record.

Concurrent clients of the same backend serialize their writes. The final
digest check also detects external changes observed before replacement, but
is not an operating-system-wide lock against arbitrary editors.

It does not edit `config.json`, `models.yaml`, credentials, or the active
session model. It does not start a workflow or buy capacity. A digest conflict
means inspect again and create a new plan; do not overwrite the newer file.

## Compaction and provider changes

`auto` uses native compaction only when the runtime has a positively supported
exact provider/API/auth/model binding. The first beta candidates are the
official OpenAI Responses API route and the existing Codex OAuth transport;
custom OpenAI-compatible, Azure, and other provider transports stay portable
until independently tested. A successful API route does not establish OAuth
support.

An explicit compaction role is a manual portable choice. Native compaction is
bound to the active inference model, so validation reports a conflicting
compaction role instead of silently ignoring it. Native output is kept in a
private checkpoint; it is not emitted as a legacy `summary=true` placeholder.
When the provider, auth, model, instructions, or tools change, MendCode rebuilds
portable context before using another native binding.

To disable the new behavior, apply a reviewed patch that sets
`ai.orchestration.enabled` to `false`, `compaction.strategy` to `portable`, or
`compaction.portable_mode` to `legacy`. Existing transcript history remains the
source for portable recovery. Review the scoped backup before restoring it; no
database backup is restored automatically.

## Explicit compound workflows

Configuration alone does not change ordinary chat. A user must explicitly
invoke a `workflow` with a saved profile and a deterministic validation check.
Compound tasks run in a per-run worktree with `maxConcurrency: 1` and retain a
reviewable candidate and receipt.

The workflow-plan fragment below is a template. Its command must be adapted to
the project and pass MendCode's existing deterministic validation allowlist:

```json
{
  "formatVersion": 1,
  "name": "bounded-repair",
  "description": "Implement and verify one bounded repair.",
  "objective": "Produce a tested candidate without changing the caller checkout.",
  "phases": [
    { "id": "implement", "name": "Implement", "taskIDs": ["repair"] }
  ],
  "tasks": [
    {
      "id": "repair",
      "name": "Repair",
      "kind": "agent",
      "output": { "kind": "text" },
      "workspace": { "mode": "per-run-worktree" },
      "compound": {
        "profile": "economical",
        "validationChecks": [
          { "id": "focused-check", "command": "bun test test/<focused-file>.test.ts" }
        ]
      }
    }
  ],
  "finalTaskID": "repair",
  "completionCriteria": ["The focused check passes."],
  "requiredGates": [],
  "budget": { "maxConcurrency": 1, "maxFanOut": 1 }
}
```

The runtime materializes the resolved profile in the immutable revision and
keeps a compatibility sentinel so an older beta cannot execute compound
metadata as an ordinary agent. `single` validates once; `cascade` escalates
only a quality failure once; `critic` receives at most a 32-file/512 KiB
immutable evidence snapshot and has no shell, MCP, task, Code Mode, provider
tool, or mutable workspace handle. An uncertain critic result blocks. A
revised candidate is reported as not independently reviewed again.

Use `workflow` to preview/save/start and to inspect the retained candidate,
events, artifacts, and receipt. Applying or merging that candidate is a later
user-directed review step; the workflow does not stage, commit, push, merge, or
auto-apply to the caller checkout.

## Full Prompt Mode boundary

Full Prompt Mode includes this playbook and the complete product catalog. It
does not inject a universal provider list or a preferred model. Minimal, focus,
and custom modes keep their narrower scope. Cost discussion, model comparison,
or a plan preview never authorizes extra inference calls; the assistant must
wait for explicit execution intent and the relevant permission gate.
