# Areas

An area is a set of folders that keeps user memories, model roles and default permissions apart. Your session belongs to the area whose folders contain its project; the most specific folder wins, and everything else is **personal**.

## Add an area

1. Add the folders and default permission for the area:

   ```sh
   mendcode area add company ~/Code/acme --permission edits
   ```

2. List the areas:

   ```sh
   mendcode area list
   ```

Nothing to switch: opening a terminal in `~/Code/acme/api` is working as `company`. The row under the prompt shows `◆ company` when the project is in an area.

## What an area keeps apart

| Area-specific choice | How it works |
|---|---|
| User memories | Saved by you or proposed by the agent while working in an area's folders, they belong to that area and are only injected, listed and searched there. |
| Model roles | A recipe applied in an area's folders (`/model`, `/setup`, `mendcode recipe apply`) sets that area's roles; personal uses the top-level ones. |
| Default permission | Applies to new sessions, and to loops and workflows started there. |

Project memories already belong to their folder. Dream files its user-scope proposals under the area of the project it read.

Sessions, profiles, themes and the daemon are shared.

## Limits and removal

- You can have up to 8 areas.
- Names use lowercase letters, digits and `-`.
- Removing an area keeps its memories, tagged with the old name, but no longer uses them.

The setting is `areas`; the older name `profiles` is still read as `areas`.

## Prompt focus and recipe previews

Prompt focus is an independent per-project choice. It changes native guidance, not area membership or model roles.

| Focus | Behavior |
|---|---|
| `auto` | Follows the session's model. |
| `codex`, `claude`, `gemini`, `kimi`, `deepseek`, `mistral` | Explicit prompt focus choices. |

Automatic mapping between v1 focus and v2 areas is undecided. See [prompt-modes.md](prompt-modes.md).

`/ai-config` previews and saves typed recipes without activating them. Exact diffs, local tariff estimates, validation and explicit apply are described in [ai-config.md](ai-config.md).
