# herdr and tuios

The [herdr](https://herdr.dev) and [tuios](https://tuios.dev) sidebars show what your MendCode session is doing, just as they do for built-in agents. There is nothing to install: no hook and no plugin.

Run `mendcode` in a herdr or tuios pane to see the session's state in the sidebar.

## Read the pane's state

| State | What it means |
|---|---|
| **Working** | A turn is running: answering, running a tool or compacting. |
| **Blocked** | A tool call waits for approval. The request is its message (`approve shell: git push`); tuios lists it as `needs_input` in its Inbox. |
| **Idle** | Nothing runs. herdr and tuios show a turn that just ended as done until someone looks at the pane. |

The state is the terminal's own session, the one on screen. The side chat (`/btw`) does not change it.

A sub-agent waiting on an approval or a question holds the pane as **blocked** too. The message names the sub-agent and what it waits on (`Fix the flaky test: Allow shell`). herdr has no sub-agent rows, so this is how a waiting child shows there.

### Resume or leave a session

Each report includes the session id and its resume command (`mendcode --session <id>`), so the multiplexer can bring the session back after a restart.

Quitting MendCode releases the pane. If MendCode is killed, the multiplexer clears it once the pane's shell prompt is back.

## Inspect a session in tuios

Inside tuios, `tuios get-agent-state` and `tuios list-agents` name the harness `mendcode`. This lets `ask-agent`, `wait-for` and `fan` tell when the pane is busy.

### Model, context and cost

In a tuios pane (`TUIOS_ENV=1`), the rail shows three facts under MendCode's row:

| Fact | Shows |
|---|---|
| `model` | The session's model. |
| `context` | How full the context is, as the prompt's status shows it. |
| `cost` | What the session has cost, when it has a price. |

`tuios get-agent-state --json` lists these facts under `meta`. A fact that goes away is removed, and tuios drops them all when MendCode leaves the pane.

The facts are sent as `tuios set-agent-meta` would write them, with source `mendcode`, on tuios's own socket (`TUIOS_SOCKET`, for the pane `TUIOS_PANE_ID`). They are sent only when one changes. `MENDCODE_HERDR=0` turns this off too.

### Follow sub-agents

Under MendCode's row, tuios lists the same session sub-agents that the Agents strip shows:

- The daemon's child tasks (`task` and `delegate_task`, on any engine).
- Sub-agents an engine runs inside the session: Claude Code's Agent calls, in the foreground or the background.

A sub-agent Codex or pi runs inside its own turn is not reported: those engines do not tell MendCode about them.

Each sub-agent's activity starts with its type: agent, model and engine, as `explore · Sonnet 5.5 · claude`. It says what the sub-agent was asked and the tool it runs, then ends with its outcome:

| Outcome | Shows |
|---|---|
| Done | The first line of its answer. |
| Failed | Its error. |
| Stopped | That it stopped. |

`tuios list-agents --json` shows the children in `subagent_list` and counts the running ones in `subagents`.

### When the child list clears

Another session opened in the pane, and the first report of a new MendCode process, start with `session_start`. tuios forgets the children it had, so none is left from a session switch, a crash or a restart.

- A child that leaves the list while running is stopped.
- Quitting clears the children.

## How reporting works

MendCode reports when it finds herdr's pane variables, `HERDR_SOCKET_PATH` and `HERDR_PANE_ID`. herdr sets them in its panes; tuios sets them in every pane because it answers herdr's socket API.

Each change of state is one `pane.report_agent` request on that socket, with source `mendcode`. The same state again sends nothing.

A multiplexer that is gone or slow costs the session nothing: a report gives up after two seconds. `MENDCODE_HERDR=0` turns reporting off.

Sub-agent activity uses `report-agent-activity` on tuios's socket, and only changes are sent. These reports carry the harness `mendcode` and the session's id, so tuios never puts them on another agent.
