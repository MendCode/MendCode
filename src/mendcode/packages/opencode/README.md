# MendCode Runtime Package

This package contains the MendCode runtime, TUI, CLI commands, session pipeline, and local memory system.

## Memory system

The runtime includes a local persistent memory layer for user preferences and project decisions. It is opt-in, editable, and approval-gated:

- input memory reads relevant saved memories into the prompt
- memory learning creates pending proposals after chats or imports
- proposals do not affect future prompts until a user applies them
- global memory lives in `~/.local/share/mendcode/memory/`
- project memory lives in `.mendcode/memory/`

Useful commands:

```bash
mend memory status
mend memory config --enable --input --output
mend memory add "User prefers local-only workflows." --scope global --tags preference
mend memory list
mend memory apply <proposal-id>
mend memory edit <entry-id> "Updated memory text." --scope project
```

`mend memory config` writes global memory config by default. Add `--project` only for a repo-local override.

The learning policy and proposal extraction rules live in:

```text
src/mendcode/packages/opencode/src/mend/memory/proposals.ts
```

For the complete user and maintainer guide, see `../../../../docs/memory-system.md`.
