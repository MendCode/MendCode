# Dev mode: programming MendCode from MendCode

Trying a change to MendCode normally means restarting the daemon, and that cuts the session you are working in and every other
one. Dev mode keeps the work in a stable MendCode and tries the change in a second, isolated daemon that restarts alone.

Tier: all (minimalist, balanced, full). It is a command, not a feature switch; nothing of it loads unless you type `mendcode dev`.

## Use

```sh
cd path/to/MendCode-checkout        # the stable MendCode runs here, and a session works on the code
mendcode dev start                  # the development daemon: this checkout's source, its own data directory
mendcode dev tui                    # a terminal on it, marked DEV (re-run after a change, or just `dev restart`)
mendcode dev restart                # restart only that daemon; the main daemon and its sessions are untouched
mendcode dev run "say hi"           # a headless run on it, for a session to check a change without a terminal
```

Also `dev stop`, `dev status` and `dev keys` (below). `--dir DIR` (before the command) or `MENDCODE_DEV_DIR` picks the data
directory (default `~/.mendcode-dev`); `--checkout PATH` or `MENDCODE_DEV_CHECKOUT` picks the checkout (default: the git
checkout around the current folder, else the one the running program came from).

A session of the stable MendCode may run `dev start|restart|stop|status|run|tui|keys` from its own shell: they work on another
data directory. `mendcode dev --dir <main directory> ...` and every other way of restarting the main daemon stay refused for a
session ([permissions](permissions.md#what-a-session-cannot-do-from-its-own-shell)).

## What runs

`dev` runs `bun apps/cli/src/main.ts` of the checkout with `--dir DEVDATA`, never the installed binary. The daemon it starts is
that source's daemon (`bun packages/daemon/src/main.ts`), so a change shows after `dev restart` with no build step. A compiled
`dist/` binary would need a build per try and would drift from the source; Bun is required on `PATH` (and `bun install
--frozen-lockfile` once in the checkout). `dev restart` interrupts the turns running in the development daemon (they resume
later); it does not ask.

## Isolation

- Its own data directory, database, socket (or loopback endpoint) and lock. It never writes the main data directory: `dev` refuses
  the main directory, the one a session's shell runs under, and `MENDCODE_DIR`'s.
- No sessions, history, settings or memory are shared. `~/.claude` and `~/.codex` threads are not offered either (that is already
  so for any data directory but the default).
- The PR review watch, Dream and loop triggers never run in it, whatever its settings say. (Loops can be created; they do not fire.)
- The terminal shows `DEV` in the session top bar (also when it is narrow) and next to the version on the home screen. The mark
  follows the data directory: use `mendcode dev tui`, not a bare `--dir`.
- `mendcode daemon restart` on the main daemon does not touch it, and `dev restart` does not touch the main one.

## Login

- API-key providers: `providers.json` of the main data directory is copied once, only its `providers`, with mode 0600 (the
  directory 0700); nothing is printed. `dev keys` copies it again after you change a key. Keys in environment variables
  (`OPENAI_API_KEY`...) reach the development daemon as they reach any process.
- ChatGPT and GitHub Copilot sign-ins are not copied: their refresh token rotates every time it is used, so two copies would sign
  each other out. Run `/connect` once in the development terminal.
- Claude Code as an engine uses your own `claude` and its own login, as in the main daemon. MendCode never calls the Claude API
  with a subscription login.
- Settings are not copied: choose a model with `/model` the first time.

## Before this existed

Any version with `--dir DATA` can do the same by hand:

```sh
mendcode --dir ~/.mendcode-dev daemon start                      # a daemon per data directory
bun apps/cli/src/main.ts --dir ~/.mendcode-dev daemon restart    # from the checkout: the source, not the installed binary
bun apps/cli/src/main.ts --dir ~/.mendcode-dev                   # its terminal
```

Never pass the main directory, and run the checkout's `main.ts`, not `mendcode`, so the daemon is the code you changed. Without
dev mode there is no DEV mark and the background jobs follow that directory's settings (a new directory has them off).

## For contributors

1. Open the stable, installed MendCode in the repository and ask it to make the change.
2. Test it with `mendcode dev tui` (or let the session use `mendcode dev run "..."`).
3. After each edit, `mendcode dev restart`. Only the development daemon restarts; your working session keeps going.
4. `bun scripts/test-fast.ts --all --jobs 3` and the typecheck still decide whether the change is done ([CONTRIBUTING](../CONTRIBUTING.md)).
