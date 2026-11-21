# Thread MCP bridge

Use the thread MCP bridge to let Claude Code, Codex and configured ACP agents work with MendCode sessions and delegate to its other models. The bridge requires full tier and stays off until you opt in for each engine.

## Enable the bridge

1. Turn it on in the terminal with `/tier thread_mcp on claude codex acp:<name>`. This enables those engines and the `thread_mcp` feature, keeping the ones already on.
2. To take one engine out, use `/tier thread_mcp off codex`.

Alternatively, apply this host-local `settings.set` patch through the client or SDK:

```json
{
  "tier": "full",
  "threadMcp": { "claude": true, "codex": true, "acp": { "gemini": true } }
}
```

MCP and `thread_mcp` must also be enabled. Safe mode and other tiers refuse the bridge even with feature overrides.

- Settings changes apply to new processes and revoke access to existing leases when disabled.
- There is no listener or temporary configuration until an opted-in turn starts.
- Remote/peer clients cannot change these settings or submit turns to bridge-enabled engines.
- Cross-engine `task.run` and model delegation are local only.

## Engine configuration

The daemon injects `claude --mcp-config <temporary JSON>` or Codex `-c mcp_servers.mendcode_threads.url=...` and `-c mcp_servers.mendcode_threads.http_headers=...`. It never edits the user's Claude or Codex configuration. These fields follow the official [Claude CLI reference](https://code.claude.com/docs/en/cli-reference) and [Codex configuration reference](https://developers.openai.com/codex/config-reference).

### ACP requirements

For ACP v1 the same loopback server and bearer are supplied in `session/new` or `session/load`'s `mcpServers` list as an HTTP entry with an Authorization header.

The agent must advertise `mcpCapabilities.http`. Missing support refuses the turn before session creation rather than silently omitting the bridge. See the [ACP v1 session contract](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v1/session-setup.mdx).

Opt-in is keyed by the exact configured agent name. ACP bridge processes stop after each turn; normal ACP processes keep their existing idle lifetime. No bearer is passed in ACP process arguments, traced or persisted.

## Follow child sessions

Daemon-owned `delegate_task` and `thread_create` children appear under their owner in `/tree` and the agents card, including from a child session.

They carry the configured model, live/completed state and a bounded redacted result headline. Result headlines are omitted for remote/peer clients.

Creation and turn changes invalidate the lineage display. Idle children and their descendants survive restart through existing session/lineage storage.

### Spawn budget

Task and idle bridge children share a persisted 256-spawn budget per root, separate from active concurrency. Idle child lineage carries the same configured depth ceiling into later delegation.

Resuming an existing task does not spend another spawn; replaying a request never creates another child. Counters survive deletion of task rows and restart.

## Process lifetime

Each bridge process serves one session's turn, then stops; engine bindings resume the conversation next turn. This trades process startup latency for strict isolation and revocation, including when switching projects or engines.

Claude Code's background agents (and Claude Code's own answer when one ends) live inside its process. When a bridged turn ends with background agents still running, its process is kept instead:
- The session's next turns run in that same process, so the agents live on.
- That process was started with the earlier turn's bearer. The bridge accepts it for the same session's live turn, until one hour after it was issued; it never answers for another session. The listener opens again on the port it had, so the process's config still reaches it.
- It stops once no background agent is left, and the next turn starts a new bridged process.

A process without the bridge that still runs background agents also keeps the session's turns.

### Lease limits and security

| Resource | Rule |
|---|---|
| In-memory bearer | Expires after 10 minutes idle or 1 hour maximum; revoked on cancellation, process release or daemon shutdown |
| HTTP listener | Binds only `127.0.0.1`; rejects browser origins and alternate hosts/routes |
| Requests | Bounded to 64 KiB |
| Concurrency | One tool call at a time per lease; calls sent together (Claude Code sends parallel calls at once) wait their turn instead of failing |
| Call budget | A lease takes 200 calls; the 201st answers "Bridge call limit reached: 200 calls in this turn" |

Claude's generated file is mode 0600 in a private temporary directory and removed with the lease. Codex's token is passed only in process arguments.

Bearers are scrubbed from events, approvals and responses, including text split across streaming deltas. Raw process tracing is disabled for bridge turns.

## What the model is told

The server's MCP `instructions` say that `delegate_task` runs MendCode's models, not only the harness's own. Claude Code's Agent tool runs only Claude models.

Claude Code puts these instructions in its system prompt. Codex keeps them out, so they join its thread's developer instructions.

The instructions name models by engine as of the turn's start: `native: gpt-6.1-terra, gpt-6-luna; codex: codex:gpt-6-sol; acp:gemini: ...`.

- Ten ids per engine and a count of the rest are included.
- The session's own engine and the engines `delegate_task` does not take are left out.
- This costs about 140 tokens with a ChatGPT login alone, about 270 with large API and ACP catalogs.
- Claude Code is also told the ToolSearch line that loads the deferred tool.

A model the user names by its display name (6.1 Terra) is one of those ids. A model id may be the reference `mendcode models` prints (`chatgpt/gpt-6.1-terra`, `claude/claude-opus`).

Without the bridge, a Claude Code, Codex or ACP session whose MendCode tools (`harness_tools`) are on is told in one line of their instructions (about 50 tokens) that sub-agents on MendCode's other models need the full tier and `/tier thread_mcp on <engine>`, so it says that instead of that the model does not exist.

## Tools

- `thread_list {limit?, query?, state?}`: other sessions in the same project, bounded metadata only, in the compact form of [`sessions`](peers.md#sessions): 10 by default, `limit` up to 100 (more returns 100 and says so), `query` filters titles, `state` is `busy` or `idle`. Its ids are the short ones; every thread tool takes them.
- `thread_create {title}`: an idle child session, with the parent's model and permission ceiling. Send a message to start it.
- `thread_message {sessionId, text}`: the existing bounded peer queue, with its pending-message and rate limits.
- `thread_wait {sessionId, timeoutSeconds?}`: at most 120 seconds; timeout does not cancel the target.
- `thread_read {sessionId, limit?, before?}` and `thread_search {sessionId, query, limit?, before?}`: bounded redacted history, no reasoning, no cross-project access. Secret values never resolve across threads.
- `thread_interrupt {sessionId}`: cancel the target's running turn.
- `delegate_task {description, prompt, engine?, model?, variant?, agent?, background?, task_id?}`: a child agent with fresh context; `task_id` continues a child this session started, with its history, and with `model` it goes on on that model (after a usage limit, or a cheaper one). Default async; `background:false` waits. Uses the existing task registry, lineage, depth/child/descendant caps and quoted untrusted owner wake. `engine` is `native`, `claude`, `codex`, `pi` or `acp:<configured-name>`; choosing an engine requires an exact configured `model` belonging to it (no automatic provider/model fallback). Native provider models retain their exact `<provider>:<model>` ids. Custom tool/path restrictions that an external child engine cannot enforce are refused; choose a general agent or native engine.
- `orchestrator_capabilities`: this surface and its limits.

## Permissions and failures

Cross-session `thread_read`, `thread_search` and `thread_wait` require an explicit `@thread` grant for that target or individual user approval for each operation, including full/edits modes.

- Allow rules and session-scoped answers cannot grant future history reads.
- Explicit deny rules still win and are checked again after approval.
- Plan mode permits individually approved reads but refuses all mutations, including delegation; child modes inherit or narrow.
- Other mutations use normal host/project/agent/session permission rules.

Codex applies the [turn sandbox policy](https://developers.openai.com/codex/app-server) on each resumed turn: read-only in plan, workspace-write with network disabled otherwise.

The `task` tool and `task.run` also accept `engine` in full tier. `delegate_task` with an `engine` needs that engine's exact `model`; when it is missing or belongs to another engine, the error lists that engine's model ids.

A bridge call that fails answers `Thread operation failed: <cause>` (a limit, an unknown task, the tier, the model), with the bearer redacted. The calling agent can correct its next call.

Mutating bridge tools accept `clientRequestId` for retries within the lease; repeating a key with changed arguments fails. No arbitrary shell, filesystem or network tool is exposed by this server.

## Codex models and compatibility

Opting in to Codex on a native daemon also lists `codex:<subscription-model>` entries, routed lazily to the user's own `codex app-server`, started with `-c web_search="live"`: its sandbox gives a turn no network, so live search is how a Codex agent, a delegated sub-agent included, looks anything up. Installed engines keep their own login; no provider is contacted to enable the bridge. Missing executables fail through the normal turn error path.

Not included: HTTP MCP injection into pi, or projection of engine-internal nested agents into local lineage. Only daemon-owned children are shown. Acceptance uses local fake ACP/engine transports and in-memory HTTP requests; real external engine interoperability remains unverified.
## Durable mutation receipts

`clientRequestId` now scopes mutations by canonical project, owner session and operation. The daemon persists a hashed argument digest plus redacted bounded result before returning the ACK.

| Retry condition | Result |
|---|---|
| Same key/arguments | Replays across leases/restarts; permissions and grants are rechecked before replay |
| Changed arguments | Conflict |
| Pending receipt after a crash | Reports unknown dispatch outcome and never repeats the effect; inspect the target before deliberately choosing a new ID |

Owners retain at most 256 receipts; old keys are not evicted and silently reused. ACK records dispatch, while child task/turn state owns completion.

### Native task retries

Native `task.run` also accepts `input.clientRequestId`; its durable receipt references the original task/generation. Retry does not create a child or resend a prompt.

A resumed newer generation/deleted child makes the old receipt unreplayable. Accumulated admissions are capped at 256 per task root independently of active-child/descendant caps; resuming an existing task remains possible. Wait timeouts still do not cancel.
