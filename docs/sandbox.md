# OS sandbox for shell commands

An opt-in layer under the permission rules. When on, the commands the **model** runs (`shell`, background `shell`, `shell_session`; also sub-agents) are started inside an OS sandbox. Approvals and `permission` rules are unchanged and still decide whether a command may run; the sandbox decides what a running command can touch. Off by default.

## Use

`/sandbox` shows the setting and whether this system enforces it. `/sandbox off | read-only | workspace-write` sets the mode (`on` = workspace-write, `toggle` flips off and workspace-write), `/sandbox network on|off` the network, `/sandbox allow <abs path>` / `deny <abs path>` extra writable paths. Remote terminals cannot change it.

Setting `sandbox` (settings.json or `settings.set`):

```json
{ "sandbox": { "mode": "workspace-write", "network": "off", "writableRoots": ["/opt/cache"] } }
```

| Mode | Reads | Writes |
|---|---|---|
| `off` (default) | everything | everything the user can |
| `read-only` | everything | nothing (only `/dev`) |
| `workspace-write` | everything | the project root, the temp directories, `writableRoots`, extra directories (`additionalDirectories`, `--add-dir`, `/add-dir`; `docs/permissions.md`), `/dev` |

`network` is `off` unless set to `on` (no network at all, loopback included). Inside a writable root, `.git/hooks`, `.git/config` and `.mendcode` stay read-only because something outside the sandbox later runs them.

With `smartSandboxTrust: true` (off by default), smart permission mode also stops asking about commands it merely does not know while the sandbox is on and `network` is `off`; rules that flag a risk still ask (`docs/permissions.md`).

## Backends

- macOS: Seatbelt through `/usr/bin/sandbox-exec` with a generated profile (reads allowed, writes denied except the roots, protected paths denied again, `network*` denied).
- Linux: bubblewrap (`bwrap`): read-only root bind, writable binds for the roots, `--unshare-net` when the network is off, `--unshare-user --unshare-pid`. Interactive sessions skip `--new-session` so the PTY keeps its controlling terminal.
- Anything else, or no backend installed: with a mode set the command is **refused** with a message (`/sandbox off` to run unconfined). It never silently runs unconfined.

A failed command whose output looks like a sandbox refusal (`Operation not permitted`, `Read-only file system`, DNS failure) gets a one-line `[sandbox …]` note so the model and the user know why.

## Limits

- The user's own `!command` is not sandboxed. Hooks, MCP servers, LSP servers, formatters, custom tools and extensions are not either: only the model's shell commands.
- No per-host network allow-list: Seatbelt and bwrap filter by address, not by name, and there is no egress proxy. The network is all-or-nothing. No Landlock backend (it needs a native helper).
- This is a containment layer for an agent's mistakes, not a security boundary against a hostile local process: reads stay open, and processes can still talk to the host through anything the profile allows.
- Git worktrees keep their git directory in the main repository; add it with `/sandbox allow` if a command must commit there.
- Linux needs unprivileged user namespaces; if `bwrap` cannot start, commands fail with its error.

Code: `packages/tools/src/sandbox.ts` (policy and wrapping), `packages/daemon/src/sandbox-status.ts` (`sandbox.status`, local clients only), `apps/cli/src/ui/app/sandbox.ts` (`/sandbox`).
