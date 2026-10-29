# One process when one terminal is open (solo mode)

Question: if only one terminal is open, why pay for a second process? Answer: you do not have to, if you accept the trade-off
below. With `processMode` set to `auto` (the default since 2026-10-13, in every tier) the terminal hosts the daemon in its own process,
still listening on the normal socket and lock, and hands the directory to a detached daemon only when something needs one.
`daemon` keeps two processes, as before. Measured 2026-10-05 on Apple M4 Pro, Bun 1.3.13, compiled binary, faux engine, temporary
HOME and data directory. The machine was shared: load average 5.5 to 9 during every run (the harness prints it and asks
for a repeat above 3; it could not be repeated on an idle machine), so absolute numbers are noisy and only large, repeated
differences are used below.

## Where the memory goes

Two-process shape, empty session, compiled binary (RSS; the client column is the real CLI in a pseudo-terminal, the probe
column is `scripts/perf-client.ts`, which understates a real client because it draws no real input):

| Part | Client process | Daemon process | Solo process |
|---|---|---|---|
| Bun runtime baseline (`bun --compile`, before any of our code) | 42 MB | 42 MB | 42 MB, paid once |
| Module graph (client UI, protocol, zod schemas; daemon, engines, tools, store) | about 13 to 20 MB | about 40 to 45 MB | both graphs, about 55 to 60 MB |
| JS heap at idle | 8 to 10 MB | 16 MB (184k objects) | both heaps, about 24 MB |
| SQLite page cache (`cache_size` 8 MB, WAL) | none | up to 8 MB when pages are touched | same |
| Transcript model and render caches | 600 blocks of rows (`ROWS_CACHE_BLOCKS`); about 20 MB of heap after a 10,000 message deep scroll | event windows only | same |
| Code graph | none | built on first use | same |
| Per-session actors | none | one per loaded session, evicted when idle | same |

Measured totals (idle / after scrolling the whole history and streaming):

| | Two processes (probe: daemon + client) | Solo (probe) | Two processes (real CLI, split build) | Solo (real CLI, split build) |
|---|---|---|---|---|
| 0 messages | 142 / 195 MB | 113 / 148 MB | 167 / 188 MB | 124 / 145 MB |
| 1,000 messages | 147 / 243 MB | 125 / 207 MB | 187 / 216 MB | 141 / 165 MB |
| 10,000 messages | 148 / 249 MB | 133 / 216 MB | not measured | not measured |

The duplication between the two processes is the runtime baseline (42 MB), the shared parts of the module graph (zod and
protocol types, the store's types, the JIT and the allocator's own overhead) and the two heaps' fixed costs. Solo removes
about 40 MB in the real CLI (about a quarter) and 15 to 35 MB in the probe. It does not remove what the work itself needs:
the daemon's heap, the page cache and the transcript.

## What truly needs a separate daemon

| Feature | Needs its own process? | In solo mode |
|---|---|---|
| Second terminal | No: it attaches to the host's normal socket | `auto`: once it (or any other client) attaches and nothing is running, the host moves the daemon to a detached process (`daemon.shutdown` with `whenIdle`, then its own reconnect starts the detached one), so killing one terminal never interrupts another terminal's turn; what was typed in a blank chat during the move stays in the prompt. `solo`: works while the host lives; the host hands over when it leaves (below). Every way a hosting terminal ends is in `logs/daemon.stderr.log` (`[SOLO]:` lines); a turn found open by the next daemon is logged too |
| MendCodeSpaceNext, REST, app-server, ACP attach | No: same socket or HTTP listener, opened by the same daemon code | Works while a terminal runs a daemon; the loopback listener is not `standing`, so closing the last terminal leaves no process behind |
| Remote peers | No for the listener; yes for being reachable after the terminal closes | `standing`: closing hands over |
| Background turns after the terminal closes | Only if the shell has no job control: a shell waits for its child | The turn finishes in the closing process (headless on a hangup), then the process exits or hands over |
| Loops with triggers, workflows, Telegram, the dream schedule, usage-limit resume | Yes, they must fire when no terminal is open | `standing`: closing hands over to a detached daemon, which restarts them from durable state |
| Programs the model started (dev server, long test run, pty terminals) | They are children of the process that started them and cannot move | `running`: the process waits for them like for a turn |
| Crash isolation | Yes, by definition | Mitigated, not removed (below) |
| Daemon restart on build skew | No | A host never restarts for skew while another client is attached; the host's own terminal counts as a client |
| Sandboxed tool subprocesses | No: they are children either way | Unchanged |
| The installed user service | Yes, it is the two-process shape by design | Unchanged: `auto` attaches when a daemon already runs |

## Design

- `process: daemon | auto | solo` (default `auto`, in every tier), flag `--process`, `MENDCODE_PROCESS`, setting `processMode` in the
  TUI profile (`apps/cli/src/view/tui-profile.ts`, mirrored in `packages/protocol/src/tui-data.ts`). Precedence: flag,
  environment, profile, `daemon`. `auto` and `solo` (the same) host the daemon only for an interactive local terminal on the default
  socket without `--print-logs`; `daemon` and every other shape (remote attach, explicit socket, `run`, scripts) behave
  as before. `--isolated` waits for the hosted daemon to stop so its socket is removed.
- Hosting (`apps/cli/src/solo.ts`): claim the directory with `mendd.host` (`wx`, atomic; a claim whose owner died is
  replaced), start the daemon in this process (`packages/daemon/src/hosting.ts` tells `main.ts` to use the host's flags,
  not install signal handlers, skip the ready line and report stop instead of exiting), and connect the terminal's own
  client through an in-memory transport (`packages/client/src/loopback-socket.ts`, `daemon.attachLoopback`, microtask
  delivery so a command never runs inside the event append that caused it). The daemon still holds `mendd.lock` and the
  socket, so everyone else attaches normally. Two terminals starting at once: exactly one wins the claim and the lock;
  the other sees a live owner and attaches (tested with two processes).
- Lazy graph: the daemon and its zod schemas load after the first frame (`hostDaemon` imports them dynamically);
  `apps/cli/test/footprint.test.ts` still passes. Hosting costs about 95 ms and about 45 MB of RSS over a client that
  attaches.
- Leaving (`leaveSolo`): `daemon.status` reports `keepAlive: { running, standing }`. Running work (a turn, a job, a
  verifying loop) finishes in this process first, because it cannot change process mid-step and a shell would
  otherwise return its prompt while the work continues; ctrl+c stops it and the turn ends as interrupted. Programs the
  model left running (a background process such as a dev server, a terminal tab) never finish on their own, so they do
  not hold the exit: they stop with the daemon and one line says so. A hangup (closed window or tab) keeps going headless:
  it is a SIGHUP, the end of the terminal's input, or a write that fails with EIO, whichever comes first; from then on
  nothing is drawn, and the SIGHUP handler stays registered because terminals repeat it (Ghostty, and cmux on it, every
  10 ms until the shell exits). Another tab's running turn therefore ends normally. Then: nothing standing and nobody else attached means the
  daemon stops and the process exits, with no resident daemon; standing work or another attached client means the host
  stops and `ensureDaemon` starts a detached daemon, which recovers loops, workflows and the schedule from the store.
  Handing over rather than staying alive was chosen because a terminal process that outlives its window with no screen is
  surprising, and the detached daemon is exactly what two-process mode would have had.
- A slow answer is not an idle daemon: a `status` that takes over 2 s counts as unreported work and is asked again, so
  another tab's turn is never stopped because the daemon was busy. Only a daemon that answers nothing for 60 s is let go.
  One that already stopped (`/daemon restart`) is not asked.

## Crash isolation, honestly

In two-process mode an uncaught error in the UI kills the terminal and leaves the daemon and its turn alive; an error in
a turn kills the daemon and the terminal survives to reconnect. In solo mode one process holds both, so either kills
everything, and a turn in flight ends as interrupted. Mitigations: `uncaughtException` and `unhandledRejection` no longer
exit; the error goes to `<dir>/logs/daemon.stderr.log` and the terminal shows the crash screen, where `r` returns to the
app, so the process survives what a separate daemon would have died of. A hard kill (SIGKILL, OOM, power loss) is the
residual risk. `kill -9` durability was tested: every event appended before the kill is in the store, the half-finished
turn is closed as interrupted by the next daemon, and the session accepts a new prompt. What solo cannot keep that two
processes would is the running turn itself: killing the terminal in two-process mode leaves the daemon finishing it
(tested), killing the solo process ends it. Anyone who needs that uses `--process daemon`, the user service, or closes
the terminal normally (the turn then finishes).

## Frames

A blocking daemon operation shares the UI thread in solo mode. Measurement found two causes of frames above budget, and
fixed both:

1. History paging. The `events_read` view (a UNION ALL) cannot be paged cheaply, so `readBefore`, `readAfter` and
   `readNewest` did work proportional to the prefix (21 ms per page at 10,000 messages, making the p95 of a scroll 34
   ms). `eventsPage` in `packages/store/src/store.ts` cuts each branch with ORDER BY and LIMIT before merging: 0.2 ms per
   page, and it helps two-process mode as well (equivalence with the view is tested, including forked sessions).
2. The client's periodic full collection (every 8th frame) costs about 1.7 ms with the client alone and about 4.5 ms with
   the daemon's heap in the same process. It stays inside the budget, so it was kept.

Frame p95 in solo, 0 / 1,000 / 10,000 messages: idle 4.6 to 5.2 ms, scroll up and down 4.5 to 8.4 ms, stream 5.6 to 9.1
ms (two-process: idle 1.5 to 2.5, scroll 1.5 to 3.8, stream 2.8 to 5.3). A 60 fps frame is 16.7 ms. The remaining work
that could move off the UI thread is the turn listing in `readEventsWindow` (`withoutUndone`, about 3.7 ms at 10,000
messages), left alone because it is under budget.

## Reductions that help both modes

| Change | Result |
|---|---|
| `bun build --compile --splitting` (`scripts/build.ts`): rarely used modules become lazy chunks inside the executable | client RSS about 22 MB lower, daemon about 10 MB lower; the real CLI two-process idle 200 to 167 MB |
| `eventsPage` store query | page read 21 to 0.2 ms; no memory cost |
| SQLite `cache_size` 1, 2 or 8 MB, daemon RSS after a 10,000 message deep scroll, 7 interleaved runs per value | no signal under load 8 to 9 (every value spans 84 to 133 MB), so the 8 MB setting stays |
| A quiet-period full collection in the daemon, 2 s after a burst | no effect: RSS 92.4 to 92.5 and 130.5 to 130.6 MB. Reverted. The runtime keeps its freed pages instead of returning them |
| Bun.gc after a deep scroll (source run, 10,000 messages) | heap 68 to 31 MB, objects 912k to 375k, RSS 306 to 298 MB: the heap shrinks, the process does not give the pages back, so the existing client collection stays the only one |

Not done, with the reason: dropping transcripts of inactive sessions and releasing engine or provider clients when idle
were not measured as a cost worth changing (the daemon already evicts idle session actors, and the engines hold no
connection between turns); duplicate strings between store rows and the UI model did not show up as a large retained
object in the heap statistics above. They remain candidates if a profile of a long real session says otherwise.

## Default

`daemon` is the default (today's two processes), and `auto` is opt-in: the settings row (`/customize`, Terminal, Processes)
and the minimalist tier bundle select it. The reason is the one trade-off solo cannot remove: when the terminal process
dies abruptly (SIGKILL, a crash that cannot be caught, power loss), a turn that was running ends as interrupted, where a
separate daemon would have finished it. Nothing recorded is lost either way (tested), but the product rule is that nothing
is left half-done, so the saving is offered, not imposed. In the minimalist tier it is part of what the user asked for:
less memory. Leaving minimalist puts `daemon` back; a choice made under another tier is not touched.

The trade-off, in one line, as the settings row and `--help` state it: less RAM; a hard-killed terminal interrupts its
running turn; slower first frame.

## First frame

`auto` draws its first frame later than a terminal that finds a daemon already running. Measured on 2026-10-05 (load 2.4
to 2.7), real compiled CLI in a pseudo-terminal, empty session, one trace mark per phase:

| First frame | Time |
|---|---|
| Two processes, daemon already running | 105 ms |
| Two processes, no daemon (the terminal starts one) | 207 to 212 ms |
| `auto`, terminal hosts the daemon | 194 ms |

Where the 194 ms of `auto` go (ms since process start): runtime and the terminal's static module graph 40; hosting 77
(the daemon's module graph 55, `startDaemon` 20 of which opening the store 5, the rest the engine and listeners); the
client's first `hello` 24 (this loads the protocol's lazy schemas, about 20, and costs the same against a separate daemon);
the first settings, session window and render 39. The store is not the cost: opening it takes 5 ms.

Deferring the daemon until after the first frame was examined and not done. Every pixel of the first frame comes from the
daemon (saved settings and theme, the session window, the project's state), so drawing earlier means drawing a placeholder
and repainting, which changes behaviour (a theme flash) for a gain the user does not see as faster. What can be avoided is
the cost itself, and it is spread thinly: per module, in the compiled binary, the daemon's graph costs store 6 ms, tools 8,
native engine 8, MCP 4.5, language servers 1 and the daemon module 16, so making any one of them lazy saves at most about 8
ms of the 77 and moves the work to the first turn. So `auto` pays the same first-frame cost as today's cold start, minus 15
ms, and `daemon` stays the choice for whoever wants the 105 ms.

## What is shared

Both modes keep the reductions that do not depend on the process shape: `--splitting` in the build, the paginated history
query, and the lazy protocol schemas.
