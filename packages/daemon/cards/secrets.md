---
summary: API keys, tokens and passwords: markers, the /env vault, chat encryption
docs: secrets, environment-privacy, sandbox
aliases: secret, credentials, api-key, apikey, token, password, vault, env, privacy, encryption
---
For: "save my API key", "use this token in a command", "the key leaked into the chat", "encrypt my chats", "environment variables for the model's commands".

Commands (the user types them): /secrets manages pasted secrets, /env named credentials, /privacy chat encryption.
The rule: never ask for a secret in chat, never print one, never write one to a file or a command line. The user types a key in /connect (a provider) or /env (any named credential); a secret that was pasted in a message becomes a marker ‹secret:N› before the model or the transcript sees it.

Pasted secrets: the model sees only ‹secret:N›. To use one, write the marker in a shell command or in the content of write, edit or apply_patch; MendCode puts the real value in just before the tool runs, after the user approves, and hides it again in the output. The secrets tool lists markers and credential names (never values). Detected shapes: provider keys, GitHub, AWS, Slack, Google, Stripe, JWT, PEM keys, user:password@ URLs, Bearer headers, and NAME=value where the name holds SECRET, TOKEN, PASSWORD, API_KEY.

Named credentials, /env (hidden from tier minimalist; /tier balanced shows it): a adds a name and a hidden value, ctrl+s picks scope (project default, session, global), i imports a dotenv inside the project after a preview of names only, e replaces, x removes. Session overrides project overrides global. In the native engine the model sees the names and built-in shell and shell_session processes (background included) receive the values as environment variables: use os.environ["NAME"], never print it. New values reach new processes only. The vault is encrypted on disk; no tool reveals a value. Claude Code, Codex, pi and ACP get the values in their process environment too (names in their prompt), but no masking; setting engineEnvironment false keeps them native-only.

Chat encryption, /privacy (off by default): p then y encrypts the local database, attachments and saved tool output; ordinary cat, grep and SQLite readers can no longer read them. Turning it off restores plain files.

If a key was exposed: tell the user to revoke it at the provider and add the new one with /env or /connect. Masking is a net, not a reason to paste secrets.

Not possible: reading a secret's value, exporting the vault, injecting into custom or overridden tools, a model tool that sets a credential.

Check: the secrets tool lists the name; the command that uses it prints ‹env:NAME› instead of the value. Say so if you could not run it.
