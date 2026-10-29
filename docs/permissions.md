# Permissions

Every tool call has a permission: `read`, `write` (edits files) or `execute` (runs things). Reads inside the project run unless a tool/path rule asks or denies them. Reads of `.env` and `.env.*` ask by default (`.env.example` is allowed). What happens to the rest depends on the session's mode (`session.permission.set`, `defaultPermission` setting):

| mode | write | execute |
|---|---|---|
| `ask` | asks | asks |
| `edits` | runs | asks |
| `full` | runs unless a rule denies | runs unless a rule denies |
| `plan` | refused (read-only until a plan is approved) | refused |
| `smart` | runs when low risk | runs when low risk |

Approving with "for this session" records a **grant** for that tool; later calls of it do not ask. Cross-session history is an exception: `threads` read/search/wait/merge_back and their MCP equivalents require an explicit `@thread` mention for that target, the target's id written in the user's message, or individual approval every time, in every mode but `full` (full access reads them unattended, as its shell could already run `mendcode export`). Allow rules, automatic reviewers and session grants cannot substitute for that consent. Explicit deny rules still win; individually approved reads are permitted in plan mode.

## Smart mode

`smart` settles low-risk calls by rule and asks about the rest, so a session is neither a wall of prompts nor `full`. The rules are plain code (`packages/engine-native/src/smart-permissions.ts`), not a model, and one call always gives one answer. Every approval prompt in smart mode ends with *why it asks* and the rule.

| rule | applies to | decision |
|---|---|---|
| `read` | any read tool | **runs** |
| `edit-in-project` | `edit`, `write`, `apply_patch` when every path is inside the project (symlinks resolved) and not secrets or `.git` | **runs** |
| `allow-listed-command` | `shell` where every command of the line is allow-listed and no rule below fires | **runs** |
| `destructive` | `rm`, `rmdir`, `sudo`, `chmod`/`chown`, `kill`, `dd`/`mkfs`, `find -delete/-exec`, `git reset --hard`/`clean`/`restore`/`checkout --`/`rebase`/`branch -D`, `DROP TABLE`, `docker rm`… | asks (high) |
| `secrets-file` | any path that looks like credentials (`.env*` except `.env.example`, `.ssh`, `.aws`, `id_rsa`, `*.pem`/`*.key`, `credentials*`, `.npmrc`…), `env`, `printenv` | asks (high) |
| `git-internals` | a path inside `.git/` (hooks and config run or leak code) | asks (high) |
| `agent-config` | a path inside `.mendcode/` (hooks, tools and extensions the daemon runs later, outside any sandbox) | asks (high) |
| `runs-program` | an option or variable that makes an allow-listed command run another program: `rg --pre`, `git grep -O`, `sort --compress-program`, a leading `PATH=`, `LD_PRELOAD=`, `GIT_*=`… | asks (high) |
| `outside-project` | a path (argument, flag value, redirection target, `workdir`, `cd`) that is not inside the project, including `..`, `~` and symlinks that lead out; `/dev/null` is fine | asks (high) |
| `network` | `curl`, `wget`, `ssh`, `npx`…, `git push/pull/fetch/clone`, package installs/updates (`bun install`, `npm add`…), any URL in the command | asks (high) |
| `autonomy` | `loop`, `workflow_start`, `tell` (start autonomous work or message another session) | asks (high) |
| `shell-expansion` | `$VAR`, `$(…)`, backticks or `<(…)` outside single quotes: what runs cannot be read from the text. A saved wildcard allow rule (`ls *`) never covers such a command | asks (uncertain) |
| `unlisted-command` | a command that is not allow-listed and matched no risk rule | asks (uncertain) |
| `unclear-target` | an edit whose file cannot be read from its arguments | asks (uncertain) |
| `unknown-tool` | MCP tools, custom tools, any other write/execute tool | asks (uncertain) |
| `forbidden` | `rm -r` of `/`, a system directory or the home directory (`/`, `/*`, `~`, `$HOME`, `/usr`, `/Users`…), `rm --no-preserve-root`, `chmod`/`chown -R` of the same, `dd of=/dev/sdX`, `mkfs*`, `diskutil erase*`, output redirected onto a disk device, a fork bomb | **refused**, no prompt, no reviewer |
| `sandboxed` | an unlisted command or shell expansion that nothing flagged, when `smartSandboxTrust` is on and the OS sandbox is on with the network off | **runs** |

A command line is split at unquoted `&&`, `||`, `;`, `|`, `&` and newlines; every part is judged and the **most severe** decision wins (`ls && curl x` asks for `network`). Quotes are respected (`echo "a && rm -rf /"` is one `echo`).

**Wrapped commands.** What a command hides inside is judged like a command line of its own, to any depth up to 8 (deeper is high risk): `bash|sh|zsh|dash|ksh|ash|fish -c '…'` (also `-lc`, `-o pipefail -c`), `eval '…'`, `trap '…' SIG`, `xargs <command>`, and `$(…)`, backticks, `<(…)` and `>(…)` (not inside single quotes). So `bash -c 'rm -rf build'` and `echo $(curl x)` ask for `destructive` and `network` instead of passing as an unlisted command a reviewer could clear, and `bash -lc 'ls && cat package.json'` runs. `env`, `time`, `command`, `nohup`, `exec`, `timeout 30` and `nice -n 5` are transparent: `timeout 60 bun test` is `bun test`. A shell that runs a file (`bash script.sh`) or reads its script from an option (`--rcfile`) is an unlisted command. `permissionAllow: ["bash -c"]` still clears an *unknown* wrapped command, never a flagged one. `deny` and `ask` rules (`permission.bash`) match the wrapped commands too (`rm *` denies `bash -c 'rm x'`); an `allow` rule on the wrapper never vouches for them.

**Refusals.** The `forbidden` rule is the only one that never prompts: nothing in a coding session needs it, and a prompt is one reflexive click from a wiped machine. A `permissionAllow` prefix, the sandbox setting and a session grant cannot lift it. `full` mode (explicit user choice) and your own `!command` are not affected. The model is told `smart mode never runs this: <why>`.

**Allow list.** Built in: read-only commands (`ls`, `cat`, `head`, `tail`, `wc`, `grep`, `rg`, `sort`, `diff`, `jq`, `echo`, `pwd`, `cd`, `find` without `-delete/-exec`, `sed` without `-i`…), local file work inside the project (`mkdir`, `touch`, `cp`, `mv`), read-only `git` (`status`, `diff`, `log`, `show`, `branch` listing, `rev-parse`, `blame`…), the program's own reference cards (`mendcode docs` or `mendcode docs <topic>` as the whole command line: the bare program name and one plain topic word, nothing before, after or around it), and the project's own checks (`bun test`, `bun run typecheck|lint|build|check`, `npm test`, `tsc`, `cargo test`, `go test`, `pytest`…). Add your own prefixes with the `permissionAllow` setting (`["make test", "git commit"]`): a prefix matches the first words of a command, and it can never override a risk rule (`git commit -m x && git push` still asks for `network`).

**Session grants.** In smart mode a grant covers only the same action fingerprint and causal user authority, with complete execution identity, and never a high-risk call. Changing the command, script identity, environment, or user turn asks again. Other modes retain tool/path session scopes.

Claude Code sessions (engine `claude`) and the Codex engine treat `smart` as `ask`.

### Permission reviewer (optional)

Set the configured reviewer model role (`permissionReviewer` by default; the `permissionReviewerRole` setting names another role, which `mendcode control-plane permissions set-reviewer-role ROLE` writes) (`models.permissionReviewer`, per profile too) and, in smart mode, a model classifies each approval the rules did not settle **before** you see it. It is **off by default** (no role, no reviewer, no model call), and it has no fallback to `main`.

The reviewer answers `allow`, `ask` or `deny` with a reason:

- `deny` refuses the call without asking you; the agent is told `denied by the permission reviewer: <reason>`.
- `allow` runs the call **only when the rules called it uncertain** (an unlisted command, an unknown tool). A rule-flagged (high risk) call always reaches you; the prompt shows the reviewer's opinion.
- `ask`, a timeout (10 s), an error or an unreadable reply all mean **ask**: the prompt appears as if there were no reviewer, with the reviewer's note.

The reviewer sees the project path, tool, rules, bounded call text, original causal user request, up to 12 real user anchors (24,000 characters) and execution fingerprints. Anchors come from the daemon's turn projection and survive restart/compaction; reverted turns and synthetic notices are excluded. Input extensions retain the original request separately, including in a restored queue. Expanded files and tool results are not user authority. Missing/truncated authority or incomplete execution identity requires manual approval even if the reviewer says allow. It is consulted only in smart mode and never for calls the rules allow.

The native engine captures the shell environment before review and uses that same snapshot for foreground and background execution. Only a digest is recorded; environment values never enter the protocol or audit. Literal executable and script identities are checked again immediately before execution. A changed identity refuses the call and requires a fresh review. Dynamic shell evaluation remains incomplete and cannot receive a model-only approval.

### Retry after a reviewer denial (`/approve`)

When the reviewer refuses a call, the agent is told and the call does not run. `/approve` (`permissions.retry { sessionId }`)
approves **one retry of the last denied call**: its next try (the same action, by execution fingerprint) runs once without
the reviewer or a prompt, then the reviewer judges again. The denial and the approval each last ten minutes; the ack is
`{ tool, summary, reason }` and `target_mismatch` means nothing was denied recently. Tell the agent to try again after
`/approve`. Local clients only (`forbidden` over a remote connection); it is not a read-only command.

### Smart mode vs Codex

Compared with the public `openai/codex` repository (`codex-rs/core/src/exec_policy.rs`, `safety.rs`, `execpolicy`, `shell-command`), read 2026-10-03. The guardian reviewer (`codex-rs/core/src/guardian`) was not studied in depth; v2's reviewer is the section above.

| topic | Codex | MendCode |
|---|---|---|
| Approval policy | `untrusted`, `on-request`, `never`, `granular` (separate switches for rule prompts and sandbox prompts). `never` turns every would-be prompt into a refusal | modes `ask`/`edits`/`smart`/`full`/`plan`; no per-category switches (not adopted) |
| Where safety lives | The OS sandbox: with a restricted sandbox, a command nothing flags runs without a prompt (`on-request`) | Rules first (code, one answer per call); the sandbox is a separate opt-in layer. **Adopted**: `smartSandboxTrust` (below) |
| Rules | Starlark `prefix_rule(pattern, decision = allow \| prompt \| forbidden, justification, match, not_match)`; the strictest matching rule wins; `host_executable` pins absolute paths; `execpolicy check` prints the verdict. Approving can append a rule to `~/.codex/rules/default.rules` | `permission` tables (`allow`/`ask`/`deny`, last match wins, per tool and path), saved rules per project or global, `permissionAllow` prefixes. Not adopted: a rules language with examples validated at load, justifications, a `check` command |
| Forbidden tier | `forbidden` from a rule, or from the heuristics when approvals are `never` | **Adopted**: the `forbidden` rule refuses catastrophic commands in smart mode regardless of settings |
| Dangerous commands | Narrow: `rm -f`/`-rf`, `sudo` and `env` recursion, `trap`, wrapper depth cap (over 8 is dangerous); Windows/PowerShell rules | Wider (delete, disks, permissions, kill, git history, network, package managers, secrets, `.git`, `.mendcode`, outside the project, symlinks, `PATH=`/`LD_PRELOAD=`, `rg --pre`, `sed` scripts…) |
| `bash -lc` | tree-sitter parses the script. Plain word-only commands joined by `&& \|\| ; \|` can be proven safe; any literal command in complex scripts is checked for danger but never proves safety | **Adopted** (no parser dependency): the script, `eval`, `trap`, `xargs` and `$(…)` are re-split and judged like a command line; anything with expansion stays uncertain, so only a fully readable script can run |
| Deny rules vs wrappers | rules match each command parsed out of `bash -lc` | **Adopted**: `deny`/`ask` rules also match wrapped commands |
| Patches | allowed when every path is in a writable root and a sandbox exists; otherwise ask or reject | inside the project (symlinks resolved), not secrets, `.git` or `.mendcode`, else ask. `external_directory` is a separate approval |
| Reviewer | guardian | optional reviewer role: only clears `uncertain` calls, sees causal user authority and execution fingerprints, never a high-risk one |
| Grants | per command prefix amendment | smart grants bind the exact action and user authority; never cover a high-risk call |

**`smartSandboxTrust`.** Codex's strongest idea is that the sandbox, not a prompt, protects against what rules cannot read. v2 keeps rules in front and adds the same thing as an opt-in: with `smartSandboxTrust: true`, the OS sandbox on (`read-only` or `workspace-write`) and `network: off`, an `unlisted-command` or `shell-expansion` call runs without asking (rule `sandboxed`). Every rule that flags a risk still asks: deleting project files, network, paths outside the project, secrets, `.git`, `.mendcode`, package installs. The sandbox confines writes and the network; **reads stay open** (a script can read `~/.ssh` and print it into the transcript), which Codex accepts too. Decision taken: off by default; needs the user's own `settings.set`, refused for remote peers. With no sandbox backend the shell tool refuses to run at all (`docs/sandbox.md`), so the setting never runs anything unconfined.

## Blast-radius preview

Pre-approval probes use the host's `/usr/bin/git` and `/usr/bin/find`, a fixed system PATH and no dynamic-loader injection
variables. Repository PATH entries cannot run a preview executable before consent. Windows omits process-based previews.

When a `shell` command from a closed set asks for approval, the prompt shows what it would change, computed read-only beforehand (no model call, argument arrays only, nothing is deleted or modified; shown in every mode that asks, like an edit's diff):

| command | preview |
|---|---|
| `rm [-rfdv] <paths>` | each path with size; a directory with file and subdirectory counts, size and its first files (bounded: 5,000 entries, 1.5 s); wildcards expanded like the shell (dotfiles skipped); missing paths, directories without `-r` and symlinks (never followed) noted |
| `git clean [-dxXf] [-e pat] [paths]` | `git clean -n` with the same flags: the paths it would remove |
| `git reset --hard [rev]` | tracked files that differ from `rev` (default `HEAD`) with `+added -removed`, and the commits the branch would lose |
| `git restore <paths>`, `git checkout [rev] -- <paths>` | tracked files whose changes would be discarded |
| `find … -delete` | the same `find` with `-delete` replaced by `-print`: the entries it would remove |

Anything else gets no preview and the prompt is as before: pipes, `&&`/`;`, `$(…)`, `~`, brace expansion, redirections, unknown flags, `-exec`, unquoted wildcards in `git` and `find` arguments, a path outside a repository. A failed or slow dry run (8 s for git, 5 s for find) also shows nothing, or a partial list marked as such. The preview is part of the approval text, so a reviewer model and a connected client see it too.

## Approval choices

A tool approval offers, in order: **Allow once** (`a`), **Allow for this session** (`s`), **Always allow `<rule>` in this
project**, **Always allow `<rule>` in all projects**, **Reject** (`d`) and **Reject with a note**. Digits `1` to `9`, the
arrows with `enter`, or a click pick one; the rows without a letter key cannot be hit by text typed into the prompt.
`?` shows or hides an explanation (what the call is, why it asks, what each choice does; built locally, no model call).
In minimal view the one-line approval offers `[a] [s] [d] [?]`; text typed while an approval waits is still a rejection
with that text as the note.

- **Reject with a note** (`choice` 6) opens the prompt: what you type goes to the agent as the reason (`deny.reason`, 2 000
  characters), so it can change course. Plan reviews keep their own four choices.
- **Always allow** approves this call once and saves an allow rule: `request.resolve` with
  `decision: { kind: "approve", scope: "once", remember: { level: "project" | "user" } }`. The daemon derives the rule from
  the pending request (a client never names a pattern), only on the machine that runs the commands (`forbidden` for a
  remote peer), and only after the answer was accepted. The rule is the command prefix for `bash` (`git status *`,
  `pnpm run test *`; every command of a pipeline needs one) or the whole tool for a file-changing tool (`edit`). Commands that run what they are given
  (shells, `sudo`, `env`, `xargs`, interpreters, `curl`, `rm`, `find`...), commands with flags before the subcommand,
  `$(...)`/backticks and other tools that execute (browser, computer) offer nothing, and neither do external-directory and repeat-loop
  approvals. Engines other than the native one send no rule context, so they show only the first three choices.
- **Project** rules are stored in the daemon's settings under `projectConfig.<canonical directory>.permission` (never in the
  repository), as an ordinary rule table; **all projects** rules go to the top-level `permission`. Order, last match wins:
  tools, `permission`, the project's saved rules, then your `permission` denies again (a saved allow never beats a deny
  of yours), the agent's rules, the session's rules. Remove a rule by editing those settings (`settings.set`); `/debug-config` shows
  the project layer.

## Commands the engine flags in full access

`full` runs everything unless a rule denies, but Claude Code (run with `--permission-mode bypassPermissions` in `full`) keeps its own safety checks: a command such as `rm -f *` in a compound line still raises a permission request ("Dangerous rm operation"). By default MendCode allows it: full access is your choice to run unattended, so it never stops to ask. With `engineSafetyPrompts: true` a request that arrives from Claude Code while it is in bypass mode is shown to you instead as an ordinary approval, with Claude's own reason as the first lines of its detail:

- The choices are **Allow once** (`a`) and **Reject** (`d`); there is no session or always choice, and a client that answers "for the session" still allows that call only (Claude's suggested rules are dropped). The `?` explanation says why it asks. Over the protocol the `server.request` event carries `engineFlagged: true`.
- Rejecting sends your note (or "The user denied this.") back as the tool result; the turn continues.
- Headless: `run --approve` and `session send --approve` reject it with a clear message (the turn goes on and the exit code is the turn's; exit 5 is only for an ordinary approval denied because `--approve` was not passed, see [automation](automation.md#headless-and-startup-parity-b16)); `--dangerously-skip-permissions` allows it. Both flags otherwise behave the same.
- Setting `engineSafetyPrompts` (default `false`, local clients only): `true` turns these approvals on. Set it with `settings.set { patch: { engineSafetyPrompts: true } }` or in the daemon's settings.
- A request raised in `full` for any other reason, for example when you switched to `full` mid-turn so Claude Code was not in bypass mode yet, is still answered automatically.

Not the same hole: the native engine has no engine-side check beside its own rules (`full` is "runs unless a rule denies", and `forbidden` is smart-mode only), so nothing like this exists there. Codex runs with `approvalPolicy: on-request` and a workspace-write sandbox in every mode, so its requests are sandbox escalations, not checks raised despite a "never" policy; `full` still accepts those.

## Grants

| command | does |
|---|---|
| `permissions.list { sessionId }` | `{ grants: [{ grantId, tool, permission, grantedAt, pattern?, rulePermission? }] }` (oldest first); mode grants use the tool name as id, scoped grants use an opaque id |
| `permissions.revoke { sessionId, grantId \| "all" }` | `{ revoked }`; `target_mismatch` for an unknown id. The next call of that tool asks again |

Grants live in the daemon's memory, per session: they end with the session or a daemon restart.

`permissions.history { sessionId, limit?: 1..100 }` returns newest-first review records and grant history. The typed client helper is `permissionsHistory`. Smart reviews retain status (`reviewing`, `waiting_manual`, `allowed`, `denied`, `cancelled`), decision source, bounded reason, causal source IDs and authority/action fingerprints. Grants and revocation timestamps persist in the daemon store (100 grants and 500 reviews per session); deleting a session removes its audit. Reopening the daemon marks old grants inactive, cancels interrupted reviews and does not replay them. Durable expiry/replay policy and a live reviewer canary remain pending B33 decisions/external validation.

## Settings

| setting | meaning |
|---|---|
| `defaultPermission` | `ask` \| `edits` \| `full` \| `smart` for new sessions (per profile too) |
| `permissionAllow` | extra allow-listed command prefixes for smart mode |
| `smartSandboxTrust` | `true` lets smart mode run commands it merely does not know (`unlisted-command`, `shell-expansion`) when the OS sandbox (`/sandbox`, `docs/sandbox.md`) is on with `network: off`. Off by default; local clients only |
| `models.permissionReviewer` | the reviewer's model; unset = no reviewer |
| `engineSafetyPrompts` | `false` (default) allows a command Claude Code itself flags in `full` access, unattended; `true` shows it as an approval (allow once or reject). Local clients only (see [above](#commands-the-engine-flags-in-full-access)) |
| `engineEnvironment` | `true` (default) gives the session's `/env` credentials to Claude Code, Codex, pi and ACP agents as well (their process environment, names in their prompt; unmasked in their output); `false` keeps them for the native engine. Local clients only ([environment](environment-privacy.md)) |

## The /permissions page

`/permissions` (terminal UI) shows:

- **Mode.** The five modes above with a one-line meaning each; the session's current mode is marked. `1` to `4` set `ask`, `edits`, `full` and `smart`; `plan` is entered with `/plan`, and `shift+tab` in the prompt cycles `ask`, `edits`, `full`, `plan`. For `smart` the page summarizes the rules: what runs without asking, what always asks and what goes to the reviewer.
- **Reviewer.** Whether `models.permissionReviewer` is set and to what, or that smart mode asks for every uncertain call. `m` opens `/model` to change it.
- **Grants.** The session's grants from `permissions.list`, oldest first. `↑↓` select, `r` revokes the selected grant, `R` revokes all (asks once: `R` or `y` confirms, any other key cancels). The next call of a revoked tool asks again.
- **History.** `h` toggles the durable history: `↑↓` selects a review, with its causal authority and frozen execution identity beside it; the bottom panels show active/inactive/revoked grants and executable identities. `[`/`]` and PgUp/PgDn scroll. Under 70 columns the same panels stack.

### Reviewer verdict in approvals

When the reviewer was consulted, the approval panel adds a row under the call: `asks: <why it asks>` and `reviewer <allow|ask|deny> — <reason>`. The panel takes both from the approval detail text (the engine appends `Why it asks:` and `Reviewer:` trailers); the protocol has no separate field for them. The colors match the verdict: allow is green, ask amber, deny red. `ask` and `deny` still ask you; only the rules and your answer decide.

## Tool and path rules (native engine)

`settings.set` accepts v1-shaped `permission`, `tools`, and `experimental` settings. For example:

```json
{
  "permission": {
    "read": { "*": "allow", "*/private/*": "deny" },
    "bash": { "git *": "allow", "git push *": "ask" },
    "external_directory": "ask",
    "doom_loop": "ask"
  },
  "tools": { "webfetch": false },
  "experimental": { "primary_tools": ["loop"], "continue_loop_on_deny": false }
}
```

Rules keep insertion order: the **last match wins**. `*` spans any characters, `?` spans one; `git *` also matches `git`.
`~` and `$HOME` prefixes expand to the user's home. `permission: "ask"|"allow"|"deny"` is a wildcard shorthand.
`tools` boolean rules come first, then `permission`, then the selected agent's rules. `bash` names v2's `shell`;
`edit` covers `write`, `edit`, `apply_patch` and `notebook_edit`. Starting an interactive process (`shell_session`
`start`) is matched, classified, bound and approved exactly like the same `shell` command; its other actions only touch
sessions the chat already started (`docs/interactive-tools.md`). Global tool deny removes the tool from the model's catalog when
there is no later path exception. Called tools are checked again, including arguments rewritten by extensions.
File rules check logical and resolved paths. A plan-mode cap still forbids writes and execution.
The opt-in OS sandbox (`/sandbox`, `docs/sandbox.md`) runs under these rules: an approved shell command still starts inside it.

`external_directory` is a separate approval before a read, file edit, patch or shell call accesses an external target
or working directory. Symlinks resolve before classification. Approving for the session grants only the displayed
directory pattern, never other directories. An explicit deny still wins over any grant, including in full mode.
Full mode bypasses ordinary asks and never waits on you for `doom_loop` either: the third identical call is refused
as a tool error the model reads and adapts to (an explicit `doom_loop` rule still applies first).

### Extra directories

Work that spans more than one tree (a shared library, a docs repo) can declare extra workspace directories instead of
answering `external_directory` for each one:

```text
mendcode --add-dir ../shared [--add-dir /opt/docs]   # this session only (also on `run`)
/add-dir PATH                 # this session only; /add-dir lists, /add-dir remove PATH drops
/add-dir save PATH            # keep it in the additionalDirectories setting (absolute paths, at most 20)
```

A declared directory behaves like part of the project: no `external_directory` ask for reads, edits, patches or shell
calls inside it (symlinks resolve first), `smart` mode rates edits there like project edits (secrets files and `.git`
internals still ask), and `workspace-write` sandbox commands may write there (`docs/sandbox.md`). Everything else is
unchanged: ordinary tool approvals, an explicit `external_directory` deny rule for the directory, and the filesystem
root, which is never accepted. The session list is held in daemon memory like the other run limits; `--add-dir`, `/add-dir`
and the setting are local only (a remote or peer connection is refused), since the paths belong to the machine that runs
the commands.

The third consecutive identical tool name and arguments in one turn asks for `doom_loop`; changed arguments or
intervening assistant text reset the count. A session grant covers only that repeated tool. A user rejection stops
by default and closes all remaining tool results. `experimental.continue_loop_on_deny: true` lets the model adapt;
rule/reviewer denials remain tool errors the model can react to. The existing max-step limit remains.
`experimental.primary_tools` removes matching names from both inline and persisted child agents, including MCP
and extension tools. The parent retains them. These settings govern native sessions; external engines own their policies.

`/permissions` shows mode, grants (including scoped targets), configured tool/path rules, loop policy and the selected
reviewer role in a full-width panel grid. Hints are in its header. `[`/`]` scroll rules; PgUp/PgDn move farther. Below
70 columns the panels stack and scroll. Revocation updates the page directly.

The [Git page](git.md)'s push, publish and pull request actions are not model tool calls, but they honour your `deny` rules: a `bash` rule (settings, project rules or the session's own) that matches `git push …`, `gh repo create …` or `gh pr create …` refuses the action and names the rule. `allow` and `ask` rules do not apply to them; the page always asks on its own card.

## What a session cannot do from its own shell

A session runs shell commands, and `mendcode` is on the PATH there. From that shell a session can read (`docs`, `status`,
`models`, `context`, `session list|get|events`, `control-plane … status`) and nothing else that is the user's to decide:
it cannot change permission defaults or rules, settings, models, recipes, profiles, provider credentials, MCP servers,
packages, extensions, themes, the prompt mode, memory, loops, workflows, remote tokens, sharing or the console account,
and it cannot stop, restart, upgrade or uninstall anything. This holds in every permission mode, `full` included. The
same commands from your own terminal, from the TUI, from cron and from CI work as before. A daemon setting you ask the
model to change goes through the `mendcode_settings` tool instead, which saves nothing until you approve the exact change
([resources-config](resources-config.md#settings-the-model-proposes)).

**The guarantee.** This stops a model, or text that steers one, from using MendCode's own front doors (its CLI, its TUI,
its local socket) to raise its own authority. It is not a sandbox: a process running as your OS user can still edit the
files of the data directory or hand a command to another service (cron, launchd, a terminal multiplexer). Turn on the
[sandbox](sandbox.md) to confine what commands can write.

Three layers, strongest first:

1. **The daemon** does not take a client's word for who it is. On the local Unix socket it reads the connecting process
   from the kernel and looks for it among the processes sessions started (`shell`, background tasks, `shell_session`):
   a client that descends from one, or still belongs to the terminal session one of them led after that one ended, is
   agent-origin. So is every other descendant of the daemon process (engines, MCP servers, hooks), except a terminal you
   opened through the daemon. Every session command also gets a hard file-size limit of 512 PiB, which a process can
   lower and never raise: on Linux the daemon reads it from the peer, on macOS the CLI reports its own, and a limit
   below the daemon's marks the client. An agent-origin client gets reads, and session work inside its own authority;
   everything else answers `forbidden`. A command the daemon does not know yet is refused to it by default.
2. **The CLI**, started with `MENDCODE_AGENT_SHELL` naming the data directory it is about to use, refuses those commands
   before asking the daemon, and the ones that never reach a daemon (`remote token create|revoke`, `daemon stop|restart|service`,
   `serve`, `upgrade`, `uninstall`, `migrate-v1`, `storage --offline`, `--restart-daemon`).
3. **The shell tools** recognise the command line before running it (by name, by path, through a link, `env`, `command`,
   `exec`, `sudo`, `xargs`, `sh -c`, `eval`, a variable or `$(which …)`) and refuse it with what to ask you. This is
   pattern matching and can be evaded; it is there for the message, the two layers above are what hold.

**Other sessions.** A session never hands out more than it has. A session it starts (`run`, `session create`, a fork)
begins in the usual mode, capped at the caller's own. It can send work to, cancel or reconfigure only a session whose mode
is not above its own; it cannot raise any session's mode above its own; it cannot answer an approval, a question or a plan
review (`--approve` and `--dangerously-skip-permissions` are refused); it can delete, archive or rename only sessions it
started. A caller whose session cannot be identified counts as `ask`. Sub-agents the engine starts through its own tools
are a different path and are unchanged.

**Another data directory** is not yours to protect: `mendcode --dir /tmp/x …` from a session's shell talks to another
daemon and is not held back by the tool or the CLI (that daemon applies the same rules to its own sessions). `upgrade` and
`uninstall` are refused whatever directory they name.

**Known limits.** On Windows, and with `MENDCODE_V2_LOCAL_TRANSPORT=tcp`, the socket carries no process identity: the CLI's
refusal and the tool's are what is left. On macOS a hand-written client (not the CLI) that both starts a new terminal
session and detaches from its parent is not recognised. A `!command` you type in the prompt runs through the same tool and
is refused like the model's; run it in your terminal. A hook script that calls a write command is refused too. If your own
shell has a file-size `ulimit` below the daemon's, the CLI is treated as agent-origin: start the daemon from that shell.

**When you do want the agent to change a setting,** it will tell you the command or the `/settings` row; you run it.
There is no approve-and-apply prompt for these writes.

## Control plane

```text
mendcode control-plane permissions status
mendcode control-plane permissions set-default approval|smart|full_access
mendcode control-plane permissions set-reviewer-role small
```

`approval` maps to `ask`, `full_access` to `full`; native names `ask|edits|full` are accepted too. `set-reviewer-role`
selects an existing v2 model role; unset role model means reviewer off, without fallback. It does not change a model
or make provider calls. Defaults and policy are daemon-owned, persist across restarts, and publish `settings.changed`.
Protocol: `permissions.status` is read-only; `permissions.set-default` and `permissions.set-reviewer-role` mutate settings.
Typed client helpers use those same commands. Every example can be isolated with `--dir <temporary data directory>`.
