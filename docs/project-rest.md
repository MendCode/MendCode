# Project, worktree and workspace REST (B85)

Use these REST routes to manage projects, worktrees, workspaces and local sync through the existing opt-in, loopback HTTP adapter. Start with a full v2 remote token; mutations reject browser Origin requests.

No external sync service or network request starts implicitly.

## Routes

| Route | Payload / response |
|---|---|
| `GET /project`, `GET /project/current` | Array of known projects / selected project |
| `POST /project/git/init` | Empty body; refreshed project, stable ID |
| `PATCH /project/:projectID` | Optional `name`, `icon: {url?, override?, color?}`, `commands: {start?}`; updated project |
| `GET /path` | `home`, `state`, `config`, `worktree`, `directory`; v2 state/config use the explicit daemon data directory |
| `GET /vcs`, `GET /vcs/diff?mode=git\|branch` | Branch/default branch; array of `{file, patch, additions, deletions, status}` |
| `GET /experimental/worktree` | Daemon-created worktree directories |
| `POST /experimental/worktree` | Optional `{name?, startCommand?, runStartup?}`; checked-out `{name, branch, directory}` |
| `DELETE /experimental/worktree` | `{directory}`; `true` after safe removal |
| `POST /experimental/worktree/reset` | `{directory}`; `true` after reset to the locally known default branch |
| `GET /experimental/workspace/adapter` | Native `worktree` and `local` adapters |
| `GET /experimental/workspace`, `GET /experimental/workspace/status` | Project-scoped arrays of workspaces / connection statuses |
| `POST /experimental/workspace` | `{id?, type: "worktree"\|"local", branch: null, extra?: {name?, directory?, runStartup?}}`; workspace |
| `DELETE /experimental/workspace/:id` | Removed workspace; 204 when missing |
| `POST /experimental/workspace/warp` | `{id: workspaceID\|null, sessionID}`; 204 |
| `POST /sync/start` | Empty body; `true` for the authoritative local store |
| `POST /sync/history` | Aggregate-to-last-known-sequence map; array of `{id, aggregate_id, seq, type, data}` |
| `POST /sync/replay` | `{directory, events: [{id, aggregateID, seq, type, data}]}`; `{sessionID}` |
| `POST /sync/steal` | `{sessionID}` with a workspace selector; `{sessionID}` |

## Select a project or workspace

Selectors use the existing `directory` / `x-opencode-directory` and `workspace` / `x-mendcode-workspace` contracts.

| Scope | Routes |
|---|---|
| Global known projects | `GET /project` |
| Selected project | Workspace lists, sync history and all mutations |

Project metadata lives privately in `<dir>/project-rest.json`. Reads discover known projects, matching v1's discovery behavior.

The donor HTTP envelope is preserved with native v2 project/session/workspace IDs and event types. The earlier native `{adapter: "local", name, directory}` workspace registration payload retains its `{workspace}` response. Native framed commands remain compatible.

## Create a worktree

Worktree execution is separate from B30's unchanged preview commands. Creation checks out HEAD before replying and records ownership.

Automatic startup is off. To run startup in the new worktree, set `runStartup: true`:

1. The project's saved start command runs.
2. `startCommand` runs after it.

Startup has a 30-second deadline per script, suppresses output, and retains the worktree on failure. No Git hooks, credential prompts, fetch or pull are run.

Worktree mutations serialize within this service and hold project leases that reject competing session creation. Daemon shutdown cancels pending Git/startup work before closing the store.

## Remove or reset a worktree

Remove/reset reject base/external/drifted/dirty worktrees, ignored files and directories with sessions or automation.

Removal also refuses unmerged commits. It then:

1. Moves the directory to `<dir>/trash/worktrees`.
2. Unregisters it.
3. Deletes its merged branch.

Reset preserves the previous HEAD under `refs/mendcode/worktree-backups` before changing the branch.

**Warning:** Force deletion, dirty reset/clean and implicit startup after reset remain intentionally unavailable. These safeguards are the conservative B85 decision and limit SERVER-014/015 parity.

## Register or remove a workspace

| Adapter | Behavior |
|---|---|
| Local | Registers an existing directory and never deletes its files |
| Worktree | Assigns a unique branch (`branch: null`) |

Caller-selected branch reuse, remote/custom adapters and provisioning services remain unsupported. Before removing a workspace, warp its sessions out.

## Move sessions with warp

Warp moves a settled root session and its children atomically. It appends `session.workspace.changed`, releases stale actors/grants, and retains transcripts/model history.

The move is blocked by:

- Active turns or queued work.
- Unfinished goals or approvals.
- Active automation or external-engine bindings.

The existing chat applies the new directory and refreshes its branch/diff/MCP state without new chrome.

For an HTTP/WebSocket attachment scoped to the old workspace, reconnect to the target workspace before submitting another command. An old project-scoped connection never gains access to the destination implicitly.

## Read and replay sync history

Sync uses zero-based HTTP sequences (`native seq - 1`). History is paged to 2,000 events / one protocol frame.

1. Read a page of history.
2. Advance each aggregate cursor to its last returned sequence.
3. Read another page when `x-mendcode-sync-more: true` indicates one. Native replies also include `hasMore`.

### Native replay

Complete native histories starting at zero can be replayed into a new root session, preserving IDs, timestamps and model context. Exact retries are idempotent.

A replay may also continue a stored session:

- Events at or after the stored end are appended with their model messages; a gap returns 409.
- Overlapping events must equal the stored ones (otherwise 409), and the combined history must be settled.

Validation finishes before the transaction.

### Store blobs before replay

Events that reference blobs (`blob`, `attachments`) need them stored first. These native extensions require a full token:

| Route | Payload and limits |
|---|---|
| `POST /sync/blob` | `{sha256, bytes, mime, offset, data}`; base64 chunks of at most 128 KiB in order, up to 8 MiB, hash verified on the last chunk |
| `POST /sync/blob/read` | `{sha256, offset}`; project blobs only |

### Donor v1 replay

A donor v1 history replays as one complete snapshot from sequence zero. Accepted types are `session.created.1`, `session.updated.1`, `message.updated.1`, `message.part.updated.1`, `message.removed.1`, `message.part.removed.1`, also `@1`.

Its final messages and parts become native turns, items (text, reasoning, finished tool calls) and errors. IDs derive from the donor's, so a repeated replay is an exact retry.

The following are rejected:

- Donor file, subtask and compaction parts.
- `session.deleted` and other donor types.
- Incremental donor batches and unfinished runtime work.

The session directory is the selected project. Runtime work is never resumed.

### Local sync limits

Local workspaces share one authoritative store, so `sync.start` requires no background loop. Cross-daemon/remote synchronization remains open for SERVER-122.

## Implementation and frames

Native clients use `restProject(directory, input)`. `project.rest` is deliberately excluded from `READ_ONLY_COMMANDS`.

Frames of the existing chat before warp, after warp and after detach:

```sh
bun scripts/render-frames.ts .agents-frames/B85 --b85 100x30 180x50
```
