# Extensions (daemon half)

Extensions are trusted TypeScript modules that change how MendCode runs. The contract lives in
`packages/extension-api/src/index.ts` (types only); this page says what the daemon does with it. The terminal half
(`tui(api)`: slots, keys, pages) is handled by the terminal and documented with it. For commands run at tool, prompt
and session events without writing TypeScript, see [shell hooks](hooks.md).

Terminal views (messages, tool cards, approvals, bars, home, the slash menu and more) use `tui(api) { api.view(slot, input => lines) }`; see [views.md](views.md). Terminal menu replacements use `tui(api) { api.view("slashMenu", ctx => lines) }`, including
package extensions. See [the complete slashMenu contract and example](customize.md#replacing-the-slash-menu-view).
They reload through the existing customize-ui watcher and share the extension render circuit breaker;
a failed view shows a notice and falls back to tabs until reload.

```ts
// ~/.mendcode-v2/extensions/guard.ts  (or <project>/.mendcode/extensions/guard.ts)
export default {
  name: "guard",
  daemon(api) {
    api.on("tool.before", (e) => (e.tool === "shell" && /rm -rf/.test(String(e.args.command)) ? { block: "no rm -rf" } : undefined))
  },
}
```

## Asking the agent to change MendCode

The user says "add a `/hola` command that prints the branch", "block rm -rf", "add provider acme" and the agent writes the
extension itself, live, the way pi users ask pi. The model's tool is `mendcode_extend` (deferred: found with `tool_search`):

| Action | Does |
|---|---|
| `{ action: "write", file: "hola.ts", content, checks? }` | writes `<data dir>/extensions/hola.ts` (flat name, at most 64 KiB, never a project file), reloads, and answers with what that module registered (`commands`, `tools`, `hooks`, `provider`, `tui`) or its `errors` (an error result) |
| `{ action: "edit", file, old, new, checks? }` | replaces one unique literal, then the same |
| `{ action: "reload" }` | loads everything again |
| `{ action: "list" }` | every extension of the directory with its registrations and errors (read-only) |
| `{ action: "command", text: "/hola" }` | runs an extension command the way a typed one runs and returns its `notice` or `prompt`, so the agent checks its work |
| `{ action: "check", tool: "shell", args: { command: "cat private/a" } }` | runs the directory's `tool.before` chain on that call, which is never executed, and answers `{ blocked }` or `{ allowed, rewrittenArgs? }`: the agent tries every tool a guard must stop and one it must let through |

`checks` on `write` and `edit` is up to 20 `{ tool, args, expect: "block" | "allow" }`: right after the module loads each one goes
through the same `tool.before` chain as `check`, the answer lists `{ expect, got, ok, reason? }` per check, and one that got the wrong
answer makes the result an error, so a guard is tested in the same call that writes it. A module with a `tool.before` rule written
without checks gets a note saying so.

It uses the writing permission gate (`list` only reads, `command` and `check` execute), so plan mode cannot write and approvals follow the
permission mode. The same file confinement as `customize_ui` applies: flat names, no links, mode 0600, the data directory outside the
project. `customize_ui` stays the tool for the look (profile keys); both write the same folder. The system prompt's one-line
pointer names MendCode's own commands, tools, hooks, system prompt and models as MendCode's, and says that a rule the user sets
for later is an extension, not a promise (measured by `scripts/eval-extend.ts`, below). `mendcode docs extend` is the card.

Recipes (each is a whole module; `node:` imports work):

```ts
// /hola prints the branch: `notice` is shown to the user and starts no turn; `prompt` would be sent to the model instead.
export default { name: "hola", daemon(api) {
  api.registerCommand({ name: "hola", description: "current git branch", run: async (_args, { cwd }) => ({ notice: (await api.exec("git", ["branch", "--show-current"], { cwd })).stdout.trim() }) })
} }
```

```ts
// A rule on tool calls: test the whole arguments so every tool that can reach the path is covered (read also sends `paths`).
export default { name: "private", daemon(api) {
  api.on("tool.before", (e) => /(^|[\s"'=/])private([/"\s]|$)/.test(JSON.stringify(e.args)) ? { block: "private/ is off limits" } : undefined)
} }
```

```ts
// Input rewrite, a system prompt line that changes every day, a sound at the end of a turn.
import { spawn } from "node:child_process"
export default { name: "habits", daemon(api) {
  api.on("input", (e) => (e.text.trim() === "lgtm" ? { text: "Looks good to me. Commit the changes." } : undefined))
  api.on("prompt.system", (e) => `${e.system}\n\nToday is ${new Date().toDateString()}.`)
  api.on("turn.end", () => { spawn("afplay", ["/System/Library/Sounds/Glass.aiff"], { stdio: "ignore" }) })
} }
```

`api.exec(program, args, { cwd, input, timeoutMs, signal })` runs a program without a shell and resolves `{ stdout, stderr, code }`
(never rejects; `code` is null, with `error`, when it could not start or ran past `timeoutMs`, default 30 s, at most 120 s; 1 MB
per stream). `input` is written to its stdin. Register every handler inside `daemon(api)` itself: an `api.on` made later, from
inside a handler, is refused and listed as the extension's error.

### The live eval

`bun scripts/eval-extend.ts --model chatgpt/gpt-6-luna` asks 15 plain requests (English and Spanish: a command, a tool, a key,
a guard, a footer line, a sound, a provider, a system prompt line, an input rewrite, a protected folder, a tool log, a dirty-tree
guard, today's date in the context, a key that sends a message) to the CLI from source, headless, each in a fresh data directory,
project and HOME, then checks the effect from outside: a real daemon on that data directory with a scripted model (the command
answers, the guard refuses, the tool counts), the terminal app drawn into frames, or `mendcode models`. `--self-test` proves every
check fails on an empty install and passes on a reference solution, with no model.

## Where they are found

`<layer>/extensions/*.ts|js` and `<layer>/extensions/<name>/index.ts|js`, in every extension layer, in this order
(the order hooks run in): builtin package, user packages, the user's folder (`~/.mendcode-v2`), project packages,
the project's `.mendcode/`. Files ending `.d.ts`, dotfiles and folders without an index are ignored; at most 64 per layer.

- User-layer modules (user folder, user packages) load once for the whole daemon.
- Project-layer modules (the project's `.mendcode/` and its packages) are imported only when the directory is trusted:
  the same `trustedToolDirs` and path matching as project custom tools (`tools.trust`). An untrusted project's modules
  are listed by `extensions.list` with `trusted: false` and are never imported. Trusting or untrusting (or changing
  `disabledPackages` or `disabledPackageResources`) drops the per-directory cache; the next use reloads, and untrust stops applying them at once.
- Loading is lazy: the first turn, `/command`, `user.submit` or `extensions.list` of a directory loads what it needs,
  then it is cached per directory. A directory without extension files costs a few directory listings and no `import()`.
- A module must default-export `{ name, daemon?, tui? }` (`name`: letters, digits, `.`, `_`, `-`; it names the data
  folder). Anything else is recorded as an error on that module; nothing is thrown. Only `daemon(api)` is called, under
  the hook time limit; `tui` is reported (`tui: true`) but never called by the daemon.
- Registrations must happen during `daemon(api)`; later ones are refused and recorded.
- Edits to a module apply after a daemon restart (or a trust change for project modules).
- `MENDCODE_EXTENSIONS=0` disables everything: no discovery, no imports, no hooks, extension commands or tools,
  and `SYSTEM.md` / `APPEND_SYSTEM.md` / `COMPACTION.md` are ignored too.

## Isolation

Every handler runs under `HOOK_TIMEOUT_MS` (5 s) in a `Promise.race`, inside try/catch. A handler that throws, rejects,
times out or returns the wrong shape is skipped: the error is recorded on its extension (first 20, in
`extensions.list`), one line per extension goes to the daemon log, and the turn is unaffected. A timed-out handler
keeps running in the background (JavaScript cannot stop it); its answer is ignored. Handlers of several extensions run
in layer order. With no handler registered for a hook, nothing is awaited: the engine checks a set lookup first.

**Circuit breaker.** A handler (each `api.on`), command or tool that fails 3 times in a row (throw, rejection, timeout,
wrong shape) is not called again for the session: `/extensions` shows `stopped` and the handler in `breaker`. A success
resets the count. The breaker only blocks new calls; a callback already running is never cut. A reload
(`/extensions reload`, a file edit) builds new records and turns everything back on. Host gates are not hooks and never sit
behind a breaker: approvals, plan mode and explicit denies still apply, and a `permission.ask` handler that is stopped
leaves the host's own `ask`. A stopped `tool.before` guard simply stops blocking, so keep rules that must hold in
permissions, not in an extension.

**Bad edits.** A syntax error or a missing import is found before the module is imported (the runtime remembers a failed
import and would refuse the fix). If a module that loaded fine fails after an edit (import, shape or `daemon()` error), the
previous working version keeps running and `/extensions` says `kept old` with the reason; fixing the file replaces it. During a
reload, a turn already running keeps seeing the old registrations until the new ones are ready.

**Failed setup.** Registrations are published only when `daemon(api)` finishes. If the first load of a module throws or
times out after it registered a tool, command, hook, auth method or provider, all of them are discarded: the extension is
listed in `/extensions` with the error and owns nothing, so a half-initialised extension never answers a hook or offers a
tool. A registration attempted after setup ended (a timer, a late promise) is refused and recorded.

## Conflicts, disabling and cost

`extensions.list` also answers `conflicts`: two extensions registering the same tool (the first keeps it unless the later
sets `override: true`), the same command (the later layer wins), the same name (they share the data folder), or an override
of a built-in tool. Each entry names the winner, the losers and the rule; `/extensions` lists them (balanced and full; minimalist
shows a count) and each extension row carries its own. Nothing is replaced silently any more, but the precedence did not change.

`d` on `/extensions` (or `extensions.disable { directory, name, disabled }`) turns an extension off by name: persisted in
`disabledExtensions`, never run in the daemon (its module is not imported when the file name matches), skipped by terminals, and
it stays listed so it can be turned on again. Local clients only; remote and peer terminals are refused.

Each extension row shows its estimated context cost: the schemas of its tools that the user's tier offers (chars / 4, like
`/context`), and a `+` when it also has `prompt.system`, `context` or `request.before` handlers, whose effect is not measured.
`context.query` adds `extensions` (one section per extension, already counted inside `tools`) and `/context` lists them under Resources.
It also adds `rent` (each offered tool with its owner, schema tokens and calls still in the history); extension tools carry
`extension:<name>` as owner, so a heavy extension nobody calls shows as unused ([layout](layout.md)).

## Notes to the terminal

`api.toast(text, { level? })` puts one line (300 characters, 10 per 10 seconds per extension) on the user's toast line. It never
starts a turn, never enters the model's context or the transcript, is never stored, and is not sent to remote terminals. Use
`api.notify` when the model should read the text.

```ts
export default { name: "freeze", daemon(api) {
  // The user sees this; the model does not.
  api.on("turn.end", (e) => { if (e.outcome === "failed") api.toast("the last turn failed", { level: "warning" }) })
  // The model reads this, as a notice turn once the session is free.
  api.registerCommand({ name: "freeze", description: "tell the agent main is frozen", run: (_args, { sessionId }) => {
    api.notify(sessionId, "Release freeze: no merges to main until Friday.")
    return { notice: "sent" }
  } })
} }
```

## Hooks

| Hook | Where | Effect |
|---|---|---|
| `input` | `user.submit`, before the text is queued | rewrite with `text`; `handled: true` swallows it (no turn) and the ack carries `{ handled: true, notice? }`. Rewrites chain; the first `handled` ends the chain. |
| `session.start` | `session.create`, `session.fork`, loop and workflow sessions | observer |
| `turn.start`, `turn.end` | from the session event log (`turn.started` and `turn.completed/cancelled/interrupted/failed`) | observer; `text` is the queued text (empty for a compaction turn) |
| `tool.before` | engine, after approval, right before `tool.execute` (also for `!command`) | `block: "reason"` makes the tool result an error with that reason (first block wins, `tool.after` does not run); `args` replaces the arguments (chains) and is re-validated against the tool's schema. A call that reads without being `read` is then asked again as `{ tool: "read", args: { path } }` for each path it reaches, with `via: { tool, args }` the real call: the paths a shell command names (after a `cd` on the same line, in redirections and `$(…)`, the value of `--flag=path`; URLs never), grep/glob/ls's `path` (and glob's `pattern`), each of read's `paths`; a folder both as named and as `folder/`; at most 16. Those answers only block; a handler that counts or logs calls skips them with `if (e.via) return` |
| `tool.after` | engine, after `execute` and the LSP diagnostics note | `output` / `isError` replace what the model sees (chain); output is capped at the 50 000-character tool limit |
| `prompt.system` | engine, before each model call | a string, or `{ system }`, replaces the whole system prompt (chains); anything else is a handler error; `role` is the model role (`main`, `plan`, `subagent`, `compaction`) |
| `context` | engine, before each model call | receives a copy of the messages; an array of `{role, content, ...}` messages replaces them for that request only (history is never changed; an invalid array is refused as a whole) |
| `request.before` | the provider, right before the HTTP request (once per attempt) | an object replaces the request body (chains). Native engine with the Responses provider only; other engines do not call it |
| `compact.before` | engine compaction | `cancel: true` skips it; `summary` is used instead of asking the model (shown as the compaction card). `reason` is `auto` when the engine asked for it after a turn, else `manual`. First handler that cancels or supplies a summary wins |
| `compact.after` | after the history was replaced | observer, gets the summary |

Hooks on the engine apply to the native engine. Claude Code and Codex engines run their own loops and ignore them;
`session.start`, `turn.*`, `input` and commands work with every engine.

## Tools

`api.registerTool(tool)` adds a tool to the list of every session of the directory. The JSON schema in `parameters`
goes to the model as-is; the daemon validates only that the arguments are an object. `execute(args, ctx)` gets
`{ sessionId, cwd, signal, onOutput }`. A thrown error or an answer without `output: string` becomes a tool error; output
is capped like any tool. The tool asks for approval like the built-ins according to `permission`.

- A name clash with a built-in needs `override: true`, which replaces the built-in for sessions in that directory
  (and their sub-agents). A clash between extensions is an error for the later one unless it sets `override`.
- Reserved: `plan_submit`, `task`, `tool_search`, `mendcode_tool_search`, and names starting `mcp__` or `custom__`. Names: letters, digits, `_`, `-`, max 64.
- `api.builtinTool(name)` returns the built-in as an `ExtensionTool` to wrap in an override. Called from an override it
  runs with the engine's full context (background tasks, workflows); images a built-in returns are dropped by the wrapper.

```ts
export default { name: "clock", daemon(api) {
  // A new tool: an unknown zone throws, and the model gets the error as the tool's result.
  api.registerTool({
    name: "clock", description: "The current date and time in an IANA time zone.", permission: "read",
    parameters: { type: "object", properties: { zone: { type: "string", description: "e.g. America/Panama" } }, required: ["zone"] },
    async execute(args) { return { output: new Date().toLocaleString("en-US", { timeZone: String(args.zone) }) } },
  })
  // A built-in wrapped: `shell` as usual, except publishing, which CI does.
  const shell = api.builtinTool("shell")
  if (shell) api.registerTool({ ...shell, override: true, async execute(args, ctx) {
    if (/\bnpm\s+publish\b/.test(String(args.command))) return { output: "publishing runs in CI, not here", isError: true }
    return shell.execute(args, ctx)
  } })
} }
```

Native sessions can discover secondary extension schemas on demand with opt-in [tool discovery](tool-discovery.md).
Discovery never changes extension trust or execution permissions.

## Commands

`api.registerCommand({ name, description, run })` appears in `commands.list` next to the markdown custom commands
(an extension command wins a name clash). When the text of `user.submit` is `/name args`, the daemon runs it (after the
`input` hooks, under the hook time limit): `prompt` is queued as the user message, `notice` is returned in the ack
(`{ handled: true, notice }`, or beside `queueId` when a prompt was also returned), nothing starts no turn. A command
that throws or times out answers with a generic notice and is recorded on the extension. `commands.expand` of an
extension command returns `/name args`, so a client that expands before submitting still ends in the daemon.
Names are lowercase letters, digits, `:`, `_`, `-`.

The TUI and headless `--command` use `commands.execute`, preserving registered-command hooks and file/JSON execution attributes. Tab only completes. See [commands.md](commands.md) for built-ins, templates and lazy MCP prompt discovery.

## Providers

`api.registerProvider({ id, type?, baseUrl, apiKeyEnv?, headers?, models })` from a user extension adds a whole model provider,
the same thing as an entry in `<data dir>/providers.json` ([providers](providers.md)): its models appear in `/model` and
`mendcode models` as `<id>:<model>` and turns on them go to `baseUrl`.

```ts
// <data dir>/extensions/acme.ts
export default {
  name: "acme",
  daemon(api) {
    api.registerProvider({ id: "acme", type: "openai-compatible", baseUrl: "https://llm.acme.example/v1", apiKeyEnv: "ACME_API_KEY", models: [{ id: "acme-coder-1", context: 128000 }] })
  },
}
```

- `type` is the wire format: `openai-compatible` (default, Chat Completions), `openai` (Responses), `anthropic`, `google`, `xai`, `mistral` or `cohere`.
- The key is never in the module: `apiKeyEnv` names the environment variable (or a `/env` vault entry) it is read from on each
  request. A literal `apiKey` is refused. A provider without a key is listed and called without one (a local server).
- `models` is required: `[{ id, name?, context?, images?, effort?, maxOutputTokens? }]`.
- The id is lowercase letters, digits, `_` and `-` (max 32). Built-in ids and presets (`chatgpt`, `openai`, `anthropic`,
  `openrouter`...) are refused: configure those with `/connect`. A `providers.json` entry with the same id wins over the extension.
- Only user-layer extensions (`<data dir>/extensions`, user packages) can add one, because a provider serves every project. A
  project extension's attempt is an error in `/extensions`.
- `providers.list` reports it with `source: "extension"`. It is there once the daemon loaded its user extensions (the first
  session, `/extensions` or the model list do); disabling or deleting the extension takes it away.
- Without `baseUrl`, `models` is a function `(provider, { auth }) => ({ id: info })` that enriches a provider configured elsewhere (the v1 plugin hook, below).

`api.registerAuth({ provider, methods, loader? })` adds a way to log in to a provider: `mendcode plugin-auth acme` lists its methods
and runs one, the credential is kept in the daemon's mode-0600 file, and `loader` turns it into what each request to that provider
needs (`apiKey`, `headers`, or a `fetch`).

```ts
api.registerAuth({
  provider: "acme",
  methods: [{
    type: "api", label: "API key",
    prompts: [{ type: "text", key: "key", message: "Acme API key" }],
    authorize: async (inputs) => (inputs?.key ? { type: "success", key: inputs.key } : { type: "failed" }),
  }],
  loader: async (auth) => {
    const saved = await auth()
    return saved?.type === "api" ? { apiKey: saved.key } : {}
  },
})
```

## Sessions: model, effort, tools, messages

What pi's `setModel`, `setThinkingLevel`, `setActiveTools` and `sendUserMessage` do, from any hook or command (the session id is
in every event and in a command's context). Each answers `{ ok: true }` or `{ ok: false, error }` (the error is also listed in
`/extensions`); nothing throws.

```ts
export default { name: "modes", daemon(api) {
  api.registerCommand({ name: "deep", description: "big model, high effort, read-only tools", run: async (_args, { sessionId }) => {
    await api.setModel(sessionId, "openai:gpt-6-sol", { effort: "high" })
    api.setActiveTools(sessionId, ["read", "grep", "glob", "ls"])
    return { notice: `now ${api.getModel(sessionId)?.model}` }
  } })
  api.registerCommand({ name: "quick", description: "low effort, same model", run: async (_args, { sessionId }) => {
    await api.setThinkingLevel(sessionId, "low")
    return { notice: `tools: ${api.getActiveTools(sessionId)?.join(", ") ?? "all"}` }
  } })
  api.on("turn.end", async (e) => { if (e.outcome === "failed") await api.sendUserMessage(e.sessionId, "The last turn failed: say what went wrong.") })
} }
```

- `api.getModel(sessionId)` is the model and effort the next turn uses. `api.setModel(sessionId, model, { effort? })` sets the
  session's own model like `/model` (the user's default for new sessions stays): the id must be in `/model`, the effort one the model
  lists, and the model must run on the engine the session already runs (native, Claude Code, Codex…); switching engines hands the
  conversation over, which stays the user's call. `api.setThinkingLevel(sessionId, effort)` changes only the effort.
- `api.setActiveTools(sessionId, names | null)` limits the session's tools to those names (patterns like `mcp__*` work) from its next
  model call, on top of every other limit: a name the session is not offered (tier, safe mode, `--tools`, plan mode) is not added, and
  `tool_search` too is gone unless listed. `null` lifts the limit; `api.getActiveTools(sessionId)` answers the limit or `undefined`. It
  is kept in memory with the session's run limits (a daemon restart lifts it). It applies to native sessions; on a session Claude Code,
  Codex or an ACP agent runs it answers `{ ok: false }` (those keep their own tool list).
- `api.sendUserMessage(sessionId, text, { deliverAs? })` queues `text` as the user's next message: a turn starts when the session is
  free, and `deliverAs: "steer"` hands it to a running turn where the engine can take one. It goes straight to the queue, so `input`
  hooks and `/commands` do not run on it (a hook cannot loop through itself); pasted-secret masking applies as to a typed message. At
  most 5 per session per minute per extension, so a `turn.end` handler that answers every turn cannot run turns forever.
- None of these touches the permission mode, an approval, a grant, a budget or the tier: approvals still ask, budgets still stop a
  call, and a model change counts against the same budgets. A project extension acts only on sessions of its own project; a user
  extension on any session.

## Session entries and events between extensions

```ts
export default { name: "counter", daemon(api) {
  api.on("tool.after", (e) => { api.appendEntry(e.sessionId, "tool", { tool: e.tool, error: e.isError }) })
  api.registerCommand({ name: "tools-used", description: "tool calls this session", run: (_a, { sessionId }) => ({ notice: String(api.entries(sessionId, "tool").length) }) })
  api.events.on("deploy:done", (data, { from }) => api.log("info", `${from} deployed ${JSON.stringify(data)}`))
  api.registerCommand({ name: "deployed", description: "announce a preview deploy", run: () => {
    api.events.emit("deploy:done", { env: "preview" })
    return { notice: "announced" }
  } })
} }
```

- `api.appendEntry(sessionId, type, data?)` keeps a record about a session (pi's custom session entries) in the extension's own data
  folder, `extensions-data/<name>/sessions/<sessionId>.jsonl` (mode 0600). It never enters the model's context, the transcript or
  another extension's folder. `type` is letters, digits, `. _ : -` (max 64); an entry is at most 64 KB of JSON and a session's file 4
  MB. It answers `false` when refused (an unknown session, bad JSON) and lists why. `api.entries(sessionId, type?)` reads them back,
  oldest first (the newest 1000). Deleting the session deletes its entries; a fork starts without them.
- `api.events.on(name, listener)` (registered during `daemon(api)`, like a hook) returns the function that stops listening;
  `api.events.emit(name, data?)` reaches, after the current call returns, every listener of that name in the extensions loaded beside
  the emitter (the user's and those of the projects it serves), its own included. Listeners run under the hook time limit and the
  circuit breaker, and a throw is recorded on the listener's extension. An extension may emit 500 events per 10 seconds; the rest are
  dropped and listed once. `extensions.list` shows the event names an extension listens to (`events`).

## Flags

```ts
export default { name: "ticket", daemon(api) {
  api.registerFlag("ticket", { type: "string", description: "the issue this session works on" })
  api.on("prompt.system", (e) => { const ticket = api.getFlag("ticket", e.sessionId); return ticket ? `${e.system}\n\nYou work on ${ticket}.` : undefined })
} }
```

`mendcode --ticket=ABC-12` or `mendcode run --ticket=ABC-12 "fix it"` then passes the value for the session that invocation opens or
runs. `api.registerFlag(name, { type: "boolean" | "string", description, default? })` (lowercase letters, digits and `-`, max 40);
`api.getFlag(name, sessionId?)` answers the value the session was opened with, else the default. A boolean flag is `--name`, a string
one only `--name=value` (a separate word stays part of the message or the project path). The CLI keeps any flag it does not know
(one or two letters away from one it knows is still a typo: `--modle` asks "did you mean --model?") and sends them with
`extensions.flags { sessionId, flags }` before anything is submitted; the daemon refuses a name no extension of the project declares
(`unknown flag --x; extension flags: …`) or a value of the wrong type, and the run stops with that error. The values are kept with
the session (480 characters together). `acp` and `app-server` take none. `extensions.list` shows each extension's `flags`.

## MCP servers and virtual models

```ts
export default { name: "tools", daemon(api) {
  api.registerMcpServer("jira", { url: "https://jira.example.com/mcp", headers: { authorization: "Bearer ${JIRA_TOKEN}" } })
  api.registerVirtualModel({ id: "auto", name: "Auto", models: ["openai:gpt-6-sol", "gpt-6-luna"], route: ({ role }) => (role === "compaction" || role === "subagent" ? "gpt-6-luna" : "openai:gpt-6-sol") })
} }
```

- `api.registerMcpServer(name, server)` adds a server with the same entry as one in `mcp.json` (`command` + `args`, `env`, `cwd`, or
  `url` + `headers`, `transport`, `timeoutMs`, `enabled`), `${VAR}` expanded from the daemon's environment so a token stays out of the
  module. It is started, listed (`/mcp`) and approved like any configured server, and only where MCP is on (the full tier or
  `features.mcp`, never in safe mode). A server of the same name in an `mcp.json` (even one held back for trust) keeps the file's entry.
  A project extension's server is a project server: it loads only in a trusted project and starts with a credential-filtered
  environment. A reload of the extension adds, changes or removes it from the next turn.
- `api.registerVirtualModel({ id, name?, models, route? })` (user extensions only, like a provider) lists `virtual:<id>` in `/model`
  and `mendcode models` while one of `models` exists (the smallest context window of them, the first one's efforts). Each model call of
  a session on it goes to the real model `route({ sessionId, cwd, role })` answers when that is one of `models`, else to the first that
  exists; models another engine runs are never used. `route` is synchronous and runs before every call, so it decides from the role,
  the session or the time, not from a network call. Budgets, prices and `disabled_models` apply to the real model.

## Dialogs from daemon hooks

```ts
export default { name: "push-guard", daemon(api) {
  api.on("tool.before", async (e) => {
    if (e.tool !== "shell" || !/\bgit\s+push\b/.test(String(e.args.command))) return
    const ok = await api.ui.confirm(e.sessionId, "Push", "Let the agent push?", { default: false, timeoutMs: 20_000 })
    return ok ? undefined : { block: "the user did not allow the push" }
  })
} }
```

`api.ui.confirm(sessionId, title, message, { default, timeoutMs? })`, `api.ui.select(sessionId, title, choices, { default, timeoutMs? })`
(1 to 9 choices; `default` is one of them) and `api.ui.input(sessionId, title, { default, placeholder?, timeoutMs? })` ask the user
from the daemon side (pi's `ctx.ui.confirm/select/input`). `default` is required: it is the answer when nobody answers. The dialog is
the session's async question (`server.request`, `kind: "question"`, `async: true`), so it never holds the session: a turn keeps
running, the card says which extension asks and that it takes its default, a number or typed text answers it and `esc` dismisses it.
It is shown only while a local terminal that declared `extension-dialogs` in its hello has the session open (the interactive
terminal does); with none (a headless `run`, ACP, the app server, the web, a remote client) the default answers at once. Unanswered
after `timeoutMs` (default 30 s, 1 to 120 s) it is withdrawn and the default answers; a dismissal answers the default too. At most 4
are open per session; another answers its default at once. A handler waiting on a dialog is not cut by the hook time limit: it gets
the dialog's time and then the limit again (5 s), so a `tool.before` guard that asks really decides the call. A shell call's derived
reads (`e.via` set, above) run the same handler again: a guard that asks should `return` on `e.via` or test `e.tool` first.

```ts
// "deploy …" asks where to and what to add before it reaches the model; nobody answering means preview and nothing added.
api.on("input", async (e) => {
  if (!/^deploy\b/.test(e.text)) return
  const target = await api.ui.select(e.sessionId, "Deploy to", ["preview", "staging", "production"], { default: "preview" })
  const note = await api.ui.input(e.sessionId, "Anything the agent should know?", { default: "", placeholder: "optional" })
  return { text: `${e.text} (target: ${target}${note ? `; ${note}` : ""})` }
})
```

## Prompt files

Per layer, the last layer that has the file wins (project over its packages over user): `SYSTEM.md` replaces the
packaged system prompt (the `{{cwd}}` template still applies), `APPEND_SYSTEM.md` is appended as its own system part
(`/context` shows it as `system:append`), `COMPACTION.md` replaces the compaction prompt. Files over 64 KB or empty are
ignored; edits apply to the next model call. Prompt files are not code, so they are not gated by trust (like `AGENTS.md`).

`APPEND_SYSTEM.md` is the user's own text, so every [prompt mode](prompt-modes.md) sends it, like `AGENTS.md`: "always answer
in Spanish" in `<data dir>/APPEND_SYSTEM.md` reaches every session of every project. `SYSTEM.md` takes the place of the packaged
base prompt, so it applies in `focus`, `guide` and `full`; `minimal` and `custom` send a base of their own and leave it out.
For text that depends on the session (today's date, the branch), use a `prompt.system` hook instead.

## Runtime helpers

- `api.notify(sessionId, text)` queues a notice turn (like a finished background task); it waits behind a running turn.
- `api.dataDir` is `<data dir>/extensions-data/<name>`, created on first access.
- `api.log(level, message)` goes to the daemon log (stderr by default), tagged with the extension name.

## `extensions.list`

`{ type: "extensions.list", directory }` answers `{ extensions: Array<{ name, source: "user" | "project" | "package",
file, daemon, tui, tools, commands, hooks, errors, trusted, flags?, mcpServers?, virtualModels?, events?, disabled?, conflicts?, breaker?, kept?, context? }>, conflicts? }` in hook order, loading the directory's extensions first.
Untrusted project extensions appear with `trusted: false`, `daemon: false`, no tools, commands or hooks.

## Limits

User extension files now reload automatically through the daemon watcher. `/extensions reload` invalidates module caches, reruns daemon registration and notifies terminals; terminal timers/listeners should use `api.onDispose`. In-flight daemon callbacks are not cancelled. `customize_ui` uses the existing writing permission gate and returns attached terminals' setup errors; it writes only flat files in the user data directory, never project extensions. Details and terminal APIs: `extensions-tui.md`.

- Hooks cannot be cancelled once started; a stuck handler is ignored after the time limit but keeps its resources.
- Package activation changes invalidate user and project extension caches and notify attached terminals immediately.
- `context`/`request.before` shapes are provider-specific ("advanced"); the engine does not re-validate a replaced body.
- `compact.before` reports `reason: "auto"` for a manual `/compact` only if a turn asked for compaction and was cancelled before it ran.

## Shipping extensions in a package

A package (`<data dir>/packages/<name>/` or `<project>/.mendcode/packages/<name>/`, see the packages commands) may
carry an `extensions/` folder with the same layout as any extension layer: `extensions/*.ts|js` and
`extensions/<name>/index.ts|js`. Nothing else is needed: the package is an extension layer (`pkg` = its name, reported as
`source: "package"` by `extensions.list`), so its modules load in the layer order above, after the builtin package
and before the user's own folder (user packages) or the project's own `.mendcode/` (project packages).

```
acme/
  mendcode-package.json      { "name": "acme", "version": "1.0.0", "description": "…", "extensions": true }
  extensions/
    guard.ts
    audit/index.ts
```

- `mendcode-package.json` may declare `"extensions": true` (the package ships code that runs in the daemon) or `false`.
  The declaration is checked at install: `true` with no loadable module in `extensions/`, or `false` with some, refuses
  the install. Leaving it out is allowed; the folder is installed and counted either way. `packages.list` reports the
  number of modules as `contents.extensions` (counted by name, nothing is imported).
- The install rules are the ones for every package directory: no links, no credential or key files (`.env`, `*.pem`,
  `*.key`, local databases), at most 2 000 files and 20 MB per package, `.git` and `node_modules` are not copied. A
  package that needs dependencies must bundle them into its files.
- Trust is the layer's: a user package's modules run once the package is installed and enabled; a project package's
  modules (and any package installed under the project) run only when the directory is trusted (`tools.trust`), exactly
  like the project's own `.mendcode/extensions/`.
- Package installs, removals and activation changes reload user and project extension registrations and notify
  terminals. In-flight callbacks still finish; new calls use the new projection. Local catalogs and the marketplace
  are documented in [packages.md](packages.md).

Extensions never see pasted secrets: `input`, `tool.before` and `tool.after` get `‹secret:N›` markers and masked output
(see `docs/secrets.md`).

## Skills manager

`/skills` lists skill names, descriptions, source and enabled state from the existing package/user/project layers.
Type to fuzzy-filter; Enter or Space toggles the selected skill for this project, Ctrl+L reads its instructions, and
Tab inserts a skill-tool request into the preserved prompt. Escape closes the reader, then the manager.
`skills.list`, `skills.set { directory, name, enabled }` and `skills.load { directory, name }` run in the daemon;
`client.skills(directory)` returns `{ ok: true, report }`. Disable state persists in `settings.disabledSkills` keyed
by canonical project directory. Disabled skills stay visible in the manager but are omitted from the system prompt
and refused by both the load command and the skill tool. `extensions.open` is an unbound configurable key action for
opening the extension manager. Remote read-only peers can list/read skills, but cannot toggle them.

## v1 plugin adapter (B38)

Compatibility is opt-in: set `pluginCompatibility: true` alongside `plugin` in `mendcode.json` or `mendcode.jsonc`
in the data directory, project root or `.mendcode`. Entries accept a specifier or `[specifier, options]`.
`disabledPlugins` excludes full specifiers or NPM package names. The last declaration of an NPM identity wins
within a config. Project imports require project-tool trust. `--pure` disables external daemon and terminal
extensions; it refuses an existing daemon that was started without pure mode. Use a separate `--dir` for it.
`--safe-mode` goes further (also no packages, hooks, MCP or project tools); see [tiers](tiers.md). An extension tool may
declare `tier: "minimalist" | "balanced" | "full"`; it is offered only when the user's tier includes it, and always when no tier is set.

`plugin <module>` (alias `plug`) registers a local file/package or installs an NPM module into the private
`<data dir>/plugin-cache`. `--global/-g` selects the user config; `--force/-f` replaces an existing identity,
preserving tuple options. Existing JSONC is backed up before a successful atomic rewrite. NPM installation
requires pnpm 11+, uses the offline cache, ignores lifecycle scripts and pins the resolved version. Startup
never installs dependencies. A package may expose `./server` and `./tui` entries; a server-only package uses
its main/default export. Missing modules appear as load errors in `/extensions`.

Server functions (default or named exports), `{ id, server }` modules, and legacy `tool/*.ts|js` or
`tools/*.ts|js` files adapt to native hooks/tools. `tool` and `tool.schema` imports from `@mendcode/plugin`
or `@opencode-ai/plugin` are provided daemon-side. Tool arguments are validated; default and named tool exports
keep the filename and filename/export naming convention. Undeclared permissions default to `execute`.

Supported mutation hooks: chat message/parameters/headers, command before, tool before/after/definition,
shell environment, system/messages transforms, text completion, compaction prompt/context and autocontinue.
`event` observes native session events; `config` receives the declaring config. Hooks run through the native
timeout/error isolation. Shell overrides participate in the existing frozen approval environment. Explicit
denies, plan mode and external-directory approval still apply. Tool result title/metadata are preserved.

`registerAuth` / `registerProvider` are also available to native daemon extensions. Custom API/OAuth methods
use `plugins.auth-methods`, `plugins.auth-start` and `plugins.auth-complete`; the client exposes corresponding
helpers. `plugin-auth [provider [method-index]]` lists methods or runs an interactive login with hidden secret
input. OAuth callbacks are one-use, project-bound and expire after ten minutes. Credentials stay in a mode-0600
daemon file; replies/errors never return them. Auth loaders can supply API keys, headers and a request-local
fetch transport. Provider model hooks enrich the native selectable catalog; a matching provider transport must
be configured separately. Read-only peers cannot invoke these plugin commands or run model hooks.

The bridge does not implement the donor HTTP client, Bun shell, Effect permission requests or workspace
adapters. Its `client` is the native daemon extension API; tools must declare permissions up front. Those
call sites need migration. No external OAuth/provider service is contacted by the adapter's tests.
