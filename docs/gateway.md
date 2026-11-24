# Gateway: Domain mode for several people

`mendcode gateway` puts MendCode on a public HTTPS address so several people can use one Linux VPS from a browser, a phone or their terminal. Each person gets **their own Linux user, daemon, data, provider keys and agent harness**. The gateway in front only signs people in and routes each request to that person's own daemon. It runs no tools and cannot read anyone's data.

It is off by default. Nothing about it loads unless you type a `gateway` command, `remote login` or `remote logout`, or attach to a gateway you have paired with. For one person over Tailscale, [remote setup](remote.md#one-command-for-a-vps-remote-setup) is simpler.

**Note:** Every test runs against fakes: a simulated host, software passkeys and fake account daemons. No real VPS, Caddy, ACME certificate, Tailscale Funnel or browser has been tried yet, and `systemd-analyze security` has only been read, not run. Check the [Limits](#limits) before you rely on it.

## Choose how it is reached

Both choices are free, and both give automatic HTTPS:

| Option | You need | Certificate |
|---|---|---|
| Your own domain (default) | A DNS name pointing at the VPS (paid, or a free subdomain), with port 443 open | [Caddy](https://caddyserver.com/docs/automatic-https) gets and renews a Let's Encrypt certificate |
| `--funnel` | [Tailscale](https://tailscale.com/kb/1223/funnel) logged in on the VPS, Funnel enabled for the tailnet | Tailscale's `*.ts.net` certificate |

The domain is yours to pick. MendCode never contacts any service on its own: Caddy or Tailscale handle the certificate.

## Set it up

On the VPS, as root, with an installed MendCode release:

```sh
mendcode gateway setup --domain code.example.com --dry-run    # print the plan; changes nothing, works anywhere
mendcode gateway setup --domain code.example.com --admin you  # apply it
```

Setup prints a one-time link for the first admin, valid for 24 hours. Open it on the device that should hold your passkey. Your fingerprint, face or PIN creates the passkey; no password exists.

Each step checks what is already in place, so a second run, or a run after a failure, does only what is left. Setup does these steps:

1. Installs the binary at `/usr/local/lib/mendcode/mendcode`.
2. Creates the `mendcode-gw` system user. It has no shell and no home.
3. Creates `/var/lib/mendcode-gateway` with mode 0700, and `/var/lib/mendcode-users`.
4. Writes `gateway.json`.
5. Writes two hardened systemd units (see [Isolation](#isolation)).
6. Installs Caddy with `apt-get` if it is missing, and writes `/etc/caddy/mendcode-gateway.caddy`. It imports that file from the Caddyfile, validates the config and reloads Caddy. With `--funnel`, it runs `tailscale funnel --bg --https=443 http://127.0.0.1:PORT` instead.
7. Starts `mendcode-gateway.service`.
8. Sets up the firewall with `ufw`. Incoming traffic is denied except SSH (the port read from `sshd -T`) and 443/tcp. Funnel mode needs no inbound web port. Add `--no-firewall` to manage the firewall yourself.
9. Creates the admin account with its one-time link.

When `systemd-analyze` is available, setup also prints the gateway unit's exposure score.

| Option | Default | Effect |
|---|---|---|
| `--funnel` | off | Serve through Tailscale Funnel instead of Caddy |
| `--port N` | 7480 | Loopback port, Funnel mode only |
| `--admin NAME` | `admin` | Name of the first account |
| `--memory-max`, `--cpu-quota` | `2G`, `200%` | Per-account daemon limits |
| `--state DIR` | `/var/lib/mendcode-gateway` | Gateway state (every command accepts it) |

## Accounts

| Command (on the VPS, as root) | Does |
|---|---|
| `gateway invite NAME [--admin] [--expires-hours N]` | Creates an account and prints its one-time passkey link. The link lasts 72 hours by default and is single use. |
| `gateway invite --account ID` | Prints a new passkey link for an existing account: another device, or a lost passkey. It replaces any older link. |
| `gateway users [--json]` | Lists accounts, their passkey count and their devices |
| `gateway disable ID` / `enable ID` | Stops or restores an account: its sign-ins, its tokens, its open connections and its daemon |
| `gateway revoke-device ID DEVICE` | Removes one paired device |
| `gateway status`, `gateway migrate` | Shows the address, service and counts; checks the state version |

`gateway invite NAME` creates the account's Linux user `mc-<id>` with a 0700 home in `/var/lib/mendcode-users/<id>`. It also creates the user's data and work folders, makes two tokens for that account's daemon and starts `mendcode-user@<id>.service`. The gateway keeps the tokens in 0600 files and never prints them.

Send the link only to that person. Accounts exist only by invite: nobody can sign up alone.

On the gateway's page (`https://DOMAIN/_gw/`), admins can also enable or disable accounts. They cannot open anyone else's sessions.

## Sign in from a browser or phone

Open `https://DOMAIN/` and sign in with your passkey. You get the same [browser client](remote.md#use-the-browser-client) as `mendcode web`: chat, approvals, files and terminal. It is served by your own daemon. Sign out from its header, or from `/_gw/`.

Model provider keys go into your own daemon, in your own data folder, and are sealed there.

## Pair a terminal

```sh
mendcode remote login https://code.example.com [--name laptop]
```

1. The terminal creates an Ed25519 key in `<data dir>/remote/gateway/` (mode 0600). The key never leaves the machine.
2. It prints a code such as `K7QD-M2XA`.
3. On `https://DOMAIN/_gw/`, signed in, enter the code. Check the device name and address shown, choose full or read-only access, and confirm with your passkey. The code expires after 10 minutes.
4. Then connect:

```sh
mendcode attach https://code.example.com
```

Each connection signs a fresh 60-second challenge from the gateway and gets an access token valid for 10 minutes. No long-lived token is stored or sent. To remove this device and delete the local key, run `mendcode remote logout https://code.example.com`.

You can also remove a device on the gateway's page. Its tokens stop working and its open connections close within a second.

## Security

**Assets:** provider keys, shell and code execution as each account's user, private code, session history.

| Threat | Defense |
|---|---|
| Internet scanner, anonymous requests | Only Caddy listens publicly. The gateway listens on a Unix socket that only Caddy can open, or on loopback with Funnel. Every route except the sign-in page needs a session or a token. An anonymous request gets the same 401 everywhere and never reaches a daemon. |
| Phishing, stolen password | Passkeys only (WebAuthn, user verification required), bound to the domain: a passkey does not work on another site. There are no passwords. |
| Replay | Every challenge (passkey, device token) and device code works once, and only within its lifetime: 5 minutes for a passkey, 60 seconds for a token challenge, 10 minutes for a device code. A response for another challenge, origin or relying party ID is refused. A passkey counter that does not rise (a cloned authenticator) is refused. |
| Brute force | Per-address and per-account limits. Account and device lockouts start at 1 minute, then double, up to 1 hour. Device-code guesses lock the signed-in session after 5 misses. Invite codes are 256-bit. A success never clears earlier failures. |
| CSRF, cross-site WebSocket | Session cookie `__Host-mcgw`: `Secure; HttpOnly; SameSite=Strict`, idle 2 hours, at most 12 hours. Every change needs our exact `Origin` and the session's CSRF token in `x-mendcode-csrf`. A WebSocket handshake needs our `Origin`. Cross-site Fetch Metadata is refused. The gateway sends no CORS headers. |
| Stolen device token | Access tokens last 10 minutes. The device key never leaves the device. Revoking a device ends its tokens and its connections within a second. A device token sent from a browser (with an `Origin`) is refused. |
| Another account | Each account is its own Linux user. Its daemon listens only on `/run/mendcode/<id>/http.sock`, which only the gateway's group can open. Its home is 0700, and the unit hides other homes and the gateway's state. The gateway picks the socket from the signed-in identity alone, so no header, path or token can choose another. |
| A compromised gateway | It has no network (Caddy mode), no capabilities and no access to account homes. It holds each daemon's token, so it can act as a signed-in user, but it cannot read files. |
| Secrets in logs | The audit log (`<state>/audit/gateway.jsonl` and `<id>.jsonl`, append-only, 0600) records events, account and device ids, addresses and reasons. It never records codes, tokens, cookies, challenges or keys. Cookies and credentials are never forwarded to a daemon, and a daemon's `Set-Cookie` and `WWW-Authenticate` headers never reach the browser. |
| Prompt-injected agent | Its authority is its own account's: its Linux user, its sandbox and its approvals. The gateway grants nothing beyond that. |

**Passkey verification.** It follows WebAuthn §7.1 and §7.2. Signature checks use node:crypto (ES256, Ed25519 and RS256). MendCode has no cryptography of its own and adds no dependency: the only parsing is a strict CBOR subset (no tags, floats or indefinite lengths). Only attestation `none` is accepted.

**OIDC** is not built yet. Sign-in methods are separate routes in the gateway, so an OIDC route can be added later without changing passkeys. As with invites, it would only sign in accounts an admin created.

### Isolation

Both units share these settings:

- `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`, `PrivateDevices`
- the kernel, cgroup, clock and hostname protections
- `ProtectProc=invisible`, `RestrictSUIDSGID`, `LockPersonality`, `RemoveIPC`
- an empty capability set, native system calls only and `UMask=0077`

The gateway unit also uses `RestrictNamespaces`, the `@system-service` system-call filter and `MemoryMax=512M`. Behind Caddy it has `RestrictAddressFamilies=AF_UNIX`, `PrivateNetwork` and `IPAddressDeny=any`.

Each `mendcode-user@<id>` unit runs as `mc-<id>`. An empty `TemporaryFileSystem` covers the accounts folder, with only that account's own home bound into it. It also has `MemoryMax`, `CPUQuota` and `TasksMax`.

Two settings are left out on purpose:

- `MemoryDenyWriteExecute`, because the JavaScript JIT needs writable code pages.
- `RestrictNamespaces` and IP filtering for account daemons, because agents need the network and may sandbox their tools in namespaces.

## Limits

- Not run on a real VPS, browser, Caddy or Funnel yet; all tests use fakes.
- Sign-in sessions and access tokens live in the gateway's memory, so restarting the gateway signs everyone out. Paired devices stay paired.
- With `--funnel`, other local users on the VPS can reach the loopback port and fake their address for the per-address limits. The per-account and per-device lockouts still apply.
- An admin disabling an account on the web page blocks its access but does not stop its daemon, because the gateway is unprivileged. Use `gateway disable ID` on the host to do both.
- Terminals reach the web routes and the attach protocol. Session [sync](sync.md) and Telegram stay per-daemon features: they are not routed through the gateway.
- Remote ACP turns for an account still need `remoteEngines` in that account's daemon settings ([remote engines](remote.md#remote-engines)).
