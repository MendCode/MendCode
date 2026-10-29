---
summary: run sub-agents in parallel or background; continue, list, pause, stop
docs: agents, advanced-config, tiers
aliases: subagent, sub-agents, teams, parallel, delegate, children, task
---
For: "run two agents in parallel", "keep working while it runs", "pause / stop the agent", "continue that agent". A sub-agent is a child session with its own context (task tool). Writing one: {{program}} docs agents.

Model tools (feature subagents, tier balanced; the live lines say if they are on here):
  task {description, prompt, background?, task_id?, agent?, model?, isolation?}: foreground waits; background: true returns a task_id at once. The child cannot see this chat: give the whole prompt and what to return. The description names [[setting:subagentCatalog]] (6) agents; agent: "?" lists all. explore is read-only and returns locations with evidence.
  isolation: "worktree" (feature task_worktree, full tier): the child works in a git worktree of HEAD; its changes end on branch mend/task-<id> (in its result), never merged.
  fork: true (task_fork, opt-in): the child starts from this chat on your model (cached), rereads it each call; prompt only the task.
  Parallel: several task calls with background: true. Each end arrives by itself ([[setting:subagentOwnerWake]], on). Do not poll.
  task_status {action: list|get|wait|cancel, task_id, timeout_ms}: list, read one, wait once (30 s, max 300 s), cancel for good.
  Continue a finished child with its task_id (context kept); with model it goes on on that model (after a usage limit, or cheaper). Not while running.
In a Claude Code or Codex session their own Agent tool cannot change a child's model; delegate_task can (full tier, the user runs /tier thread_mcp on claude; {{program}} docs engines).
A user prompt opening with @name of a child agent goes to that child (queued while it works, kept in <data dir>/agent-mentions.json; [[setting:agentMentions]]).
Children inherit your permission mode (lowered by their agent's cap), work in your directory unless isolated, and lack main-only tools (question, loop, worktree). Two children editing one file clash.
Model: task's, agent's, subagent role, else (cheap_subagents, balanced) your provider's mid tier under a large one (Sol → Luna, Opus → Sonnet; Claude Code too), else yours.

Limits (a call over one fails by name: wait or continue a task_id, do not retry in a loop):
  [[setting:subagentDepth]] 1 (0 turns task off) · [[setting:subagentMaxChildren]] 4 running per parent · [[setting:subagentMaxDescendants]] 16 per tree · 256 started per tree.

The user controls (no model tool): /pause [id] finishes the turn, holds the queue; /unpause; /stop [id] cancels it and every child. /tasks lists children (x cancel, b detach, w wait); /bg detaches to Agent View; /tree; /relaunch restarts Claude Code agents esc stopped.

Retries replay the result (orchestration_receipts); /panel galaxy draws the tree.

Does not exist: a pause tool for the model; a worktree per child by default; a scratch folder per child (/scratch is one note per project); merging children's edits. /fanout compares models. engine: claude|codex|pi|acp:<name> for a child needs the full tier.

Check: a task result names its task_id and state. No notice: say so, do not guess.
