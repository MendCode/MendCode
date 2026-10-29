---
summary: change MendCode itself: commands, tools, guards, prompt, events, providers
docs: extensions, extensions-tui, hooks, providers
aliases: behavior, behaviour, guard, guards, intercept, extend-mendcode, self-modify
---
For: "add a hola slash command", "a tool that counts lines", "block rm -rf", "never read private/", "play a sound when a turn ends", "log every tool call", "always answer in Spanish", "today's date in the context", "add provider X". Do it now, live, in one TypeScript file; never answer with a promise to behave.
Tool: mendcode_extend (find it with tool_search). {"action":"write","file":"hola.ts","content":"<module>"} writes <data dir>/extensions/hola.ts, loads it, returns what it registered or its errors (fix: {"action":"edit","file","old","new"}). {"action":"command","text":"/<name> args"} runs a command. A guard's write takes "checks":[{"tool":"shell","args":{"command":"cat private/a"},"expect":"block"},{"tool":"read","args":{"path":"a.md"},"expect":"allow"}], tried at once.
  export default { name: "hola", daemon(api) {
    api.registerCommand({ name: "hola", description: "git branch", run: async (args, { cwd }) => ({ notice: (await api.exec("git", ["branch", "--show-current"], { cwd })).stdout.trim() }) })
  } }
run returns { notice } (shown, no turn) or { prompt } (sent to the model).
Model tool: api.registerTool({ name: "count_lines", description, permission: "read", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, execute: async (args, { cwd }) => ({ output: "7" }) }); resolve paths against cwd.
Guard: api.on("tool.before", (e) => /\brm\s+-\w*(rf|fr)/.test(String(e.args.command ?? "")) ? { block: "rm -rf is blocked" } : undefined). e.tool: shell, read, write, edit, apply_patch, grep, glob, ls; e.args.command, e.args.path, e.cwd. A path rule tests JSON.stringify(e.args); shell and grep calls are also asked as a read of each path. { args } rewrites a call; tool.after (e.output) rewrites a result.
Input: api.on("input", (e) => e.text.trim() === "lgtm" ? { text: "Looks good. Commit." } : undefined).
Prompt: fixed text for every session: <data dir>/APPEND_SYSTEM.md, no code. Changing text: api.on("prompt.system", (e) => e.system + "\nToday is " + new Date().toDateString()).
Events: api.on("turn.end" | "turn.start" | "session.start", (e) => ...) with e.sessionId, e.cwd, e.outcome. Sound: spawn("afplay", ["/System/Library/Sounds/Glass.aiff"]) from node:child_process.
Provider: api.registerProvider({ id: "acme", type: "openai-compatible", baseUrl: "https://llm.acme.example/v1", apiKeyEnv: "ACME_API_KEY", models: [{ id: "acme-coder-1" }] }); key by env name only.
Helpers: api.exec(program, args, { cwd }) -> { stdout, stderr, code }; api.dataDir (private folder); api.toast(text); api.log(level, text).
Keys and screen in the same file, tui(api): api.key("f5", (a) => a.submit("run the tests")), api.command, api.slot: {{program}} docs extensions; keys only: {{program}} docs keys. A shell command at an event, no TypeScript: {{program}} docs hooks.
Model/tools/messages, flags, dialogs, MCP, virtual models: {{program}} docs extend-session. Hooks apply to the native engine; a handler failing 3 times stops.
