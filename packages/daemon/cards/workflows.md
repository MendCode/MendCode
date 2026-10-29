---
summary: multi-agent runs in stages with checks; compare models; scripts
docs: workflows, compound, sessions, workflow-rest
aliases: workflow, orchestrate, pipeline, fanout, compare-models, compound, stages, dag, multi-agent
---
For: "split this into stages, two in parallel, then check", "review every file with its own agent", "try this with three models and compare", "run the tests as a gate".

A workflow is a plan of tasks run in dependency order, each agent task in its own child session, then a completion contract (checks plus an optional read-only auditor) decides whether it is done. Simple or one-off delegation is cheaper as task calls ({{program}} docs subagents).

Model tools (tier balanced; the live line says if on):
  workflow_start {name, objective, tasks: [{kind: agent|check|human, id, prompt|command, needs, mode: read|work}], contract, permission, maxConcurrent}: a static plan. It asks for approval and shows every check command verbatim; checks run outside the permission system. Put tests in contract.checks, not in prompts. Only one work task runs per directory at a time. Task prompts must be self-contained.
  workflow_script {script | name, args?, help?}: JavaScript that decides at run time which agents to start (agent, parallel, pipeline, phase, merge). Declare meta.budget.agents above 10 calls (200 is the hard limit). It asks in every permission mode, with the source and its hash; help: true returns the API without asking. Find it with tool_search.
  workflow_status {workflowId?}, workflow_control {workflowId, action: pause|resume|stop|retry|delete}, workflow_save: follow and steer a run, keep a plan. After starting, do not poll: tell the user it runs in /workflows. verify and accept are the user's (accept declares the work done despite the contract).
A cap never kills a run: it pauses with the reason; the user raises it (/workflows budget <id> agents=80 usd=5) and resume pays only for unfinished calls. A cost cap on an unpriced model pauses the run rather than spend blind.

The user: /workflows (alias /wf): run <file.js|name> [key=value] [--yes], new <name>, convert <plan.json>, budget, update, resume; keys p pause, x stop, t retry, v verify, a accept, d delete, b evidence ledger. CLI (the user's; from your shell only list and show): {{program}} workflow run|start|list|show|pause|resume|stop|approve|reject ... --wait. Saved scripts: workflows/<name>.js in the data dir (a project's need /tools trust).

Compare models: /fanout "prompt" modelA modelB ... (2 to 8 models; full tier, /tier fanout on) runs each in its own worktree and keeps the branches; /fanout compare, open N, changes N review them. It never commits or merges for the user. /compound is a read-only inspector for single, cascade and critic runs configured in ai.json (off when the file is absent).

Not possible: a workflow outliving a daemon restart without the user resuming it (interrupted tasks restart, at most 3 starts); a model approving its own human gate; running a project's saved script before the project is trusted.

Check: workflow_status lists tasks, phase and caps in use; /workflows shows the same. Say when a run is paused or blocked and why; do not call it finished.
