---
summary: TypeScript extensions: slots, keys, pages, views, daemon hooks
docs: extensions-tui, extensions, views
aliases: extension, plugins, plugin, slots, views, slot
---
An extension is one .ts or .js file in <data dir>/extensions/ (also extensions/<name>/index.ts). Adding a file adds the feature; deleting it removes it. Layers: user packages, user folder, project packages, project folder (later wins a name, key or slot); project modules load only after the user trusts the project in /tools. Code runs with the user's privileges, not sandboxed.
  export default { name: "unique", tui(api) { ... }, daemon(api) { ... } }

Write it with customize_ui (in minimalist find it with tool_search; it only writes the user's flat extensions/ folder, names like look.ts, up to 64 KiB):
  {"action":"write","file":"look.ts","content":"<whole module>"}   {"action":"edit","file":"look.ts","old":"<unique text>","new":"..."}   {"action":"reload"}
The module is reloaded live, no restart. The result has errors (fix them with edit), terminalValidation (pending = no terminal acknowledged yet) and file.

tui(api), drawing and input:
- api.settings.get(key) / set(key, value) / set({...}): the profile keys of {{program}} docs customize.
- api.slot("footer.left|footer.right|footer.replace|header.replace|prompt.above|prompt.below", ctx => rows): rows are arrays of spans {text, fg, bg, bold, dim}; example in {{program}} docs footer.
- api.view(slot, input => rows | undefined): replace a built-in surface (message.user, message.assistant, tool.card, approval, topbar, sessions.sidebar, footer, home, slash.menu, page.status, ...). Pure and fast (4 ms); three faults turn the view off. List every slot: {{program}} view list; starter file: {{program}} view scaffold <slot>.
- api.renderMessage(role, ctx => rows), api.markdown(role, fn), api.messageStyle(role, {icon, label, lead, tint, layout}), api.prompt.chrome({lead, border, preset}), api.widget("tray"|"sidebar", id, {title, render}), api.page(id, {title, render}).
- api.key(key, run) binds a key live; api.command(name, description, (args, actions) => ...) adds a slash command; api.onStart(start) for processes, sockets and timers (runs after the old copy's api.onDispose finished, so a reload never runs two); api.onDispose(cleanup, may return a promise), api.redraw().
daemon(api): api.on("tool.before" | "tool.after" | "input" | "turn.end" | "prompt.system" | ..., handler), api.registerTool(tool), api.registerCommand({name, description, run}). Hooks apply to the native engine. Commands that only run a shell command at an event need no TypeScript: {{program}} docs hooks.
Package it for sharing: {{program}} docs packages. A failing module is skipped and listed in /extensions and /doctor.
