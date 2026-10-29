# Thread MCP bridge

Task and idle bridge children share a persisted 256-spawn budget per root, separate from active concurrency. Idle child lineage carries the same configured depth ceiling into later delegation. Resuming an existing task does not spend another spawn; replaying a request never creates another child. Counters survive deletion of task rows and restart.

Full tier only, off by default, with a separate opt-in for Claude Code, Codex and each configured ACP agent. In the terminal, `/tier thread_mcp on claude codex acp:<name>` turns it on for those engines (and the `thread_mcp` feature), keeping the ones already on; `/tier thread_mcp off codex` takes one out. Or apply this host-local `settings.set` patch through the client or SDK:

```json
{
  "tier": "full",
  "threadMcp": { "claude": true, "codex": true, "acp": { "gemini": true } }
}
```

MCP and `thread_mcp` must also be enabled; safe mode and other tiers refuse the bridge even with feature overrides. Settings changes apply to new processes and revoke access to existing leases when disabled. There is no listener or temporary configuration until an opted-in turn starts. Remote/peer clients cannot change these settings or submit turns to bridge-enabled engines. Cross-engine `task.run` and model delegation are local only.

The daemon injects `claude --mcp-config <temporary JSON>` or Codex `-c mcp_servers.mendcode_threads.url=...` and `-c mcp_servers.mendcode_threads.http_headers=...`. It never edits the user's Claude or Codex configuration. These fields follow the official [Claude CLI reference](https://code.claude.com/docs/en/cli-reference) and [Codex configuration reference](https://developers.openai.com/codex/config-reference).

For ACP v1 the same loopback server and bearer are supplied in `session/new` or `session/load`'s `mcpServers` list as an HTTP entry with an Authorization header. The agent must advertise `mcpCapabilities.http`; missing support refuses the turn before session creation rather than silently omitting the bridge. See the [ACP v1 session contract](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v1/session-setup.mdx). Opt-in is keyed by the exact configured agent name. ACP bridge processes stop after each turn; normal ACP processes keep their existing idle lifetime. No bearer is passed in ACP process arguments, traced or persisted.

Daemon-owned `delegate_task` and `thread_create` children appear under their owner in `/tree` and the agents card, including from a child session. They carry the configured model, live/completed state and a bounded redacted result headline. Creation and turn changes invalidate the lineage display; idle children and their descendants survive restart through existing session/lineage storage. Result headlines are omitted for remote/peer clients.

Each bridge process serves one session's turn, then stops; engine bindings resume the conversation next turn. This trades process startup latency for strict isolation and revocation, including when switching projects or engines.

Claude Code's background agents (and Claude Code's own answer when one ends) live inside its process. When a bridged turn ends with background agents still running, its process is kept instead:
- The session's next turns run in that same process, so the agents live on.
- That process's bridge belonged to the earlier turn. Until it stops, the thread tools answer that the bridge is gone.
- It stops once no background agent is left, and the next turn starts a new bridged process.

A process without the bridge that still runs background agents also keeps the session's turns. The in-memory bearer expires after 10 minutes idle or 1 hour maximum and is revoked on cancellation, process release or daemon shutdown. The HTTP listener binds only `127.0.0.1`, rejects browser origins and alternate hosts/routes, bounds requests to 64 KiB and runs one tool call at a time per lease: calls sent together (Claude Code sends parallel calls at once) wait their turn instead of failing. A lease takes 200 calls; the 201st answers "Bridge call limit reached: 200 calls in this turn". Claude's generated file is mode 0600 in a private temporary directory and removed with the lease. Codex's token is passed only in process arguments. Bearers are scrubbed from events, approvals and responses, including text split across streaming deltas; raw process tracing is disabled for bridge turns.

Tools:

- `thread_list`: other sessions in the same project, bounded metadata only.
- `thread_create {title}`: an idle child session, with the parent's model and permission ceiling. Send a message to start it.
- `thread_message {sessionId, text}`: the existing bounded peer queue, with its pending-message and rate limits.
- `thread_wait {sessionId, timeoutSeconds?}`: at most 120 seconds; timeout does not cancel the target.
- `thread_read {sessionId, limit?, before?}` and `thread_search {sessionId, query, limit?, before?}`: bounded redacted history, no reasoning, no cross-project access. Secret values never resolve across threads.
- `thread_interrupt {sessionId}`: cancel the target's running turn.
- `delegate_task {description, prompt, engine?, model?, variant?, agent?, background?, task_id?}`: a child agent with fresh context; `task_id` continues a child this session started, with its history, and with `model` it goes on on that model (after a usage limit, or a cheaper one). Default async; `background:false` waits. Uses the existing task registry, lineage, depth/child/descendant caps and quoted untrusted owner wake. `engine` is `native`, `claude`, `codex`, `pi` or `acp:<configured-name>`; choosing an engine requires an exact configured `model` belonging to it (no automatic provider/model fallback). Native provider models retain their exact `<provider>:<model>` ids. Custom tool/path restrictions that an external child engine cannot enforce are refused; choose a general agent or native engine.
- `orchestrator_capabilities`: this surface and its limits.

Cross-session `thread_read`, `thread_search` and `thread_wait` require an explicit `@thread` grant for that target or individual user approval for each operation, including full/edits modes. Allow rules and session-scoped answers cannot grant future history reads. Explicit deny rules still win and are checked again after approval. Plan mode permits individually approved reads but refuses all mutations, including delegation; child modes inherit or narrow. Other mutations use normal host/project/agent/session permission rules. Codex applies the [turn sandbox policy](https://developers.openai.com/codex/app-server) on each resumed turn: read-only in plan, workspace-write with network disabled otherwise. The `task` tool and `task.run` also accept `engine` in full tier; `delegate_task` with an `engine` needs that engine's exact `model`, and when it is missing or belongs to another engine the error lists that engine's model ids. A bridge call that fails answers `Thread operation failed: <cause>` (a limit, an unknown task, the tier, the model), with the bearer redacted, so the calling agent can correct its next call. Mutating bridge tools accept `clientRequestId` for retries within the lease; repeating a key with changed arguments fails. No arbitrary shell, filesystem or network tool is exposed by this server.

Opting in to Codex on a native daemon also lists `codex:<subscription-model>` entries, routed lazily to the user's own `codex app-server`, started with `-c web_search="live"`: its sandbox gives a turn no network, so live search is how a Codex agent, a delegated sub-agent included, looks anything up. Installed engines keep their own login; no provider is contacted to enable the bridge. Missing executables fail through the normal turn error path.

Not included: HTTP MCP injection into pi, or projection of engine-internal nested agents into local lineage. Only daemon-owned children are shown. Acceptance uses local fake ACP/engine transports and in-memory HTTP requests; real external engine interoperability remains unverified.
# Durable mutation receipts

`clientRequestId` now scopes mutations by canonical project, owner session and operation. The daemon persists a hashed argument digest plus redacted bounded result before returning the ACK. Same key/arguments replays across leases/restarts; changed arguments conflict. Permissions and grants are rechecked before replay. A pending receipt after a crash reports unknown dispatch outcome and never repeats the effect; inspect the target before deliberately choosing a new ID. Owners retain at most 256 receipts; old keys are not evicted and silently reused. ACK records dispatch, while child task/turn state owns completion.

Native `task.run` also accepts `input.clientRequestId`; its durable receipt references the original task/generation. Retry does not create a child or resend a prompt. A resumed newer generation/deleted child makes the old receipt unreplayable. Accumulated admissions are capped at 256 per task root independently of active-child/descendant caps; resuming an existing task remains possible. Wait timeouts still do not cancel.
