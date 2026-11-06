# OS sandbox for shell commands

Use the OS sandbox to limit what the model's running shell commands can touch. It is an opt-in layer under the permission rules, off by default.

Run `/sandbox` to see the setting and whether this system enforces it.

Approvals and `permission` rules are unchanged: they still decide whether a command may run. When the sandbox is on, the model's `shell`, background `shell` and `shell_session` commands start inside it, including commands run by sub-agents.

## Use

1. Run `/sandbox` to check the current setting and enforcement.
2. Choose a mode with `/sandbox off | read-only | workspace-write` using the modes table below.
3. Set network access and any extra writable paths with the commands below.

Remote terminals cannot change it.

### Commands

| Command | Does |
|---|---|
| `/sandbox` | shows the setting and whether this system enforces it |
| `/sandbox off`, `/sandbox read-only`, `/sandbox workspace-write` | sets the mode |
| `on` | alias for workspace-write |
| `toggle` | flips off and workspace-write |
| `/sandbox network on|off` | sets network access |
| `/sandbox allow <abs path>` / `deny <abs path>` | adds or removes extra writable paths |

### Settings and modes

You can also set `sandbox` in settings.json or through `settings.set`:

```json
{ "sandbox": { "mode": "workspace-write", "network": "off", "writableRoots": ["/opt/cache"] } }
```

| Mode | Reads | Writes |
|---|---|---|
| `off` (default) | everything | everything the user can |
| `read-only` | everything | nothing (only `/dev`) |
| `workspace-write` | everything | the project root, the temp directories, `writableRoots`, extra directories (`additionalDirectories`, `--add-dir`, `/add-dir`; `docs/permissions.md`), `/dev` |

`network` is `off` unless set to `on`. With the network off, there is no network at all, loopback included.

Inside a writable root, these paths stay read-only because something outside the sandbox later runs them:

- `.git/hooks`
- `.git/config`
- `.mendcode`

### Smart permission mode

With `smartSandboxTrust: true` (off by default), smart permission mode stops asking about commands it merely does not know when both conditions hold:

- The sandbox is on.
- `network` is `off`.

Rules that flag a risk still ask (`docs/permissions.md`).

## Limits

**Warning:** This is a containment layer for an agent's mistakes, not a security boundary against a hostile local process. Reads stay open, and processes can still talk to the host through anything the profile allows.

Only the model's shell commands are sandboxed. These are not:

- Your own `!command`.
- Hooks, MCP servers and LSP servers.
- Formatters, custom tools and extensions.

There is no per-host network allow-list. Seatbelt and bwrap filter by address, not by name, and there is no egress proxy: the network is all-or-nothing.

Git worktrees keep their git directory in the main repository. Add it with `/sandbox allow` if a command must commit there.

## Backends

| System | Backend and policy |
|---|---|
| macOS | Seatbelt through `/usr/bin/sandbox-exec` with a generated profile: reads allowed, writes denied except the roots, protected paths denied again, `network*` denied |
| Linux | bubblewrap (`bwrap`): read-only root bind, writable binds for the roots, `--unshare-net` when the network is off, `--unshare-user --unshare-pid` |

Linux interactive sessions skip `--new-session` so the PTY keeps its controlling terminal. Linux needs unprivileged user namespaces; if `bwrap` cannot start, commands fail with its error.

There is no Landlock backend: it needs a native helper.

### When a command cannot run

On anything else, or with no backend installed, a command with a mode set is **refused** with a message. Use `/sandbox off` to run unconfined; it never silently runs unconfined.

A failed command whose output looks like a sandbox refusal (`Operation not permitted`, `Read-only file system`, DNS failure) gets a one-line `[sandbox …]` note so the model and the user know why.

### Implementation

| File | Holds |
|---|---|
| `packages/tools/src/sandbox.ts` | policy and wrapping |
| `packages/daemon/src/sandbox-status.ts` | `sandbox.status`, local clients only |
| `apps/cli/src/ui/app/sandbox.ts` | `/sandbox` |
