# MendCode

> MendCode is a coding-agent terminal: sessions that outlive the terminal, on MendCode's own engine, Claude Code, Codex or pi, with the user's own logins. This file installs it and gets the user to their first chat.

I want you to install MendCode on this machine. Follow the steps below in order, and stop where a step tells you to stop.

OBJECTIVE: Install the MendCode binary, verify it, and tell the user which of their logins it can run on and what to type next.

DONE WHEN:

- `mendcode --version` prints a version number
- `mendcode doctor` has run and its result has been relayed
- the user knows which way to run turns is ready (ChatGPT login, Claude Code, Codex, an API key or pi) and what step, if any, is still theirs
- the user has been told to run `mendcode` in their project folder

TODO:

- [ ] Check whether MendCode is already installed
- [ ] Pick the channel and the starting tier, then install with the user's confirmation
- [ ] Verify `mendcode` is on PATH and run `mendcode doctor`
- [ ] Find which logins MendCode can use
- [ ] Report what happened and the next command

Never use sudo, never edit shell startup files (.bashrc, .zshrc, .profile, fish, PowerShell profile), and never ask for, read or store an API key, a token or a password: signing in is always the user's step.

## 1. Already installed?

Run `mendcode --version`. If it prints a version, MendCode is installed: say so, run `mendcode upgrade --check` (it changes nothing), and if a newer release is out, offer `mendcode upgrade`. Run it only once the user confirms. Then skip to step 3.

`mendcode upgrade` keeps the channel the user picked before. Don't switch channels on your own.

## 2. Install

Two choices go into the install. For each, lead with your best guess and let the user correct it:

- **Channel.** `stable` unless the user asked for something newer. `beta` is the next release before it ships; `nightly` is built from `main` every day it changes.
- **Starting tier.** `balanced` unless the user said otherwise. `minimalist` opens straight to the prompt with no setup page; `full` turns on every panel. The tier can be changed later with `/tier`, so this choice is cheap.

Show the command for the user's OS with their choices, and run it only once they confirm:

```bash
# macOS / Linux
curl -fsSL https://github.com/MendCode/MendCode/releases/latest/download/install.sh | sh
# with choices: ... | sh -s -- --channel beta --tier full
```

```powershell
# Windows (PowerShell 5.1 or newer)
# with choices, first: $env:MENDCODE_CHANNEL = 'beta'; $env:MENDCODE_TIER = 'full'
irm https://github.com/MendCode/MendCode/releases/latest/download/install.ps1 | iex
```

The installer checks the binary's SHA256 against the release's `SHA256SUMS` before writing anything, and the cosign signatures too when `cosign` is installed. Relay its first line as it is: it says which checks ran. If the user wants the install refused without a signature check, set `MENDCODE_REQUIRE_SIGNATURE=1` for the installer: `... | MENDCODE_REQUIRE_SIGNATURE=1 sh`, or `$env:MENDCODE_REQUIRE_SIGNATURE = '1'` on Windows.

The binary goes to `~/.local/bin/mendcode` (`%LOCALAPPDATA%\Programs\mendcode` on Windows). If the installer fails, relay its message and stop; don't download the binary by hand or try another method.

## 3. PATH and health

Run `mendcode --version`. If the command is not found, it may only be missing from this shell: relay the last line the installer printed (it names the folder to add to `PATH` for the user's shell) and stop until the user confirms it works in a new terminal. On Windows the installer adds its folder to the user `PATH` itself; a new terminal picks it up. If an older version prints than the one just installed, another copy is earlier on `PATH`: report both and stop.

Then run `mendcode doctor` and relay what it reports. A line it marks as failing is the user's to fix; say what it suggests rather than fixing it yourself.

## 4. What it can run on

MendCode uses logins the user already has. Find out which ones are there without signing in to anything:

- `mendcode providers list`: the providers MendCode's own engine is signed in to (a ChatGPT login, API keys).
- `claude --version` and `codex --version`: Claude Code and Codex run as engines with their own login. MendCode never reads their credentials.

Tell the user what you found and which way you would use. A missing login is their step, and each has one command:

| To run on | The user's step |
|---|---|
| A ChatGPT plan, on MendCode's own engine | `/connect chatgpt` inside MendCode (opens OpenAI's Sign in with ChatGPT) |
| A Claude plan | Claude Code installed and signed in (`claude auth login`); MendCode starts it |
| Codex | `codex login`; then **Use Codex** on MendCode's setup screen |
| An API key | `/connect` inside MendCode, or `mendcode providers login --provider <id>` in their own terminal |

Don't run any of these for the user: they open a browser or ask for a secret.

## 5. Report

Relay what actually happened: the version `mendcode --version` prints, the channel and tier it was installed with, what `mendcode doctor` said, and which logins are ready.

Finish with the next step, which is the user's:

1. `cd` into a project folder and run `mendcode`. The setup screen opens on its own (not in the minimalist tier), finds the logins from step 4, preselects a model, and Enter starts chatting. `/setup` opens it again later.
2. `/tutorial` is a four-minute tour; `/model`, `/tier` and `/permissions` change the model, the tier and the permission mode.
3. `mendcode upgrade` updates it; `mendcode uninstall` lists what it would remove and asks first.

EXECUTE NOW: Complete the TODO list above to achieve: MendCode installed and verified, the user told which of their logins it can run on, and what to type next.

More: https://github.com/MendCode/MendCode#readme
