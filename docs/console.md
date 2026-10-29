# Console and session sharing (B74)

Console is off by default. Account and credential commands are local daemon operations. Configure a literal loopback HTTP(S) origin and a regular, private mode-0600 token file (no symlinks). No public backend is selected or enabled implicitly. `enterprise.url` supplies the origin when setup omits it; `share` is `disabled` by default, or explicitly `manual` / `auto`.

```sh
mendcode console setup http://127.0.0.1:8788 --token-file /private/console-token --dir /tmp/mendcode-data
mendcode console login --dir /tmp/mendcode-data
mendcode console orgs --dir /tmp/mendcode-data
mendcode console switch ORG_ID --dir /tmp/mendcode-data
mendcode console logout EMAIL --dir /tmp/mendcode-data
mendcode console open --dir /tmp/mendcode-data
mendcode console off --dir /tmp/mendcode-data
```

`login`, `logout`, `switch`, `orgs`, and `open` also work as top-level aliases. Login prints a device URL/code, polls with service timing/backoff, and cancels on interrupt. Interactive login opens the validated local device URL. Logout and switch offer a picker when no argument is supplied; automation needs an email or unique org ID. Accounts, refresh tokens, active account and organization persist in private `<dir>/console.json`; tokens never enter replies, session logs or settings. Refresh occurs before access-token expiry. Console configuration is metadata only: managed provider IDs do not install provider credentials into the native engine.

`/org` opens the organization picker: type to filter names, emails or hosts; arrows select;
Enter switches and closes (the active org closes without a write); Escape cancels. `/org QUERY` starts filtered.
Account email/host headings group the choices. `/console` opens account management: arrows select, Enter switches,
`r` refreshes, `s` configures, `l` logs in, `d` confirms logout, `o` opens Console, `b` opens a supplied billing link,
`x` turns Console off. Login polls while its page is open; `p` retries, `c` copies its URL, Escape cancels. Setup
accepts bracketed paste and cursor editing. Hints stay in the page header; compact terminals use one panel.

```sh
mendcode share policy manual --dir /tmp/mendcode-data
mendcode share create SESSION_ID --dir /tmp/mendcode-data
mendcode share sync SESSION_ID --dir /tmp/mendcode-data
mendcode share status SESSION_ID --dir /tmp/mendcode-data
mendcode share remove SESSION_ID --dir /tmp/mendcode-data
```

`/share` shows the current link and policy: Enter creates (or syncs), `s` syncs, `u` confirms unsharing, `c` copies, `r` refreshes, `m/a/d` choose manual/auto/disabled. `/share create`, `/share sync`, `/unshare` are shortcuts. Changing policy never shares existing unshared sessions retroactively. Auto shares new sessions; changes to shared content debounce a full replacement. Disabled stops create/sync, while explicit unshare remains available if Console is enabled. Failed sync/delete preserves the link for retry. Session deletion first unshares, and retention skips shared sessions. Export remains independent.

Public data preserves user/assistant text with credential redaction, removes the local directory and metadata/attachments, excludes reasoning and tool payloads, and indicates truncation. Each link keeps its original account/org/backend even after switching orgs. Share secrets persist only in private `<dir>/session-shares.json`. Account logout can leave a share awaiting its owner to log in again before sync/unshare. Remote peers may query link metadata, but cannot control Console, change sharing, poll device codes or open browsers.

## Console-free links (B8)

Two explicit, per-session actions need no Console and ignore the `share` policy. Both publish the same public data as a Console share (user/assistant text, credentials redacted, directory, metadata, reasoning, tool payloads and attachments left out). Both are local-only (`session.share.static`, never read-only for remote peers).

- `/share local` or `mendcode share local SESSION_ID [--remove]` writes `<data>/shares/<session>.html` (dir 0700, file 0600, atomic) and returns its `file://` link; it is a static page (same renderer and CSP as the HTML export), copied to the clipboard in the terminal. Removing, or deleting the session, deletes the file.
- `/share gist --yes` or `mendcode share gist SESSION_ID --yes` uploads the Markdown rendering as a secret GitHub gist with `gh gist create` (secret is its default; `--public` is never passed; argument array, the user's own `gh` login, stdin body; 10 s limit). Without `--yes` nothing runs, because the text leaves the machine. One gist per session; the link and id are kept in `<data>/shares/static-shares.json` (0600). `/share gist remove` / `--remove` runs `gh gist delete <id> --yes`. Deleting a session does not delete its gist. Markdown is used because GitHub renders it; the HTML page is for local files.

Decision taken: opt-in per call, no automatic or "auto" mode, no hosted viewer, no new credentials (the gist uses whatever `gh` is signed in as).

## Local adapter contract

Every request uses bearer-token authentication, forbids redirects, times out after 5 seconds and bounds responses to 2 MB. Links must stay on the configured local origin. Setup's token authenticates device-code/refresh requests and anonymous-account sharing. OAuth access tokens authenticate account calls; `x-org-id` identifies the selected organization.

- `POST /auth/device/code`: `{ client_id: "opencode-cli" }`; returns `device_code`, `user_code`, `verification_uri_complete`, `expires_in`, `interval` in seconds.
- `POST /auth/device/token`: device-code or refresh grant; returns bearer access/refresh tokens and `expires_in`, or `authorization_pending`, `slow_down`, `expired_token`, `access_denied`.
- `GET /api/user`: `{ id, email }`; `GET /api/orgs`: `[{ id, name }]`.
- `GET /api/config`: `{ config: { provider?: {...} }, quota?: { used, limit, resetAt? }, billingUrl? }`. Quota units belong to the adapter, resetAt is epoch milliseconds; absent quota remains unavailable.
- `POST /api/share` (or `/api/shares` with an account/org): `{ sessionID }` → `{ id, url, secret }`.
- `POST /api/share/:id/sync` (or `/api/shares/:id/sync`): `{ secret, replace: true, format: "mendcode-share@1", data: <mendcode-session@1> }`; successful JSON acknowledgement.
- `DELETE /api/share/:id` (or `/api/shares/:id`): `{ secret }`; successful JSON acknowledgement.

This is an opt-in v2 service adapter contract, not a deployed viewer. A real account/backend, public viewer,
billing implementation and org-provisioned engine credentials remain external work. Tests inject local transports
and never contact services.

## Console parity and HTTP (B74.1)

The existing opt-in [HTTP adapter](remote.md) exposes the v1 Console routes over native daemon commands:

| Route | Reply / payload |
|---|---|
| `GET /experimental/console` | `{consoleManagedProviders, activeOrgName?, switchableOrgCount}` |
| `GET /experimental/console/orgs` | `{orgs: [{accountID, accountEmail, accountUrl, orgID, orgName, active}]}` |
| `POST /experimental/console/switch` | `{accountID, orgID}` → `true` after persisting a validated selection |

These routes require a full token and a non-browser client. HTTP binds loopback only and remains off by default.
Read-only tokens cannot access account content, refresh credentials or switch organizations. Native
`console.accounts` and the client's `consoleAccounts()` expose only saved account metadata over the local socket;
logout works with Console off or its backend unavailable. CLI `orgs` and `switch` fetch organizations separately
from quota/billing. `console setup --token-file FILE` uses the configured `enterprise.url` when URL is omitted.

An unavailable account does not hide organizations from other accounts. Reports identify unavailable accounts;
quota/billing failure yields `metadataError` without hiding the picker or failing a persisted switch. Missing
`/api/config` (404) means no managed configuration, matching v1. Org-provisioned provider credentials are not
automatically imported; the service remains opt-in and does not replace the user's provider configuration.

Frames: `bun scripts/render-frames.ts .agents-frames/B74.1 --b74-1 100x30 180x50`.
