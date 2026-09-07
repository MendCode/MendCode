# Beta integration checkpoint

This is an **incomplete development checkpoint, not a release candidate**. It
combines fast/native compaction, explicit compound-model workflows and beta
reliability work. Package and release versions have not been advanced.

## Implemented paths

- Compaction checkpoints and native/portable capability routing; explicit
  compound plans, immutable snapshots and isolated workflow execution.
- AI configuration inspect/plan/validate/apply through the shared backend,
  serialized compare-and-swap writes and permission-gated CLI/tool/API paths.
- Tool argument replay normalization, bounded retry policy, targeted turn/shell
  cancellation, and computer-tool coordinate handling.
- Serialized release-channel changes, installed-version verification before
  saving a channel, and explicit unsupported Windows handoff errors.
- Shell analysis now consumes the existing tree-sitter AST. Environment values
  are bound by a process-keyed HMAC, and execution uses the frozen reviewed
  environment without merging later process-environment changes. Incomplete
  host analysis cannot be overridden by a textual reviewer classification.

## Important current behavior and blockers

**Shell automatic approval is intentionally unavailable for unverified execution
identities.** Parsing a command does not prove its executable, startup files,
configuration, hooks or filesystem targets. Such commands require confirmation;
the intended eligible Git/read-command automatic-approval corpus is NOT accepted.
The remaining semantic adapters and identity/target revalidation are product
work, not merely missing tests. This checkpoint must not be described as completed
Smart Approval or as an operating-system sandbox.

Other unaccepted criteria include durable cancellation/wake behavior across a
cold restart, Windows deferred channel transitions and real cross-platform
channel round trips, actual public CLI/shared-server multi-client coverage,
provider-backed compaction fidelity/cost canaries, human terminal acceptance and
live computer-use acceptance. Passing local tests does not replace these gates.

## Evidence boundaries

Focused local tests cover the changed compaction/workflow, AI writer and backend
permission, argument replay, retry, cancellation and upgrade paths. Typechecking
passes. The shell-focused checks include the actual parser, a negative command
corpus and local execution tests; their passing result proves the conservative
manual fallback, not the required positive automatic-approval behavior.

Tests use temporary homes/configuration and isolated databases. No schema
migration, installer run, release publication or production deployment is part
of this checkpoint. Packaged binaries, live providers, native UI acceptance and
supply-chain release checks remain separate requirements before release.
