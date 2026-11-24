---
summary: Domain mode: several people on one VPS over HTTPS with passkeys
docs: gateway
aliases: domain-mode, multi-user, passkey, passkeys, webauthn, remote-login, invite, funnel, caddy
---
For: "let my team use MendCode on our server", "open MendCode from my phone with my own domain", "sign in with a passkey", "pair this terminal with the server".

Off by default; nothing loads without a gateway command. On a Linux VPS, as root: {{program}} gateway setup --domain NAME [--funnel] [--admin NAME] [--no-firewall] [--dry-run]. It installs Caddy (free automatic HTTPS from Let's Encrypt) or uses Tailscale Funnel (free *.ts.net HTTPS), the gateway service, hardened systemd units and a ufw firewall (SSH and 443 only), and prints a one-time link for the first admin's passkey. Re-running is safe; --dry-run changes nothing.

Accounts exist only by invite: {{program}} gateway invite NAME [--admin] (a single-use link, 72 h), gateway invite --account ID (new passkey link), gateway users, gateway disable ID | enable ID, gateway revoke-device ID DEVICE, gateway status. Each account is its own Linux user with its own daemon, data, provider keys and agent harness; the gateway only signs in and routes, and admins cannot read sessions.

Browser or phone: open https://NAME/ and sign in with the passkey; the usual web client follows.
Terminal: {{program}} remote login https://NAME [--name DEVICE] prints a code; approve it on https://NAME/_gw/ with your passkey (full or read-only), then {{program}} attach https://NAME. The device key never leaves the machine; each connection gets a 10-minute token. remote logout https://NAME removes the device.

Security: no passwords, no long-lived tokens on the wire, __Host- cookies with SameSite=Strict, CSRF and Origin checks, lockouts after repeated failures, revocation within a second, an audit log without secrets. OIDC sign-in is not available yet.

Never edit gateway.json, accounts.json or the backends folder by hand, and never print an invite link into a shared place.
