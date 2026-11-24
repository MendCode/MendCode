# MendCode on a VPS

Run MendCode on an always-on Linux server (a VPS). The server runs your turns, keeps your sessions and holds your provider keys. Your laptop, another computer or a phone connects to it. Each section below links to the page with the full details.

The examples use placeholders: `vps.example.ts.net` is the server's Tailscale name, `user@vps` is an SSH login that works without a password prompt, and `alice` is a name you choose.

**Before you start:** the server runs Linux with systemd, Tailscale is running on it and on your laptop, and MagicDNS and HTTPS certificates are enabled for your tailnet.

## 1. Install MendCode on the VPS

```sh
mendcode remote setup vps.example.ts.net --ssh user@vps --dry-run   # prints the plan; connects to nothing
mendcode remote setup vps.example.ts.net --ssh user@vps             # does it
mendcode                                                             # now connects to the VPS
```

Setup installs MendCode, gets a TLS certificate, runs the daemon as a service, creates a token for this device and saves the VPS as your default remote. If it stops, run the same command again; finished steps are skipped.

Each other device needs its own token. Run this on that device; it needs SSH to the VPS:

```sh
mendcode remote pair vps.example.ts.net --ssh user@vps --device tablet
mendcode remote unpair tablet --remote vps          # revokes that device's token on the VPS
```

Tokens never expire unless you create them with `--expires-days N`. Details: [remote.md](remote.md#one-command-for-a-vps-remote-setup).

## 2. Move your sessions and keep them in step

Preview, then move your newest sessions (up to 100) to the VPS:

```sh
mendcode remote setup vps.example.ts.net --ssh user@vps --migrate-sessions --dry-run
mendcode remote setup vps.example.ts.net --ssh user@vps --migrate-sessions
```

The VPS owns the copies afterwards; nothing merges back. A session moves only when its project is also on the VPS, matched by git remote and path. `--clone-missing` clones a missing project there, and `--path-map LOCAL=REMOTE` covers folders that are not git clones. Skipped sessions say why, and a later run moves them.

To keep the VPS's sessions in step while both are online, turn on sync (`--sync` on `remote setup` or `remote pair`):

```sh
mendcode sync status
mendcode sync take SESSION_ID       # continue a VPS session here
mendcode sync release SESSION_ID    # give it back to the VPS
mendcode sync handoff SESSION_ID    # give the VPS a session made here
```

One machine writes a session at a time, and a refused prompt names the one that does. Credentials, tokens and authority settings never sync. Details: [sync.md](sync.md).

## 3. Move your code

Sessions move with MendCode; code moves with git. Nothing here runs unless you type it.

```sh
mendcode remote code handoff ~/code/app --dry-run   # on the machine you leave: list what would be pushed
mendcode remote code handoff ~/code/app             # push a snapshot of the working tree to a new mend/wip-* branch
mendcode remote code receive ~/code/app             # on the other machine: check it out in its own worktree
mendcode remote code clone https://git.example.com/alice/app.git   # clones only when no copy exists
```

Handoff leaves your branch, index, stash and worktrees alone. Both machines need your own git access to the remote. New and staged files that look like credentials, or are over 5 MiB, are left out; changes to files git already tracks are pushed as they are.

For one project that should stay in step on both machines, use live two-way sync. Install [Mutagen](https://mutagen.io) yourself first:

```sh
mendcode remote code live enable ~/code/app --ssh user@vps
mendcode remote code live status ~/code/app
mendcode remote code live disable ~/code/app
```

`enable` refuses unless both clones are the same repository, branch and commit. `.env` files and `node_modules` are never synced. Details: [remote.md](remote.md#code-between-machines-remote-code), [worktrees.md](worktrees.md).

## 4. Use an agent that lives on the VPS

An agent that speaks the Agent Client Protocol, such as Hermes, can run on the VPS. The agent's process runs there, so it uses the VPS's tools and sign-in.

1. Give the VPS a copy of your agents with `--acp-agents`. Only the command and its arguments move, never environment values. Sign in on the VPS itself.

   ```sh
   mendcode remote setup vps.example.ts.net --ssh user@vps --acp-agents
   ```

2. On the VPS, allow remote clients to run that agent. This setting is local-only, off by default, and remote clients cannot change it:

   ```json
   { "remoteEngines": ["acp:hermes"] }
   ```

3. On your laptop, run `mendcode` and choose `acp:hermes` in `/model`. Turns run on the VPS. On the VPS itself no setting is needed.

Details: [acp-engine.md](acp-engine.md), [remote.md](remote.md#remote-engines).

## 5. Reach it from a phone or another computer

There are two routes.

**Your own tailnet (you alone).** Install Tailscale on the device and pair it as in section 1. Terminals that run MendCode attach with `mendcode`. The browser client is served only by the gateway, so a phone browser needs the gateway.

**The gateway (several people, your own domain).** Run these on the VPS as root:

```sh
mendcode gateway setup --domain code.example.com --dry-run
mendcode gateway setup --domain code.example.com --admin alice
mendcode gateway invite bob          # prints a one-time passkey link, valid for 72 hours
mendcode gateway users
```

Setup needs a DNS name that points at the VPS and port 443 open. Caddy gets the certificate. `--funnel` uses Tailscale Funnel instead, with no domain. Open the link on the device that should hold the passkey, then sign in at `https://code.example.com/` in a browser, or pair a terminal:

```sh
mendcode remote login https://code.example.com --name laptop
mendcode attach https://code.example.com
```

Each person gets their own Linux user, daemon, data and provider keys. Details: [gateway.md](gateway.md).

## 6. Run heavy builds and tests elsewhere

Builds, test suites and other heavy jobs can run on separate, disposable machines that you reach over SSH. That keeps the VPS and your laptop light. Move the code with the `remote code` steps in section 3 or with your own git workflow, and start the job on that machine. MendCode does not create or manage those machines.

## 7. Not done yet

- **Pairing without SSH.** The device-key challenge that would replace the bearer token and the approval-code pairing is not built. A new device still needs SSH to the VPS for `remote pair` ([remote.md](remote.md#one-command-for-a-vps-remote-setup)).
- **Other sign-in methods for the gateway.** OIDC is not built. Only passkeys sign people in ([gateway.md](gateway.md#security)).
- **Real-world runs of the gateway.** Its tests use fakes. It has not yet run on a real VPS, with Caddy, an ACME certificate, Tailscale Funnel or a real browser ([gateway.md](gateway.md#limits)).
