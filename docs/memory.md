# Memory

The [automation memory commands](automation.md#memory-control-plane) expose status, retrieval preview, editing, deletion, proposals, Codex import, resolution, index rebuilding and scoped configuration. Codex `--apply` creates Pending user proposals, visible here with `codex-import` tags; approval is a separate action. Ordinary and imported revisions capture their target's full revision at creation, so later edits, moves or metadata changes invalidate approval.

`/memory` (`/mem`) has nine tabs. `tab`, `shift+tab` and `1`–`9` switch; `esc` goes back to the chat.

| tab | shows |
|---|---|
| 1 Pending | proposals from the agent and Dream, waiting for you |
| 2 Saved | what the agent remembers |
| 3 Archived | memories set aside; they can be restored |
| 4 Dream | when Dream runs next, its budget, its recent runs and each run's safety report |
| 5 Graph | saved memories and the links between them |
| 6 Policies | what becomes of a proposal, per category |
| 7 Evolution | the Evolution mode and the skill and instruction suggestions it made |
| 8 Extraction | memory switches, caps, maintenance policy and durable post-turn jobs |
| 9 Sharing | scope consent, editable Markdown snapshots, imports and conflicts |

On narrow terminals (under 64 cells) the tab row shows only the numbers.

## Pending, Saved and Archived

Each row shows the memory's scope (`user`, `project` or `session`), `pinned` when it is, its category and who proposed it. The wide layout (120 cells and up) adds a detail panel. `/` filters by text, category, scope, or the word `pinned`; the list includes the session-scope memories of the project (`memory.list` with `session: "all"`).

| key | tab | does |
|---|---|---|
| `a` / `x` | Pending | approve / reject |
| `x` | Saved | archive |
| `r` | Archived | restore |
| `e` | all | edit the text in the prompt (`enter` saves, `esc` cancels) |
| `p` | Saved | pin or unpin (`memory.update` with `pinned`); at most 20 per profile, directory or session, and the daemon's refusal is shown |
| `c` | all | pick a category from the known list (`memory.categories`): `↑↓` or `1`–`9`, `enter` sets it (`memory.update` with `category`) |
| `s` | Saved | pick a scope: `user`, `project` (this directory) or `session` (this session) |
| `d` | all | delete (asks first) |

A key that does not apply (pinning a pending memory, say) says why in a notice instead of starting a filter.

**Changing the scope re-creates the memory.** The protocol has no scope edit, so `s` saves a copy in the new scope (`memory.add`, keeping the text, the category and the pin) and then deletes the old one. If the copy fails (for example the new scope already has 20 pinned), the old one stays. The memory gets a new id and **its graph links are lost**. Pending and archived memories cannot change scope: approve or restore them first.

## Dream tab

Dream reads recent sessions and proposes memories. Its proposals follow their category's [policy](#categories-and-policies): by default they land in Pending.

- The first row shows the daily time (set in `/setup`), the token budget (`dreamMaxTokens`, "default" when unset) and how many proposals wait.
- Runs are listed newest first with their result and duration; a run made after a missed window is marked `recovered`.
- Under the list, the selected run's notes (or error) and its **safety report**: the trigger, what it read (sessions, reused digests, memories shown, characters sent), what it proposed and what became of each proposal, what it refused and why, secrets redacted in the evidence and in proposals, the model calls with input and output tokens (`estimated` when the provider reported none), the budget used and whether it stopped the run, what Evolution did, and any failure. `dream.list` carries the report of the newest five runs only; moving to an older run asks for its report once (`dream.list` with `runId`), and a run recorded before reports existed says so.

| key | does |
|---|---|
| `↑↓`, `jk` | select a run |
| `r` | run Dream now, like `/dream`. Nothing happens while a run is going |
| `b` | set the budget: type `60000`, `60k` or `1.5m` (1k to 2M), `enter` saves, an empty field goes back to the default, `esc` cancels. It is a `settings.set` of `dreamMaxTokens` |
| `v` | the full report: every session, proposal and refusal, scrolling with `↑↓` and `pgup`/`pgdn`; `v` or `esc` return to the list |
| `enter` | on a run that proposed memories, opens Pending |

How a run works, its safety report, the token budget and missed-window recovery are in [dream.md](dream.md). What it learns from repeated corrections is in [evolution.md](evolution.md).

## Policies tab

One row per category with its policy (`auto` saved at once, `review` kept in Pending, `never` dropped), a note when it differs from the default, and the category's meaning. A line below says what the selected policy does to a proposal. What you save yourself is always saved, and a proposal in which a secret was redacted always waits for review, whatever the policy says.

| key | does |
|---|---|
| `↑↓`, `jk` | select a category |
| `←→`, `hl`, `space`, `enter` | cycle the policy (`auto`, `review`, `never`) |
| `a`, `r`, `n` | set `auto`, `review` or `never` |
| `d` | back to the category's default |

Each change is one `memory.policy` command; the row follows the daemon's reply.

## Evolution tab

The top row is the `evolution` setting (`off`, `observe`, `suggest`, `auto-safe`) with a line on what the mode does, then what Evolution has seen in this project (`evolution.list`: corrections, preferences and how many recur). Below are its skill and instruction suggestions, newest first, with the selected one's description and content. Memory proposals it makes appear in Pending, not here.

| key | does |
|---|---|
| `←→`, `hl`, `m` | previous or next mode (`settings.set` of `evolution`) |
| `↑↓`, `jk` | select a suggestion |
| `a` | accept a pending suggestion (`evolution.resolve`): a skill is written to `.mendcode/skills/<name>/SKILL.md` and the path is shown; an instruction is only marked accepted and its text stays in the suggestion |
| `x` | reject a pending suggestion |

The list refreshes when a Dream run ends.

## Extraction tab

↑↓ selects a setting or job. Enter toggles a switch, cycles maintenance (`disabled`, `preview`, `auto-consolidate`), or edits a numeric cap; Enter saves and Esc cancels numeric editing. `r` retries a selected failed/skipped job, otherwise refreshes. Hints stay in the header; shared bordered panels fill larger terminals and compact terminals show the focused column.

Settings are independent: `memoryEnabled` gates generated proposals and retrieval; `memoryUse` gates prompt injection; `memoryGenerate` enables post-turn extraction; `memoryRequireApproval` forces extraction proposals into Pending. Prompt use and generation default off; approval defaults on. Enable use explicitly to inject saved facts; the v2 enabled switch retains its existing default on. Category `never` still drops proposals, `review` still requires review, and secrets always require review. Manual additions remain explicit user actions.

`memoryMaxPromptTokens` defaults to 10 000 (estimated at four characters per token, including wrapper); `memoryMaxEntries` defaults to 50 and `memoryProjectMaxEntries` to 3. These cap generated proposals and prompt retrieval; manual facts are retained. Pinned facts obey the configured overall prompt cap. `memoryGlobalCompactionMaxEntries` (default 50) is the user-scope entry cap for the memory preview taken after a compaction, where `memoryMaxEntries` applies to an ordinary request. `memoryProjects` holds per-project overrides keyed by the project's absolute directory (the same `memory*` keys); the memory control commands write it when called with the project scope, and it wins over the global value for that project.

`/remember [--user] <text>` saves one fact at once (this project, or every project with `--user`) without a proposal; it answers `remembered (this project)` or the error.

Completed ordinary user turns enqueue one redacted digest (at most 64 000 characters), excluding tool/reasoning output and child task turns. One worker persists queued/running/completed/skipped/failed state, attempts and retry deadlines, with 128 pending jobs and the latest 256 terminal jobs retained. A call times out after 45 seconds, retries twice with backoff, and never applies a late result after timeout or shutdown. Restart recovers interrupted jobs; settlement writes proposals and completion in one transaction. Disabling generation while a call runs discards its result. Without an extractor, jobs remain queued with a reason. The native daemon uses the tool-free `memoryExtractor` role (fallback `small`, then main); execution needs a configured provider. `memory.extraction.list/retry` and client `extractions(directory)` expose jobs without digest text.

Maintenance defaults disabled. Preview reports exact generated duplicates within the same profile/scope/project/session. Auto-consolidate archives these duplicates after a completed turn or extraction; user-authored, pinned and revision entries are protected. Maintenance stays deterministic and never calls a model; scored and semantic consolidation of pending proposals belongs to [Dream](dream.md) (`memoryConsolidator` role). Sharing is a local, explicit-consent flow described below. Codex import remains outside the local extraction worker.

## What the agent sees

The agent does not get every saved memory, only the ones that matter for what you just said. Before each model call, MendCode ranks the memories the session may see (your profile's user memories, the project's, and the session's own) and injects them as the `<mendcode_memory>` block, within the retrieval budget (6 000 characters by default) and the configured token/entry caps:

1. **Pinned** memories, always, newest first. They may use up to three times the relevance budget, but remain bounded by the configured overall prompt cap.
2. Memories that **match the prompt** or are linked to one that does, best first. A match is any distinctive word of the prompt found in a memory's text or category (full-text search; stop words and words under three letters are ignored).
3. A small share of the rest (at most a quarter of the budget, 1 500 characters), so standing rules and fresh notes still surface.

The score of a memory is its match, its recency (half-life of 30 days), its links to matches, a small lift for `preferences`, `constraints` and `security` and for the session's own memories, minus a penalty when another saved memory *supersedes* it. A memory already shown earlier in the session gets a lift too, so the prompt changes only when the ranking clearly does (this keeps the provider's prompt cache useful). When the block leaves memories out it says how many and points to `memory_graph` search.

## Scopes

| scope | visible to | removed |
|---|---|---|
| `user` | every project of one [profile](profiles.md) | with the memory |
| `project` | one directory | with the memory |
| `session` | one session only; never injected or listed anywhere else | with the session |

`memory.list` and `memory.search` show session memories only when asked: `session` is one session's id, or `all` for management views. Dream and the graph do not read them. Only you create a session memory (`memory.add` with `sessionId`); the agent's `remember` tool offers `project` and `user` only.

### Changing a memory's scope

`memory.update` with `scope` moves a memory to another scope **without losing it**: it keeps its id, text, category, status, pin and every graph link, so nothing around it breaks.

| moving to | also send | the memory becomes |
|---|---|---|
| `project` | `directory` | that project's (from another project too) |
| `session` | `sessionId` of an existing session | that session's, with the session's project as its directory |
| `user` | nothing | your memory for the profile it came from (a project or session memory takes the profile of its folder) |

A pending Dream revision (update/archive) cannot change scope, and a pinned memory only moves where the pin cap (20) has room. The move and any `text`/`category`/`pinned` in the same command are checked together and applied only if all are valid. `memory.update` without `scope` behaves as before.

## Pinned

A saved memory can be pinned (`memory.update` with `pinned`, or `memory.add` with `pinned`). Pinned memories are injected whatever the prompt says. At most **20** per profile (user scope), directory (project) or session. Only saved memories can be pinned; archiving or returning a memory to review unpins it.

## Categories and policies

An entry's category is free text. These ones are known (`memory.categories`; unknown or empty ones count as `other`; case and v1's `project.` / `user.` prefixes are ignored):

| category | for | default policy |
|---|---|---|
| `commands` | recurring commands, validation gates | review |
| `conventions` | code style, naming, workflow rules | review |
| `preferences` | how you like to work and be answered | review |
| `architecture` | module boundaries, data flow, services | review |
| `stack` | frameworks, runtimes, package managers | review |
| `release` | versioning, changelog, branch rules | review |
| `constraints` | permanent constraints, ownership rules | review |
| `security` | secret handling, permission rules | review |
| `objective` | stable product purpose | review |
| `other` | anything else | review |
| `volatile` | one-off or temporary details | never |

The **policy** says what becomes of a memory the agent, Dream or Evolution proposes in that category (`memory.policy` sets it; the setting is `memoryPolicies`, and a category set back to its default is removed from it):

| policy | proposal is |
|---|---|
| `review` | kept as Pending (what happened before) |
| `auto` | saved directly |
| `never` | dropped |

Two safeguards hold whatever the policy: a proposal in which a secret was redacted always waits for review, and what *you* add is always saved. Evolution's `suggest` mode only ever sends proposals to review.

## Protocol

| command | does |
|---|---|
| `memory.list`, `memory.search` | as before, plus `session` |
| `memory.add` | `scope: "session"` with `sessionId`; `pinned` |
| `memory.update` | `pinned`; `scope` (+ `directory` or `sessionId`) moves it keeping id and links |
| `memory.categories` | `{ categories }`: id, label, description, `defaultPolicy`, `policy` |
| `memory.policy` | sets one category's policy; `{ categories }` |
| `dream.list` | `{ runs }` with `trigger` and (newest five) `report`; `runId` returns one run |
| `evolution.list`, `evolution.resolve` | see [evolution.md](evolution.md) |

Entries carry `pinned` (absent = not pinned) and, for session scope, `sessionId`.

## Memory graph

Saved memories can be linked to each other. The links make a graph that the agent reads with the `memory_graph` tool and that you see in the **Graph** tab.

## Links

| kind | direction | meaning |
|---|---|---|
| `related` | both ways | on the same subject |
| `conflicts` | both ways | cannot both be true; one should be edited or archived |
| `supports` | from → to | the first backs up the second |
| `supersedes` | from → to | the first replaces the second |

- Only **saved** memories can be linked. Pending or archived ones cannot.
- A memory has at most 16 links. A pair has at most one link: linking it again replaces the kind.
- Deleting a memory removes its links. Archiving keeps them, but archived memories are not in the graph.
- The graph follows [profiles](profiles.md). Project memories of the directory and user memories of its profile are nodes; another profile's user memories are not.

## Health

The first row of the Graph tab and the tool's `overview` show the graph's state:

- `empty`: nothing is saved;
- `disconnected`: nothing is linked;
- `partial`: some memories have no links;
- `connected`: every memory has at least one link.

The row also counts isolated memories and conflicts. A conflict turns it red.

## Graph tab

`/memory`, then `5` or `tab` until **Graph**.

| key | does |
|---|---|
| arrows, `hjkl` | move to the nearest memory in that direction |
| `enter`, `f` | switch between the view around the selected memory and the whole graph |
| `m` | mark the selected memory |
| `c` | link the marked memory to the selected one (`related`) |
| `x` | unlink the marked memory from the selected one |
| `1`–`4`, `tab` | other tabs |
| `esc` | back to the chat |

The view shows up to 200 memories, the most linked first. The detail panel lists the selected memory's text and links.

## Agent tool

`memory` exposes `status`, `categories`, `list`, `search`, `context`, `add`, `update`, `delete` and `propose` through the daemon's `memory.model` command. CRUD writes are explicit approved tool calls; proposals follow category policies. `global` is the profile's user scope. Graph `workspace`/`group-view` facts keep that classification in metadata and belong to this project; they do not grant access to other profiles. Both model tools use write permission because their action union can mutate memory; read-only peers cannot invoke `memory.model`.

`memory_graph` exposes `overview`, `search`, `upsert_fact`, `link` and `validate`. Upsert preserves the id and links on edits and explicit scope moves; links default to `related`, with the existing 16-link cap. Validation reports integrity separately from disconnected/isolated health. Tags, multiple category ids, evidence, confidence and sensitivity persist with memories; search includes tags and secondary categories. High-sensitivity entries are excluded from Markdown sharing. Automatic extraction can still run after these tools; normalized duplicates are skipped before writing.

### Memory assistant

Press `t` in Memory to open its assistant. The selected project, tab, category and memory focus its answer; the current project's and profile's memory remain available. Enter asks; PgUp/PgDn scroll, Ctrl+R opens Pending, Ctrl+X cancels, Ctrl+L clears history, and Esc returns to Memory. Ctrl+N sets the chat aside in the archive and starts a new one; Ctrl+O lists archived chats (↑↓ select, Enter restores it and archives the live chat if it has messages, x forgets it, Esc closes). The prompt's main draft is preserved. Compact terminals use one column; larger ones show conversation and Selection/Pending in shared bordered panels. Hints stay in the header.

History lives at `<dataDir>/memory-assistant/<profile-project-hash>.json`, separate from `/btw`, the main event log and engine history. It survives restart; interrupted calls are marked. Questions, context and answers are redacted and bounded. Clear/cancel discard late completions and their actions. Archived chats live in a `.archive` folder beside that file (private files, newest 20 kept per profile and project, same redaction as the live thread); clear still discards without archiving. Commands: `memory.assistant.get/send/clear/cancel/archive` (`archive` takes `action: archive|list|restore|delete` and an `archiveId`); client helpers: `memoryModel`, `memoryAssistant`, `memoryAssistantArchive`. These commands are not available to read-only peers.

The tool-free completion uses the `memoryAssistant` model role, falling back to `memoryExtractor`, `small`, then main. No provider means a visible refusal. Responses can draft pending facts, edits, deletes, scope/category moves, graph facts and links; approval applies supported actions, rejection removes the draft. Control drafts are applied only on your approval, after validation, and stay pending with the reason when they cannot be:

| Action | Fields | Approval does |
|---|---|---|
| `propose-policy` | `categoryID` + `policy` (auto, review, never) and/or `settings` | sets that category's policy; `settings` may carry `memoryUse`, `memoryGenerate`, `memoryMaintenance`, `dreamConsolidationPolicy` only (approval and enable switches are out of reach) |
| `edit-category` | `categoryID`, `policy` | same category policy change |
| `delete-category` | `categoryID` | resets the category to its built-in policy |
| `dream-service-start` | `dreamAt` (`HH:MM`, or the first time in the text) | sets the daily Dream time, which arms the integrated schedule |
| `dream-dry-run` | none | starts one Dream pass in `preview`: everything it proposes waits in Pending, nothing is applied or consolidated |
| `create-category` | none | refused when drafted: v2 keeps its fixed category list (decision: custom categories would change what Dream, policies and retrieval know about categories; not done without a user decision) |

Dream windows (start and end) are not modelled: v2 runs once a day at one time. Live-provider verification requires a configured external service; tests use a fake completion.


## Workspaces and Markdown sharing

`w` opens the project browser from any memory tab (outside text editing). ↑↓ selects Current project, User memories, All projects or a recorded project; Enter loads it and Esc cancels. Projects come from v2's persisted sessions and memories, with origin, parent group, profile, status counts and manual/agent counts. No filesystem discovery or v1 data reads occur. All projects merges memory lists and graph nodes within the active profile; user memories appear once. Project selection also scopes Dream and Evolution without changing the chat session. Reports show omitted entries when the 200-entry limit is reached.

Sharing (`9`) uses `s` for project/user scope, `e` to enable, `d` to disable, `o` to export and `i` to import; ↑↓/PgUp/PgDn scroll results. Enabling requires typing `ENABLE PROJECT` or `ENABLE USER` in the page. Errors, skipped ids and conflict reasons stay in the result panel. Imported changes appear as update diffs in Pending; `a` approves and `x` rejects.

The daemon writes bounded private snapshots and an index under `<dataDir>/memory-sharing/<scope>-<identity>/`. Sharing is off by default for each project/profile. Only saved non-session entries without detected secrets or redaction markers are exported; security-category and high-sensitivity entries are excluded. Files are capped at 32 KiB, the inventory at 200. Disable and file deletion keep internal memories and exported files intact. External edits to a snapshot or index are never silently overwritten.

The metadata header identifies the v2 origin and exact internal revision. Import validates it and creates a durable, deduplicated manual-review proposal; category auto policies never bypass approval. Approval compares the original revision again and rejects stale edits, preserving ids, pins and graph links. Symlinks, non-regular/oversized files, malformed metadata, changed origins and secrets are refused visibly. Accepted edits can be re-exported to refresh their revision.

Commands: `memory.workspaces`, `memory.browse` (`project | user | all`), `memory.sharing.status/configure/export/import`. Only workspaces, browse and sharing status are read-only. Typed client helpers: `memoryWorkspaces`, `browseMemory`, `sharingStatus`.

These snapshots use the explicit `mendcode-v2` format (header version 2) and v2 revisions; v2 never writes into a v1 sharing
folder. To bring v1's memories over, point `mendcode memory import-v1 --from <v1 sharing folder>` at a folder v1's sharing
export wrote (one `<id>.md` per memory, header `<!-- mendcode-memory {"version":1,…} -->`). Without `--apply` it only lists
what it found; with it each memory becomes a pending proposal tagged `v1-import` (v1 `global` → user, `project` → the
current project), for you to approve in Pending like any other. No model reads them (each file is one memory already). A
file that is a link, not a regular file, over 32 KB, without a valid v1 header, with a detected credential, or whose text
is already in memory (any status, case and spacing ignored) is skipped with that reason; at most 50 per run
(`--max-proposals`). v1's folder is only read, never named implicitly.
## Memory consent and notices

Memory consent and management are available in every tier. In default approval mode, an explicit current request such as “me llamo Nora recuerda eso” or “my name is Nora, remember that” authorizes one matching fact. Ambiguous paraphrases still ask. Consent never extends to later turns, another fact, a sub-agent, expanded context or a synthetic notice; deny rules and plan mode still apply.

Model-initiated writes use a **Save to memory?** card with plain fact text and muted scope/category chips: Save, Save and don't ask for memory again, Edit text, Reject. `Require approval` applies to memory even in full-access mode. The second option turns off `memoryRequireApproval` for future memory writes only. Editing saves the edited text directly. Read operations do not ask for write approval. Approved native `remember` and `memory propose` writes save directly rather than creating a second Pending review; after-turn extraction retains its independent review policy.

### What a memory write says

Every write says what it wrote, never just "Memory saved":

- **Transcript.** One muted row per write: `Memory  saved · project · "<first 60 characters>…"`, or `updated` or `removed`. A save's row ends with a muted `/memory undo` hint at its right edge (the text is cut, the hint stays whole). Click it (or `ctrl+o`) to open the whole text. Rows for extractor saves read the same. When the write belongs to the session on screen, this row is the notice and no toast is shown.
- **Toast.** Only when the write is not visible in the current transcript (an extractor or Dream save for another session, or a page open). The daemon's `memory.changed` event carries `scope`, `status` and `text` (flattened, 200 characters), so the toast is one line: `Memory saved · project · "<first 60 characters>…" · /memory undo`. `Memory updated` and `Memory removed` carry the same detail. If the transcript row for the same write arrives while the toast is up, the toast gives way to it. A proposal that waits for review, a link, an archived memory or an event from an older daemon shows no toast.
- **Undo.** `/memory undo` deletes the newest memory this session saved (its row names it); run again, it reaches the one before. Edits and removals are not undone; `/memory` lists, edits and deletes anything.

A short toast is one line laid over the prompt's top rule (the transcript gives no row up; the minimal view, without a rule, shows it as a row above the prompt), and the `/memory undo` hint is kept whole there. This holds for every short toast (draft saved, copied, release notices), never a multi-row box. A boxed toast is only for a message that needs more than one line (an error with detail): in the chat it goes top-right, below the top bar and the pinned prompt, in the first place where every cell under it (and one around it) is empty, and with no such place it falls back to the notice row. Pages without a transcript keep the top-right box. Every toast uses the same path.

### What the model is told to save

The `remember`, `memory` and `memory_graph` descriptions say to save only durable facts and standing preferences the user stated (remember, always, from now on, I prefer), corrections that apply to later work and project facts the repo does not show; never secrets, this request's content or format, or task status; and when unsure, not to. The after-turn extractor prompt (`packages/daemon/prompts/memory-extract.md`) carries the same criteria and says a one-off request is not a preference. These are prompt-only. There is no separate "memory section" in the system prompt: the descriptions are the guidance.

Enforced in code: with `memoryRequireApproval` off (the "don't ask again" answer), a model save whose text restates the current user message (at least half of its distinctive words, and three of them, already in the message, and no standing marker such as remember, always, from now on, siempre, recuerda in it) is not saved silently. It shows the usual **Save to memory?** card with `Restates this request`. The same check sends an extractor fact to Pending. An explicit "remember X" in the message keeps its immediate, dialog-free save. A paraphrase with less overlap, or in another language, is not caught.

Duplicate writes do not announce success. After-turn extraction deduplicates case, Unicode normalization and whitespace against visible retained facts, even when the model used a memory tool; unrelated extracted facts remain eligible.

Extraction separates memory enablement, after-turn generation, extractor configuration, queued/running count, last executed job and last error. **Maintenance: disabled** refers only to duplicate maintenance. Saved supports `e` to edit (Enter saves, Esc cancels) and `d` then `d`/`y` to delete; another key cancels deletion. Memory commands, approval edits and persistent consent changes are local-only and cannot resolve an unrelated request. Remote turns exclude native memory tools; memory commands are absent from the read-only peer allowlist.
