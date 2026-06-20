# Memory Center

Memory Center is the terminal workspace for reviewing what MendCode remembers,
what it is proposing to remember, and how that context is organized.

![MendCode Memory Center overview](assets/screenshots/memory-center-overview.png)

## What The View Shows

The overview keeps memory state visible without turning every chat into
permanent context.

| Area | Purpose |
| --- | --- |
| Project sidebar | Shows the active project and other known project memory scopes. |
| Summary cards | Separates saved memories, pending proposals, project groups, and Dream state. |
| Category graph | Shows how memories are distributed across categories such as security, commands, release, user preferences, and agent policy. |
| Pending Queue | Presents generated proposals for review before they are applied. |
| Inspector | Shows the selected proposal action, progress, and risk summary. |
| Side chat | Lets the user ask memory-specific questions without turning the memory view into the normal coding agent. |

## Review Model

Memory is approval-first:

- saved entries are visible by scope
- generated changes enter the pending queue
- proposals can be applied, rejected, edited, or inspected
- project and global memories stay separate
- Dream state is shown as maintenance context, not as silent mutation

The side chat is intentionally constrained. It can inspect categories, saved
memories, and pending changes; draft memory actions for review; and help explain
category policies. It is not a general implementation agent.

## CLI Pairing

The visual workspace complements the CLI commands:

```bash
mendcode memory status
mendcode memory list --scope global
mendcode memory list --scope project
mendcode memory search "release workflow"
mendcode memory preview "release workflow"
```

Use direct `mendcode memory add` only when the user explicitly asks to save
something. Generated memory changes should stay reviewable.
