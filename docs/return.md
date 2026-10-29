# Return, recovery and environment (C5)

Everything here is local to the terminal except the `notify` command, which is a daemon hook. Settings live in
`/customize` > Terminal and are saved in `<data dir>/tui/profile.json` like the rest of the terminal's look.

## Focus-aware notifications

While the screen is entered MendCode turns on focus reports (DEC 1004, `Esc [ I` / `Esc [ O`) on a real terminal; a
pipe or `MENDCODE_FOCUS_EVENTS=0` never asks. The reports are removed from the input before keys are read. tmux needs
`set -g focus-events on`.

- `notifyWhen` (**Notify when**): `unfocused` (default) or `always`. It gates the bell (`turnBell`) and the desktop
  notice (`turnNotify`, OSC 9 or 777) for a turn that ends or a request that waits. A terminal that never sends a focus
  report counts as unfocused, so notices behave as they did before.
- External `notify` command: a `Notification` hook whose matcher names `turn_completed` or `turn_failed` (see
  [hooks](hooks.md)). It is any command or an `http` hook, with the same user/project layers and trust as every hook.
  A hook with no matcher keeps to approvals and questions.

## Recap on return

`autoRecap` (**Recap on return**, off by default because it spends one model call): when the window gets focus back
after at least five minutes and a turn ended meanwhile, the session's recap (`session.recap`, the same as `/recap`)
shows as a card, `esc` closes it. On a terminal without focus reports a pause in typing of five minutes counts as the
absence. Nothing is asked while a turn is running, and a read-only remote terminal never asks.

## Resume and idle prompts

`resumePrompts` (default off) and `idleReturn` (`off` default, `30m`, `1h`, `3h`). Both are off unless turned on in `/customize`:
without them a session resumed elsewhere continues in its own directory, a large one compacts at its threshold as always, and a
message after a long idle is sent as it is (once the provider's cache has expired a compaction re-reads the whole history too, so
asking first saves nothing; the compaction that pays is the one [before the expiry](compaction.md)). Turned on, they are dialogs:
they own the keys until answered, and `esc` always picks the harmless choice.

- **Another directory.** `--session ID` of a session that lives elsewhere than where the terminal started asks
  `y` continue there (default), `m` move the session here (`session.cd`, local only). Remote terminals never ask.
- **A very large session.** Resuming or switching to a session whose context is at 80% of its compaction threshold
  offers `y` compact now. Skipped when the terminal was started with a prompt to send.
- **A message after a long idle.** When the session has had no activity for `idleReturn` (its last update counts, so a
  resumed old session qualifies) and holds half of its compaction threshold or more (never less than 50k tokens), sending asks first: `enter` send as is, `c` compact then
  send, `esc` back to the prompt with the text kept. The provider's prompt cache has gone cold by then, so the whole
  history is re-read. A smaller context is sent without a question: re-reading it is cheap and compacting it saves nothing.

## Crash screen

`uncaughtException` and `unhandledRejection` no longer leave the alternate screen and raw mode behind. The unsent
prompt is saved first (the same save a quit does), then the screen shows the error, a short stack, and the keys:
`c` copy the details through OSC 52, `r` back to the app, `q` leave (restoring the terminal and printing the usual exit
summary). Three crashes within ten seconds remove `r`. The details carry the version, time, runtime, terminal name and
the error with secret-looking values replaced and the home directory as `~`; the environment is never included.

## /doctor

`/doctor` reads the environment and what the terminal already reported, and writes nothing to the terminal: terminal
and multiplexer, color depth, window size, locale, Shift+Enter, the clipboard route (OSC 52), tmux passthrough, image
protocol, focus reports and the desktop notice, each `ok`, `warn` or `note` with the setting that closes the gap. Below
it, the daemon's own checks (`system.query doctor`); an attached remote terminal shows the terminal section only.
Things a terminal cannot be asked without risking junk in the prompt (clipboard, Shift+Enter) are reported as unknown
with the fix, never probed.
