Choose how MendCode notifies you, recaps work when you return, and handles resumed sessions. This guide also covers crash recovery and checking your terminal's environment.

Open `/customize` > Terminal to change these settings. They are saved in `<data dir>/tui/profile.json` like the rest of the terminal's look.

Everything here is local to the terminal except the `notify` command, which is a daemon hook.

## Return, recovery and environment (C5)

## Focus-aware notifications

Use **Notify when** to control the bell and desktop notice for a turn that ends or a request that waits.

| Setting | Default | Does |
|---|---|---|
| `notifyWhen` (**Notify when**) | `unfocused` | Chooses `unfocused` or `always`; gates the bell and desktop notice |
| `turnBell` | | Bell, gated by `notifyWhen` |
| `turnNotify` | | Desktop notice (OSC 9 or 777), gated by `notifyWhen` |

A terminal that never sends a focus report counts as unfocused, so notices behave as they did before. For tmux, set `set -g focus-events on`.

### External notifications

The external `notify` command is a `Notification` hook whose matcher names `turn_completed` or `turn_failed`; see [hooks](hooks.md).

It can be any command or an `http` hook, with the same user/project layers and trust as every hook. A hook with no matcher keeps to approvals and questions.

## Recap on return

Turn on `autoRecap` (**Recap on return**) to see a recap card when you come back. It is off by default because it spends one model call.

The card appears when the window gets focus back after at least five minutes and a turn ended meanwhile. Press `esc` to close it.

- Without focus reports, a pause in typing of five minutes counts as the absence.
- Nothing is asked while a turn is running.
- A read-only remote terminal never asks.

The card uses the session's recap (`session.recap`, the same as `/recap`).

## Resume and idle prompts

Both prompts are off unless you turn them on in `/customize`:

| Setting | Default | Choices |
|---|---|---|
| `resumePrompts` | Off | Turn on to get resume dialogs |
| `idleReturn` | `off` | `off`, `30m`, `1h`, `3h` |

Without them:

- A session resumed elsewhere continues in its own directory.
- A large session compacts at its threshold as always.
- A message after a long idle is sent as it is.

Once the provider's cache has expired, a compaction re-reads the whole history too, so asking first saves nothing. The compaction that pays is the one [before the expiry](compaction.md).

When turned on, these are dialogs: they own the keys until answered, and `esc` always picks the harmless choice.

### Another directory

Using `--session ID` for a session that lives elsewhere than where the terminal started asks where to continue. Remote terminals never ask.

| Key | Does |
|---|---|
| `y` | Continue there (default) |
| `m` | Move the session here (`session.cd`, local only) |

### A very large session

Resuming or switching to a session whose context is at 80% of its compaction threshold offers `y` to compact now. This is skipped when the terminal was started with a prompt to send.

### A message after a long idle

Sending asks first when both conditions hold:

- The session has had no activity for `idleReturn`. Its last update counts, so a resumed old session qualifies.
- It holds half of its compaction threshold or more, never less than 50k tokens.

| Key | Does |
|---|---|
| `enter` | Send as is |
| `c` | Compact then send |
| `esc` | Back to the prompt with the text kept |

The provider's prompt cache has gone cold by then, so the whole history is re-read. A smaller context is sent without a question: re-reading it is cheap and compacting it saves nothing.

## Crash screen

`uncaughtException` and `unhandledRejection` no longer leave the alternate screen and raw mode behind. Recovery happens in this order:

1. MendCode saves the unsent prompt, using the same save a quit does.
2. The crash screen shows the error, a short stack, and the recovery keys.

| Key | Does |
|---|---|
| `c` | Copy the details through OSC 52 |
| `r` | Back to the app |
| `q` | Leave, restoring the terminal and printing the usual exit summary |

Three crashes within ten seconds remove `r`.

The details carry the version, time, runtime, terminal name and the error. Secret-looking values are replaced and the home directory appears as `~`; the environment is never included.

## /doctor

Run `/doctor` to check your environment. It reads the environment and what the terminal already reported, and writes nothing to the terminal.

Each check shows `ok`, `warn` or `note`, with the setting that closes the gap:

| Checks | Includes |
|---|---|
| Terminal environment | Terminal and multiplexer, color depth, window size, locale |
| Input and clipboard | Shift+Enter, the clipboard route (OSC 52), tmux passthrough |
| Display and notifications | Image protocol, focus reports, the desktop notice |

The daemon's own checks (`system.query doctor`) appear below the terminal checks. An attached remote terminal shows the terminal section only.

Clipboard and Shift+Enter cannot be queried without risking junk in the prompt. They are reported as unknown with the fix, never probed.

## How focus reports work

While the screen is entered, MendCode turns on focus reports (DEC 1004, `Esc [ I` / `Esc [ O`) on a real terminal. A pipe or `MENDCODE_FOCUS_EVENTS=0` never asks.

The reports are removed from the input before keys are read.
