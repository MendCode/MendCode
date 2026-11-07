# Prompt modes and focus

Choose a prompt mode to control how much MendCode guidance a native model receives on every call. Use `/prompt-mode` to choose the project's mode and provider focus family.

## Choose a mode

1. Run `/prompt-mode` to open the project prompt selector. Setup and Customize open the same selector.
2. Select a mode or focus family with the keys below.
3. Press Enter to apply it to the next native model call.

| Key | Does |
|---|---|
| Up/Down | Select. |
| Tab or 1/2 | Switch between modes and focus families. |
| Enter | Apply. |
| `c` | Cycle. |
| `r` | Refresh. |
| Esc | Return. |

Tab in the chat prompt only completes a slash command.

| Mode | Native model context |
|---|---|
| `minimal` | A small MendCode boundary, the one-line docs pointer, your project and user instructions, and independently selected memories. Skills are listed by the `skill` tool (called with no name), not in the prompt |
| `focus` | Native coding harness, your project and user instructions, the skill catalog (name and one-line description, at most 4,000 characters), a one-line family note, the working core (four habits, below), the model note when one matches, the capability line, boundary and memories. The lean default |
| `guide` | Focus with the provider guide in place of the working core: the working basics every family shares and a longer guide to how the model's family uses MendCode's tools, with model notes (reasoning versus not, size variants). Costs more on every call, see below |
| `full` | Guide plus a short operator's guide to MendCode itself (about 1,370 characters, generated from the reference cards) and family context files |
| `custom` | Project prompt, boundary, your project and user instructions and memories; no inherited focus/full context and no skill catalog |

### Include instruction files

Instruction files (`AGENTS.md` and friends, see [instruction files](resources-config.md#instruction-files)) support whole `@relative/path` lines outside code fences.

Paths resolve relative to the containing file, confined to the canonical project root including symlink targets. Cycles are deduplicated.

| Include limit | Value |
|---|---|
| Depth | 8, with cycles deduplicated. |
| Files | 100 |
| Total characters | 64,000, plus existing per-file caps. |

Disable includes with `/tier instruction_includes off`.

## What the model's provider family gets in each mode

Every native model call gets guidance for the family of the model it is sent to (Claude, GPT/Codex, Gemini, DeepSeek and so on); how much depends on the mode, and so on the tier:

| Mode (tier that sets it) | Family guidance sent on every call |
|---|---|
| `minimal` (minimalist) | None. The prompt is the same for every model |
| `focus` (**balanced**) | One line, `MendCode focus: <family> (auto)`, followed by the family's short working rules (one to three sentences); for a few models with known quirks (GPT-5.6, GPT-6 Astra, Claude Sonnet 5 and Opus 5, DeepSeek V4 and V3.2, Kimi K2.5) a short compatibility note too |
| `guide` (no tier; `/prompt-mode guide`) | `focus` plus the provider guide: the basics every family shares, the family's full guide file (`packages/daemon/prompts/focus/<family>.prompt.md`) and the note for the model when one matches (reasoning or not, Flash or Pro, Opus or Haiku) |
| `full` (full) | `guide` plus the family's context files from the project (for example `CLAUDE.md` for `claude`, `GEMINI.md` for `gemini`, `.agents/context.md` for `codex` and `deepseek`) when the instruction loader has not already sent them, and the operator guide |
| `custom` | None; your project prompt replaces it |

So balanced does adapt to the provider, but briefly: the family's full guide is `guide` and `full` only. For the full guide on a balanced project, run `/prompt-mode guide` (or `mendcode prompt mode guide`); it costs about 560 to 690 more tokens on every call, depending on the family (see the budgets below).

- **Which family:** with `auto` (the default) it is read from the id of the model each call goes to, so changing models changes the guidance on the next call. A model behind a gateway (`openrouter/anthropic/claude-…`) gets its own family, not the gateway's. A model no family claims gets `neutral`: a family-less line in `focus` and the shared basics in `guide`, never another vendor's text. The full matching rules are below.
- **Forcing a family:** pick one in `/prompt-mode` (Tab switches to the families) or run `mendcode prompt mode --focus <family>`. The choice is saved per project and wins over the model; picking `auto` again follows the model.
- **Not affected:** the family changes only this text, never the provider, model, permissions, budgets or transport. Claude Code, Codex, ACP agents and pi build their own prompts, so this applies to native models only (`claude` therefore means Claude on the native engine with an API key).

### Instructions in every mode

Your instructions are rules, not optional chrome: every mode carries the `AGENTS.md`/`CLAUDE.md` hierarchy and global `AGENTS.md`. The loader caps them at 16,000 characters per file and 64,000 in total.

Only `--no-context-files` leaves them out. Previously, only `full` always carried them; default `focus` ignored a repository's `AGENTS.md` until a file under it was read.

For a typical project with a 1.6 KB `AGENTS.md` and five skills, estimated tokens (characters over four) change as follows:

| Mode | Before → after |
|---|---|
| `minimal` | 0 → 204 |
| `focus` | 0 → 346 |
| `full` | 346 → 346 |

A repository without instruction files or skills adds nothing in any mode.

`APPEND_SYSTEM.md` is your own text too: every mode sends it after the instructions. It can come from the user, profile or project layer; see [extensions](extensions.md#prompt-files).

Previously, only `full` sent it, so "always answer in Spanish" there was silently dropped in default `focus`.

`SYSTEM.md` replaces the packaged base prompt where a mode sends it: `focus`, `guide`, `full`. The `minimal` and `custom` modes have their own base.

A [tier](tiers.md) sets the project's mode once when applied (`minimalist` → `minimal`, `balanced` → `focus`, `full` → `full`); no tier sets `guide`. Modes are ordered `minimal` < `focus` < `guide` < `full`, and each one is the previous one plus more text.

### Defaults and saved choices

| Choice | Default or storage |
|---|---|
| Mode | `focus` |
| Family | `auto` |
| Saved choices | Per canonical project directory in `<dataDir>/prompt-context.json`, saved atomically. |
| Project without a saved choice | The existing TUI `promptContext` value remains a default. |

Changes apply to the next native model call, including after restart. External Codex/Claude Code engines retain their own prompt construction.

### Use a custom prompt

Custom mode reads `.mendcode/prompts/custom.md` inside the project. Selecting a mode creates no project prompt file.

| Source rule | Behavior |
|---|---|
| File | Must be a regular file, at most 32 KiB, including UTF-8 multibyte content. |
| Symlinks | Targets outside the project are rejected. |
| Choice name | Optional frontmatter `name:` or a Markdown heading; frontmatter is omitted from instructions. |
| `{{cwd}}` | Expands to the project directory. |

The picker and cycle include custom only when usable. An explicitly selected custom mode with a missing, empty or unsafe source keeps the small boundary and reports the reason; it never inherits focus.

Focus families are `codex` (GPT and o-series), `claude` (only when Claude runs on the native engine with an API key), `gemini`, `kimi`, `deepseek`, `mistral`, `glm` (Z.ai), `minimax`, `grok` and `local` (open-weight models served by Ollama, LM Studio, llama.cpp or vLLM), plus `auto`. They select native behavior guidance and full-mode context sources, without changing provider, model, permissions, budgets or transport.

### How auto matches a family

`auto` is the default for projects with no saved family. Every native call resolves the family from the session's model id, so switching models changes guidance on the next call.

| Model names or provider prefixes | Family |
|---|---|
| `claude-*`, `anthropic`, `sonnet`, `opus`, `haiku` | `claude` |
| `gpt-*`, `o<N>`, `codex`, `chatgpt`, `openai` | `codex`, except `gpt-oss`, OpenAI's open-weight model, which is `local`. |
| `gemini-*` | `gemini` |
| `kimi`, `moonshot` | `kimi` |
| `deepseek` | `deepseek` |
| `mistral`, `codestral`, `devstral`, `magistral`, `mixtral`, `ministral` | `mistral` |
| `glm*`, `zhipu`, `z.ai`/`z-ai` | `glm` |
| `minimax` | `minimax` |
| `grok*`, `xai` | `grok` |
| `llama*`, `qwen*`, `gemma*`, `phi*`, `granite*`, `ollama`, `lmstudio`, `llamacpp`, `vllm`, `local` | `local` |

The model name is matched first: the part after the last `/` or `:`. Then the provider prefix is matched, so `openrouter/anthropic/claude-3` is `claude` and `ollama:llama3.1:8b` is `local`.

Unknown ids resolve to `neutral`: one-line family-less guidance to read before editing, stay in scope and verify with command output. They get no other vendor's text.

An explicit family always wins over the model and is saved as before. Choose `auto` again to return to following the model.

A `codex` saved before `auto` existed is kept: untouched projects also saved it on their first mode change, so it cannot be distinguished from a deliberate choice. Pick `auto` to follow the model.

The selector, `/setup`, `prompt status`/`sources` and the focus section label in `/context` show `auto → claude`: the session model's resolved family, or the project's main model outside a session.

`prompt sources` reports those sources and their native behavior policy. No donor code, framework or upstream prompt snapshots are imported.

Automatic equivalence between v1 focus and v2 areas remains a user decision. Areas continue to isolate memories, model roles and default permissions independently.

## The provider guide (`guide`), budgets and the operator guide

`focus` is the lean default and its text is what it was before `guide` existed plus three parts: the docs pointer below, the working core and, when one matches the model, the family file's model note. Without those three it is byte for byte the earlier text for every family that existed before `guide` (pinned by `packages/daemon/test/prompt-guidance.test.ts` against `packages/daemon/test/fixtures/prompt-focus-pre-guide.json`), and `glm`, `minimax`, `grok` and `local` have a one-line note of the same size, enough for `auto` to resolve them.

The working core is the `<!-- focus -->` block at the end of `basics.prompt.md` (272 characters, at most 600; its `todo` line moved to the plan line below): say in one sentence what a batch of changing tool calls will do, cite code as `path:line`, answer with the result first and then the check and what stays unverified.

That diffs and whole files are not pasted is said once, by the base prompt.

The core and the longest model note together stay under 1,200 characters; neither was measured with an eval. `guide` and `full` send the full basics instead of the core, never both.

The longer per-family guidance is its own mode, `guide`, because it is sent on every model call and a fixed per-call prompt is the main input-token cost.

Nothing in it is on unless you choose it (`/prompt-mode guide`, the setup and customize rows, or `mendcode prompt mode guide`).

**Cost notice.** Wherever a mode is chosen or shown, MendCode says what it costs: the estimated tokens the mode puts in front of every model call for the current model's family, measured on the real composed text (the packaged base prompt plus the mode's parts, characters over four, without your project instructions, skills or memory, which no mode changes).

The line reads `guide · +620 tokens per call (1,190 total)`, the part added over `focus` and the whole prompt (`minimal` and `focus` read `focus · 570 tokens per call`), and for `guide` and `full` a warning, `sent with every call`, follows it (a second line in the pages, after ` · ` in notices).

It appears in the `/prompt-mode` page (under the highlighted mode) and in the notice after `/prompt-mode <mode>`, in the `/setup` and `/customize` prompt rows, and in `mendcode prompt mode|cycle-mode|status` (first line of the plain output; the JSON carries the numbers as `costs: [{ mode, tokens, overFocus }]`).

It never blocks or asks for confirmation.

The text lives in files, not in code. `packages/daemon/prompts/focus/` holds `basics.prompt.md` (the working basics every family shares: calls of one response run in order, so independent calls and a small edit with its check go together; `edit` discipline, background `shell`, `loop`, `task`) and one `<family>.prompt.md` per family; a model no family claims (`neutral`) gets the basics alone.

A family file has a header (`family`, `provenance`), a body for every model of the family, and optional model notes opened by a line `<!-- model "Label" /regex/flags -->`; the first note whose pattern matches the model id is sent as its own part after the family guidance (for example reasoning versus non-reasoning DeepSeek, Flash versus Pro Gemini, Opus and Haiku).

The header is never sent: `provenance` says what the file is based on.

The files are named `*.prompt.md` on purpose: a plain `claude.md` or `gemini.md` would collide with the `CLAUDE.md` and `GEMINI.md` instruction files on case-insensitive file systems.

They are embedded in the binary and read on first use of a family.

All guidance is original MendCode text.

v1 shipped vendor prompts (OpenAI Codex, Gemini CLI, Kimi CLI and Mistral Vibe, all Apache-2.0) for four families; v2 keeps only their behavioural facts, rewritten for this harness and its tools, and never reproduces a vendor's system prompt or documentation.

The Claude, DeepSeek, GLM, MiniMax and Grok guidance was behaviour-only in v1 and stays so.

Guidance for models newer than the author's reference material (GLM, MiniMax, Grok, Kimi K2.5, DeepSeek V4, Gemini 3, the GPT-6 and Claude 5 generations) is deliberately conservative: only widely documented traits and facts about this harness.

Budgets (characters, tokens estimated as characters over four; `PROMPT_BUDGETS` in `packages/daemon/src/prompt-guidance.ts`, enforced by `packages/daemon/test/prompt-guidance.test.ts`). With the packaged base prompt (cwd `/project`) and no project instructions, skills or memory, smallest to largest family:

| Mode | Characters (tokens) | Over `focus` | Ceiling (characters) |
|---|---|---|---|
| `minimal` | 915 (229), the same for every family | -2,761 to -2,937 | 920 |
| `focus` | 3,852 for `neutral` (963), 3,676 to 3,727 for a family (919 to 932), plus the model note when one matches | 0 | the core at most 600 |
| `guide` | 4,558 for `neutral` (1,140), 5,538 to 6,109 for a family (1,385 to 1,528) | +706 for `neutral`, +1,862 to +2,382 for a family | 6,500 |
| `full` | 6,058 for `neutral` (1,515), 7,038 to 7,609 for a family (1,760 to 1,903) | `guide` plus about 1,500 characters (+375 tokens) | 7,800 |

What the terminal draws (`packages/daemon/prompts/rendering.md`) is told by mode: `minimal` and `custom` say nothing, `focus` (balanced) one sentence (Markdown is drawn, a `mermaid` fence draws a diagram, `> [!NOTE]`/`> [!WARNING]` make a callout, images are not drawn), and `guide` and `full` the exact syntax with when to use it (the Markdown forms, the Mermaid families, the five callouts `NOTE`, `TIP`, `IMPORTANT`, `WARNING`, `CAUTION`, swatches, path links).

It was a block of the base prompt sent to every mode with a base; it raised the `full` ceiling from 7,400, and `full` costs the same now.

Claude Code, Codex, pi and ACP agents get the same text for the project's mode.

Which forms the screen draws is in [markdown design](design/markdown-parity.md): callouts only in the balanced and full views with the `full` renderer.

`guide` adds the basics (at most 1,100 characters), one family body (at most 3,000) and at most one model note (at most 600).

Everything in it is static: no date, path, model name or counter, so a provider can cache it.

The prompt parts are ordered base, instructions, skills, boundary, family note, working core or provider guide, model note, then (in `full`) the operator guide and family context files, then the capability line, and the memory block last, because memory is chosen per user message.

**Plan line.** While the call's catalogue lists `todo` (balanced and full, feature `visible_plan`), `focus`, `guide` and `full` carry one line right before the capability line (`packages/daemon/prompts/visible-plan.md`, 165 characters; the harness line 156): call `todo` first for work of three or more steps, the user follows it in the progress row, update it and do not restate it.

Without the tool there is no line, so minimalist and a balanced session with `/tier visible_plan off` carry none.

Claude Code, Codex and ACP agents get the file's second line after their own prompt while `visible_plan` is on (their own list is pinned too); pi and the `minimal` mode get neither ([the visible plan](layout.md#the-visible-plan)).

**Capability line.** In `focus`, `guide` and `full` a native session's prompt ends, before memory, with one line built from that session's tool catalogue (`capabilityIndex` in `packages/engine-native/src/tool-discovery.ts`, at most 350 characters).

It names the MendCode tools a model tends to deny having, in a fixed order and only when the catalogue has them: `image_gen` (pictures show in MendCode), `computer_*` (only when computer use is enabled), `remember`/`memory`, `websearch`/`webfetch`, `browser`, `screenshot`, `loop`, `workflow_*`, `lsp`, `secrets`, `threads`, `pr_watch`, `todo`.

Listed tools and deferred ones are named apart, and deferred ones are said to be reached through `tool_search`.

A deferred tool stays in that list after `tool_search` finds it, so the line, and the cached prefix before memory, stays the same for the session until its tool set changes.

Hosted provider tools (a provider's own web search or image generation) are not in the catalogue and are not named.

`minimal` and `custom` do not carry it, and neither does `prompt build` or the costs above, which have no session catalogue.

Every mode but `custom` carries one line (`packages/daemon/prompts/self-knowledge.md`, 428 characters, at most 430): the model runs inside MendCode, whose screen (start screen, logo, sidebars, bars, prompt, footer, labels), keys, slash commands, Galaxy panel, pet, agents, models, settings and the model's own tools, hooks and system prompt are MendCode's and not the project's, and for those only it first runs `mendcode docs --search <words>`; a rule the user sets for later is an extension, not a promise or a one-time check.

The behavior half was measured with `scripts/eval-extend.ts` (gpt-6-luna 3 of 15 before, 14 to 15 of 15 after).

Naming the screen's parts was measured with `scripts/eval-customize.ts`: look requests that a shorter line let go to the project (4 of 24 runs on the eight hardest requests) went there in 1 of 24.

The wording is the one gpt-6-luna followed (measurements in the comment on `PROMPT_BUDGETS.selfKnowledge`): naming the terminal's own parts was followed in 13 of 14 runs, and scoping the search with "for those only" stopped plain coding tasks from opening with a docs search (5 of 10 runs before, 0 of 6 after) while a footer request was still followed in 3 of 3.

The same line sits right after the boundary in `minimal`, `focus`, `guide` and `full`, so it is part of the cached prefix.

`custom` inherits nothing and does not carry it.

`full` adds a short operator's guide (at most 1,500 characters): the topic list of `mendcode docs`, where settings, extensions and profiles live and in which layers, that `customize_ui` (found with `tool_search`) is how a model changes the user's terminal, that daemon settings are the user's to change, the rule never to change permissions, sandbox, trust, proxy or credentials, to read live state before changing it, and that tier, prompt mode, permission mode and process mode are four different things.

It is generated, not hand-kept: `packages/daemon/prompts/operator-guide.template.md` is authored text with the topic list filled from `packages/daemon/cards/` and `bun scripts/self-knowledge.ts` writes `operator-guide.md`.

Generation fails when the template names a slash command, setting or doc file that `docs/` does not contain.


## Output styles (`/output-style`)

Run `/output-style [default|explanatory|learning|terse|caveman]` to save `settings.outputStyle`. With no argument, it shows the current style; absent means `default`.

| Style | Effect |
|---|---|
| `explanatory` | Add brief "why" notes while working. |
| `learning` | Explain steps and possibly leave a small marked piece for you to write. |
| `terse` | Keep prose to what you can act on. |
| `/output-style caveman` | Opt-in prose compression for balanced/full, preserving exact code, paths, quantities, verification and uncertainty. No measured savings percentage is claimed. |

From the next message, a short tone block is appended to the native system prompt in every prompt mode. It shows in `/context` as `output style`.

Styles change how answers read, never tools, permissions or verification. External Codex/Claude Code engines keep their own prompts.

## Reply language (`/language`)

Replies are in one language, restated with every message you send, so a long run of tool output, files or logs in another language
does not move the answers to it. The setting is `settings.language`, in every tier:

- unset or `auto` (the default): the language of your latest message, judged locally from the message (its script, then common words
  of Spanish, Portuguese, French, English and a few more). No model call. When the message is too short or mixed to tell, the line
  asks for the language you write in without naming one.
- a language name (`Español`, `English`, `Deutsch`): every reply is in it, whatever the conversation is in.

Run `/language` to see it, `/language auto`, `/language <name>` or `/language next` (auto, English, Español, Português, Français) to
change it; the **Reply language** row of `/customize` (Chat, Messages) steps through the same list. A model can propose it with
`mendcode_settings` (`{"language":"Español"}`, `null` for auto), saved on your Apply. It applies from the next message.

How each engine gets the line (one short sentence: `Reply in Spanish.`, or `Reply in the user's language.` when auto cannot tell):

| Engine | Where the line goes | Seen in the transcript |
|---|---|---|
| native | after your message's text in the model's history, in brackets; never in the system prompt, so the cached prefix is the same every turn | no |
| Claude Code | its `UserPromptSubmit` hook's `additionalContext`, which Claude Code adds to your message as context | no |
| Codex | after your text (and the plan-mode note) in the turn's input | no |
| pi | after your message (and the plan-mode note) in the prompt | no |

A sub-agent, workflow task or critic gets no line: it answers its parent, not you. A PR review or fix session uses the repository's
review language (`template.language`, [PR review](pr-review.md)) in place of yours. ACP agents get no line.

## Automation

```sh
mendcode --dir /tmp/mend-data control-plane prompt sources --json
mendcode --dir /tmp/mend-data control-plane prompt build --mode full --focus gemini --model local:test --role main --workflow edit --show-full --json
mendcode --dir /tmp/mend-data control-plane prompt mode full --focus claude
mendcode --dir /tmp/mend-data control-plane prompt cycle-mode
```

| Command form | Behavior |
|---|---|
| `prompt` without `control-plane` | Also accepted. |
| No operation | Means `mode`. |
| No mode argument | Read the current choice. |
| `mode --focus <family>` | Set only the family. |
| `dev-js` | Compatibility alias for `full`. |

The project is the CLI working directory. As for other automation commands, `--dir` selects daemon data.

### Preview the native context

Build is a read-only native system-context preview, not a provider request or turn. Its overrides are never saved.

Defaults are `--mode focus --focus auto`. The `auto` family resolves from `--model`, or the project's main model when none is given; `prompt sources --model <id>` shows the same resolution.

Model/role/workflow select applicable behavior guidance without selecting a runtime model. Review and edit/apply policies are distinct; model guidance is gated by focus family.

JSON contains section bytes and bounded previews; `--show-full` adds assembled instructions. Credential-like values are redacted.

Session memory selection and engine-added turn metadata are outside this preview. Metadata queries are allowed to read-only peers; build, set and cycle are not.

Wire commands: `prompt.status`, `prompt.sources`, `prompt.build`, `prompt.set`, `prompt.cycle`. Typed client helpers provide status, set and build.
