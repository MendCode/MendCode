# Loop Workflows

Loop Workflows are durable, monitorable agent loops for work that should keep moving in controlled iterations. They are closer to an inspectable workflow runner than to a single long chat turn.

The design goal is simple: a user can turn an objective into a loop, see it in Agent View, inspect every wakeup, and choose how much execution power the loop gets.

## Mental Model

A loop has four layers:

- Workflow: the durable DB record with objective, state, trigger, gates, policy, metrics, and next wakeup.
- Root session: the chat session created when the loop is activated. It appears in Agent View as a background looping session.
- Run: one wakeup/iteration of the loop.
- Journal: durable events such as created, activated, wake, started, completed, failed, paused, resumed, and stopped.

The DB remembers the workflow even when MendCode exits. A live process is still required to wake due loops.

## Basic Flow

List built-in loop examples:

```bash
mendcode loops examples
```

Create a draft from a template:

```bash
mendcode loops draft --template research-digest --name "Loop test"
```

Create a draft from a custom objective:

```bash
mendcode loops draft --name "CI repair" --objective "Keep checking CI and propose fixes until the branch is green."
```

Activate the workflow:

```bash
mendcode loops activate loop_...
```

Activation creates a root session named `Loop: <name>`, registers it in Agent View as a background loop, records the root loop thread, and schedules the first wakeup.

Activation also attempts to ensure the project loop service is installed and started. Use `--no-service` only for admin/debug flows where you explicitly do not want OS-backed wakeups.

Inspect it:

```bash
mendcode loops status
mendcode loops show loop_...
mendcode loops tail loop_...
mendcode loops monitor loop_...
```

`monitor` is the terminal view for one loop. It refreshes the workflow state, child thread list, and journal while the command is running.

## Tick Modes

`tick` is the manual wakeup command.

Dry-run preview:

```bash
mendcode loops tick loop_...
```

This does not call the agent. It only reports what would run.

Safe execution/report-only:

```bash
mendcode loops tick loop_... --execute --report-only
```

This wakes the agent in the loop root session, writes transcript/UI activity, and denies edit, write, patch, shell, and subagent tools. Use this for first UI tests and monitor validation.

Full execution:

```bash
mendcode loops tick loop_... --execute
```

This wakes the real agent with the normal session/runtime permissions. Use it only in a repo where automatic edits and commands are acceptable.

## Daemon And Service

There are two background modes.

Terminal daemon:

```bash
mendcode loops daemon --execute --report-only
```

This keeps checking due loops while that terminal/process is alive. If you close the terminal or kill all MendCode processes, it stops. The workflow remains durable in the DB, but nothing wakes it until another daemon, service, or manual tick runs.

OS service:

```bash
mendcode loops service install
mendcode loops service start
mendcode loops service status
mendcode loops service logs
```

The service is installed per project and runs with that project as its working directory. It survives closing MendCode or the terminal because the OS owns the process.

Backends:

- macOS: LaunchAgent under `~/Library/LaunchAgents`.
- Linux: user systemd unit under `$XDG_CONFIG_HOME/systemd/user` or `~/.config/systemd/user`.
- Windows: Task Scheduler task plus a generated command file under `%LOCALAPPDATA%\MendCode\Loops`.

If the default directories do not work on a machine, override them:

```bash
mendcode loops service start --service-dir /path/to/service-defs --log-dir /path/to/logs
```

Environment overrides are also supported:

```bash
MENDCODE_LOOP_SERVICE_DIR=/path/to/service-defs
MENDCODE_LOOP_LOG_DIR=/path/to/logs
```

Project config can set the same defaults in `.mendcode/mendcode.json`:

```jsonc
{
  "loop": {
    "serviceDir": "/path/to/service-defs",
    "logDir": "/path/to/logs",
    "defaultServiceMode": "report-only"
  }
}
```

`defaultServiceMode` accepts `dry-run`, `report-only`, or `execute`. Keep `report-only` for normal team defaults.

The service default is intentionally safe:

```bash
mendcode loops service start
```

This runs the loop daemon as `--execute --report-only`: the agent wakes and reports, but cannot edit files or run shell/subagents.

Other service modes:

```bash
mendcode loops service start --dry-run
mendcode loops service start --allow-edits
```

- `--dry-run`: wakes the scheduler but does not call the agent.
- default: calls the agent in report-only mode.
- `--allow-edits`: full execution with normal runtime permissions.

Stop or remove:

```bash
mendcode loops service stop
mendcode loops service uninstall
```

`uninstall` removes the OS service definition. It does not delete loop workflows, sessions, runs, or journal events.

In product UX, users should not need to run these commands for normal loop creation. They are the admin/debug surface. The chat/session flow should create the workflow, activate it, and ensure the project service is installed/started automatically.

## What Shows In The TUI

Agent View groups activated loop root sessions under `Looping`.

Opening a loop root session shows a loop banner in chat. A report-only tick should produce transcript activity without file edits. A full execution tick behaves like a normal agent turn inside the loop root session.

Recommended UI smoke test:

```bash
mendcode loops draft --template research-digest --name "Loop test"
mendcode loops activate loop_...
mendcode loops tick loop_... --execute --report-only
mendcode
```

Then open Agent View, find the session under `Looping`, and inspect the loop banner plus transcript.

Natural session prompt example:

```text
Turn this session into a test loop. Run 5 iterations, inspect the main files in this directory, use analysis subagents when useful, do not edit files, and after each iteration report what is new or different from the previous iteration. When the loop finishes, give me a final summary.
```

Expected product behavior:

1. The agent creates a loop draft from the current session/objective.
2. The agent activates the loop and creates the root loop session.
3. MendCode ensures the project service is installed and started.
4. The root session appears in Agent View under `Looping`.
5. Each iteration writes transcript/journal updates.
6. If the TUI is open, SSE events refresh the view live. If the TUI was closed, reopening MendCode hydrates from durable DB state and shows the latest loop state.

## Built-In Examples

Current built-in templates:

- `pr-watch`: monitor a PR and surface review or CI changes.
- `ci-repair`: keep checking failing CI and propose safe repairs.
- `research-digest`: periodically inspect a topic and summarize changes.
- `repo-maintenance`: review stale work and propose maintenance steps.

Templates create draft workflows. They do not start running until activated.

## Packages And Team Sharing

Loop templates are currently built into the runtime. The package system can already distribute commands, skills, agents, modes, prompts, permissions, model policy, memory defaults, TUI profile, and widgets. Package-distributed loop templates are a natural next step, but they are not yet part of the public package contract.

Installing one runtime package does not have to erase another package. MendCode packages are selected/enabled as runtime overlays. Conflicts are resolved by the package runtime projection rather than by blindly replacing the user's local files. Teams should still document package precedence and avoid shipping secrets or machine-local loop state.

## Safety Rules

- Drafts are inert until activated.
- `tick` without `--execute` is dry-run only.
- `--execute --report-only` wakes the agent but denies mutation and shell/subagent tools.
- `--execute` allows normal runtime permissions.
- Service defaults to report-only, not full edits.
- Human gates should remain required for push, merge, release, and other irreversible actions.
- Loops are project-scoped; install/start the service from the repo that owns the workflows.
- Normal users should create loops from chat/session intent. CLI commands remain for inspection, debugging, and automation.

## Troubleshooting

No loops run:

```bash
mendcode loops status
mendcode loops tick --limit 1
```

If the workflow is durable but no process is alive, start a daemon or service.

Service installed but not waking:

```bash
mendcode loops service status
mendcode loops service logs --lines 120
```

If the service is not loaded, run:

```bash
mendcode loops service restart
```

For temporary debugging, prefer the foreground daemon:

```bash
mendcode loops daemon --execute --report-only
```

That prints every scheduler pass directly in the terminal.
