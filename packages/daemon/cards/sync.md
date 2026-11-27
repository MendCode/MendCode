---
summary: sessions in step with a VPS: mirrors, take, handoff
docs: sync
aliases: parity, remote-parity, hub-parity, session-sync, mirror, sync-handoff, sync-take, lease, hub, vps-sync, two-way
---
For: "see my VPS sessions on my laptop", "continue that session here", "move this session to the server", "why can't I write this session".

Off by default; the user turns it on: {{program}} remote setup HOST --ssh USER@VPS --sync (or remote pair HOST --ssh USER@VPS --sync), or {{program}} sync enable REMOTE --sync-token-file F [--path-map LOCAL=HUB] [--no-memories] [--no-settings]; sync disable turns it off. The host is the hub and owns sessions; this machine is a device. Never edit sync.json, sync-hub.json or tokens yourself.

Who writes: one machine per session. A hub session is a read-only mirror here; a prompt to it is refused with the owner's name. {{program}} sync take ID writes it here under a lease (the hub then refuses prompts, naming this machine); sync release ID hands it back (also after 10 idle minutes); sync handoff ID gives the hub a session made here. None moves a session while a turn runs. If this machine dies, its lease ends and the hub writes again; turns that never reached the hub stay here as a "diverged" copy, never merged.

What syncs: session events at the same seqs (no duplicates), title/archive/pin, attachments up to 8 MiB (bigger ones stay, with a note), memories (newest edit wins, deletes travel) and preference settings. Never: credentials, tokens, environment.enc, keys, engine bindings, authority or machine settings.

Projects match by git remote plus the path in the repo; pathMap rules cover the rest. A handoff to a hub without the project is refused: clone it there.

Keep the hub set up like this machine: {{program}} sync parity [REMOTE] compares (profiles, skills, agents, themes, prompt files, MCP servers, graft version); sync parity --apply brings the hub level through an import with backups (config-bundle rollback undoes it). MCP servers arrive pending and sign in on the hub; credentials, settings and the terminal look never travel; code that runs on its own needs --code; a held-back folder needs --allow-flagged PATH. It uses the saved remote's full token (a sync token cannot). sync enable REMOTE --follow (or sync follow on|off) repeats it every 10 minutes and on sync now, without code.

Check: {{program}} sync status (owner and state of each session), sync now (one round now). Files: sync.json (device: remote, token file, pathMap), sync-hub.json (this machine is a hub), remote/REMOTE.sync-token.
