# Areas

An area is a set of folders. A session belongs to the area whose folders contain its project (the most specific folder wins); everything else is **personal**. Nothing to switch: opening a terminal in `~/Code/acme/api` is working as `company`.

```
mendcode area add company ~/Code/acme --permission edits
mendcode area list
```

What an area keeps apart:

- **User memories.** Saved (by you or proposed by the agent) while working in an area's folders, they belong to that area and are only injected, listed and searched there. Project memories already belong to their folder. Dream files its user-scope proposals under the area of the project it read.
- **Model roles.** A recipe applied in an area's folders (`/model`, `/setup`, `mendcode recipe apply`) sets that area's roles; personal uses the top-level ones.
- **Default permission** for new sessions (and for loops and workflows started there).

Sessions, profiles, themes and the daemon are shared. The row under the prompt shows `◆ company` when the project is in an area. Removing an area keeps its memories (tagged with the old name) but no longer uses them. Up to 8 areas, names in lowercase letters, digits and `-`. The setting is `areas`; the older name `profiles` is still read as `areas`.

Prompt focus is an independent per-project choice (`auto`, which follows the session's model, or `codex`, `claude`, `gemini`, `kimi`, `deepseek`, `mistral`). It changes native guidance, not area membership or model roles. Automatic mapping between v1 focus and v2 areas is undecided. See [prompt-modes.md](prompt-modes.md).

`/ai-config` previews and saves typed recipes without activating them. Exact diffs, local tariff estimates, validation and explicit apply are described in [ai-config.md](ai-config.md).
