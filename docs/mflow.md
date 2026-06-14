# mflow Coordination

mflow is an optional coordination layer for agents working in the same repo. In MendCode it is local-first and used to prevent edit collisions, not to magically merge conflicting code.

## What mflow Does

When enabled, MendCode checks the files a tool wants to edit before `write`, `edit`, `multiedit`, or `apply_patch` runs. For each target file, it:

- normalizes the path inside the project
- acquires a short local lease
- asks the mflow CLI for a lock
- waits and retries when another agent owns the file
- releases/discards local locks after the tool finishes

That means 2, 10, or many more subagents can try to work in the same worktree or local file set. If they touch different files, they proceed. If they touch the same file, the later tool call waits until the lock clears or times out. This is coordination, not conflict-free semantic merging.

## Install / Runtime Package

MendCode selects the npm package `mflow-cli`. The npm name `mflow` is reserved by an unrelated package, so do not install `mflow` expecting this integration.

MendCode's mflow command helper uses:

```bash
pnpm dlx --package mflow-cli ...
```

## Setup

Inspect status:

```bash
mendcode mflow status
```

Start a guided setup:

```bash
mendcode mflow setup
```

Activate with a local relay:

```bash
mendcode mflow activate --room acme/main
```

Activate with an explicit public relay you control:

```bash
mendcode mflow activate --relay public --signaling wss://relay.example.com --room acme/main
```

The legacy public relay is demo-only. It requires explicit acknowledgement and should not be used for normal team onboarding.

## Relay Modes

- `local`: default, `ws://localhost:8787`.
- `public`: a WebSocket relay URL controlled by your team.
- `legacy-public`: old shared demo relay; not recommended.
- `remote`/`custom`: normalized to public mode.

Local relay examples from the generated guide:

```bash
PORT=8787 bun run packages/signaling/src/index.ts
docker build -f packages/signaling/Dockerfile -t mflow-signaling .
docker run --rm -p 8787:8787 -e PORT=8787 mflow-signaling
```

## Files Written by Setup

mflow activation writes local scaffold/config files:

- `.mendcode/mflow/state.json`
- `.mendcode/mflow-control.md`
- `.mendcode/plugins/mflow-lock.js`
- `.mendcode/mcp/mflow.json`
- `.mflow/config.toml`
- `.mflowignore`
- optionally `.mendcode/mflow/secret.local`

Secrets should stay local. If `storeSecret` is false, the secret is stored in `.mendcode/mflow/secret.local`; otherwise the runtime config may contain it and must remain local/private.

## Deactivate or Remove

```bash
mendcode mflow deactivate
mendcode mflow remove
```

Deactivate disables mflow without deleting all local scaffold. Remove deletes the local mflow config/scaffold files that MendCode owns.

## Operational Notes

- mflow is disabled by default.
- MendCode does not ping/check relays while disabled.
- The footer can show waiting/lock status.
- Reads can wait behind active edit locks.
- A lock wait can time out; the agent should retry or split the task.
- mflow does not replace Git review, tests, or human conflict resolution.
