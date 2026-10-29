# Profiles

A profile is a set of folders. A session belongs to the profile whose folders contain its project (the most specific folder wins); everything else is **personal**. Nothing to switch: opening a terminal in `~/Code/acme/api` is working as `company`.

```
mendcode profile add company ~/Code/acme --permission edits
mendcode profile list
```

What a profile keeps apart:

- **User memories.** Saved (by you or proposed by the agent) while working in a profile's folders, they belong to that profile and are only injected, listed and searched there. Project memories already belong to their folder. Dream files its user-scope proposals under the profile of the project it read.
- **Model roles.** A recipe applied in a profile's folders (`/model`, `/setup`, `mendcode recipe apply`) sets that profile's roles; personal uses the top-level ones.
- **Default permission** for new sessions (and for loops and workflows started there).

Sessions, packages, themes and the daemon are shared. The row under the prompt shows `◆ company` when the project is in a profile. Removing a profile keeps its memories (tagged with the old name) but no longer uses them. Up to 8 profiles, names in lowercase letters, digits and `-`.

Prompt focus is an independent per-project choice (`auto`, which follows the session's model, or `codex`, `claude`, `gemini`, `kimi`, `deepseek`, `mistral`). It changes native guidance, not profile membership or model roles. Automatic mapping between v1 focus and v2 folder profiles is undecided. See [prompt-modes.md](prompt-modes.md).

`/ai-config` previews and saves typed recipes without activating them. Exact diffs, local tariff estimates, validation and explicit apply are described in [ai-config.md](ai-config.md).
