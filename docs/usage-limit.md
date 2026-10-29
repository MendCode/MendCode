# Usage-limit pause and resume

Balanced/full `limit_checkpoint` writes a bounded, redacted portable compaction checkpoint beside native history at 90% usage, or when the last measured quota increase projects exhaustion on the next call. Samples and per-window guards survive daemon restart. Each window is handled once, independently; a fresh installed checkpoint is reused. A quota refresh can save persisted work during a turn. Live context and the full history are never replaced, and no model call is made. Reset continuation uses the complete history; focused handoff can use the checkpoint summary. External engines retain their own continuity. Only known subscription windows with a future reset qualify; API-key, credit, stale and unknown quota readings are excluded, as are remote-restricted sessions. Disable with `/tier limit_checkpoint off` or **Pre-limit checkpoint** in `/customize`. A saved checkpoint adds one muted transcript line. Checkpoints and their tracking state are deleted with the session.

Automatic resume asks again if the paused model changed or is no longer available. Peer clients cannot schedule or resume
a host turn. Native peer tool exclusions survive automatic continuation and restart. Turning off `usage_resume` still
affects new pauses; use Cancel to disarm an existing schedule.

When a provider or subscription limit stops a turn mid-work, the turn is **paused**, not lost. The transcript says when the window resets and, if the reset time is known, the daemon **arms the resume by itself**: at the reset it continues the same conversation, even across a daemon restart. You can cancel or snooze it; nothing is ever sent without the safeguards below.

## What you see

- **Notice** (balanced, full) in the transcript where the turn stopped: `Usage limit reached`, the provider, `resets 2:10 AM (in 3h 12m)` and the provider's own words. The turn's end line says `paused · usage limit` instead of an error box.
- **Minimal view** (the minimalist tier): no card and no bar, one muted line above the prompt: `limit reached · resumes 2:10 AM · esc cancel`. `esc` cancels the armed resume (with an empty prompt and no turn running); the line then reads `limit reached · resets 2:10 AM · /limit resume`.
- **Bar** (balanced, full) above the prompt while the pause is open:

| State | Bar says | Chips |
|---|---|---|
| `scheduled` (armed, the default) | `resume at reset (armed) · 2:10 AM (in 3h 12m)` | `RESUME NOW` · `CANCEL` · `SNOOZE` |
| `paused` (no reset time, cancelled, or a safeguard asked) | `claude usage limit reached · resets 2:10 AM (in 3h 12m)` | `RESUME AT RESET` · `SNOOZE UNTIL RESET` |
| `ready` (window reset, waiting for you) | `limit reset · ready to continue` | `RESUME` · `DISMISS` |
| `snoozed` | hidden until the reset, then `ready` | |

When the provider gave no reset time the chips are `RESUME NOW` and `DISMISS`, and nothing is armed (a time is never guessed).

- **Right bar**: the `usage` card starts with `Limited · resets 2:10 AM (in 3h 12m)` (`Limited · reset unknown` without a time) while the pause is open, even snoozed; the `agent` card's State row says `Limited · resets 2:10 AM`. Both go away when the turn resumes.
- **Cancel** disarms the resume (back to `paused`); **Resume at reset** arms it again. **Snooze** disarms it and hides the bar; at the reset it comes back as `ready`. Nothing continues by itself from `paused`, `snoozed` or `ready`.
- Typing a new message forgets the pause (you moved on). Daemon-written notices and steerings do not.

Keys and commands: click a chip, press `ctrl+s` (the first chip, when nothing is queued), `esc` (minimal view, armed), or `/limit` (status), `/limit resume` (at reset), `/limit cancel`, `/limit now`, `/limit snooze`, `/limit dismiss`.

## Safeguards (Decision D1)

At the reset the daemon resumes only when all of these hold; otherwise the pause becomes `ready` (it asks) and says why in the daemon log:

- **Only that turn, once.** Before dispatch the pause is durably marked `ready`; concurrent wakes/clicks cannot send again. The row is deleted and `resumed` emitted only after the actor acknowledges launch or queueing (not completion). A restart during an ambiguous dispatch preserves `ready` and asks for Resume, never silently retries. A resumed turn that hits another window waits for that reset too, at most three times in a row, then it asks.
- **The reset is re-checked.** A quota observation is usable for 15 minutes, only for the known provider; another provider's quota is never a fallback. A fresh window still reported spent (say the weekly one) re-arms for its own later reset. Without a usable observation, only the provider's explicit reset can arm a continuation; no time is guessed.
- **You did not move on.** An unsent draft written after the pause, or a different effective model (switched with `/model`, or changed by settings), makes it ask. Switching the model while armed asks at once (`paused`). So it never silently continues into another provider, such as a pay-per-token one.
- **Survives a restart.** The pause is a stored row; on start the daemon re-arms every one, and an armed pause whose reset passed while it was down goes through the same checks at boot.

Resuming spends quota. The one switch is the `usage_resume` feature of the tier manifest ([tiers](tiers.md)): minimalist tier, on in every tier and with no tier; `/tier usage_resume off` stops new pauses from arming (you can still pick Resume at reset). A pause already armed is not touched by the switch: use Cancel.

## Where the reset time comes from

1. The failure message: `resets_at` / `resets_in_seconds` (Codex/OpenAI bodies), a trailing `|<epoch>` (Claude), `resets 2:10 AM (America/Panama)` / `resets Oct 9, 9am` (Claude Code; the zone in parentheses, else the daemon's own), `try again in 3h 20m`.
2. Else the quota snapshots the daemon already tracks (Claude 5h/7d windows, Codex primary/secondary, ChatGPT): the provider's window at 100%, the latest one when several are spent.
3. Else unknown. A time in the past or more than 31 days away is ignored.

A failure counts as a usage limit by the same rule goals use (`isUsageLimitFailure`): the quota 429 of the native engine and the wording Claude Code and Codex use. A plain rate-limit hiccup is retried by the engine and never pauses. Failures of child tasks (subagents) do not pause; their parent receives the task result.

## Resuming

The resume continues the session's own history as a steering turn that tells the agent the limit reset and to carry on from where it stopped. A session whose goal is `usage_limited` resumes through the goal ([goals](goals.md)). No provider is called for it beyond the normal turn.

## Quota refresh

A provider's quota windows are known only when a turn on that provider ran, so on a session that uses another provider they age. `quotaRefresh` (profile key, `/customize` > Prompt & footer > Quota refresh, or `customize_ui` settings) lists the providers whose windows the daemon asks for on a timer: `[{"provider":"codex","everyMinutes":15,"model":"..."}]`, each provider once, `everyMinutes` 5 to 1440 (default 15), `model` optional (the cheapest model of the catalogue by name, Haiku for Claude Code). In `/customize` it is one line, `codex:15, claude:30:claude-haiku`. **It is off by default, and nothing is sent until you list a provider.**

**It costs quota.** Every probe is a real request on your login, so it spends some of the quota it measures (the Codex engine's probe only reads its rate limits and costs none). How much is not measured here: it depends on the provider and your plan. The setting row, the `usage` card and `mendcode docs usage` say so; ask before turning it on for someone else.

What a probe is, per provider:

| Provider and engine | The probe | What it sends |
|---|---|---|
| `codex`, native engine, ChatGPT login | one Responses request through the same provider a turn uses; the `x-codex-*` response headers carry the 5h and weekly windows | system `Reply with one word.`, user `.`, no tools, no cache key, `max_output_tokens` 16 (the adapter's floor): a few tokens in, at most 16 out |
| `codex`, Codex engine | `account/rateLimits/read` on a throwaway `codex app-server` | no model call; nothing is spent |
| `claude` (Claude Code) | one throwaway `claude` process in its own empty folder (`<data dir>/quota-probe/`, never a project), `--tools ""`, `--no-session-persistence`, your Claude Code hooks off (`disableAllHooks`, so a hook that notifies you when a turn ends stays quiet), one user message `.`; its `rate_limit_event` carries the windows | one minimal Claude Code turn on Haiku by default: Claude Code's own system prompt and tool definitions (and your global `~/.claude` instructions) plus one word. Not "one word in"; not measured here |

A probe is not a session: it is not stored, not shown in any transcript and not counted in a session's usage. It uses the credentials MendCode already uses (its ChatGPT login, the `codex` or `claude` you already run); it never reads `~/.codex`, `~/.claude` or `~/.pi`. API-key providers report no windows and are not probed.

When it runs (one schedule in the daemon for every client):

- only while at least one terminal or client is connected, so an idle daemon with nobody looking sends nothing;
- the first probe lands up to 30 seconds after the first look, then every interval within ±10% (jitter);
- skipped when a real turn (or an earlier probe) gave a reading fresher than the interval;
- never while the provider is at a usage limit (a spent window that has not reset): the pause above owns the wait;
- after a failure the next probe waits two intervals, then four, up to six hours; after 3 failures in a row the provider stops with a one-line toast (`quota refresh for claude stopped after 3 failed probes (...)`) and stays stopped until you edit the entry. A failed probe never touches a session.

Who may turn it on (the `permit` pattern of [`pr_watch`](pr-watch.md)): the `quota_refresh` feature of the tier manifest ([tiers](tiers.md)) is a permit in every tier, so a tier never turns it on; only your own `quotaRefresh` entries do. `--safe-mode` turns it off. A remote peer, read-only or full access, cannot add providers with `tui.change` (it can still remove them), and the model needs your approval of the `customize_ui` call. `/tier quota_refresh off` disables it without touching the list.

`mendcode docs usage` shows, per provider, `refresh: off, nothing is sent` or the interval, the state (running, waiting, stopped), the last probe and the probes of today; a running daemon reports the same list in `daemon.info`.

## Protocol and storage

- Event `usage.limit` (session-scoped, daemon-written): `state` (`paused` · `scheduled` · `snoozed` · `ready` · `resumed` · `cleared`), `provider?`, `message` (redacted, 500 chars), `resetsAt?` (ms), `by` (`system` · `user`), `turnId?`. Every event carries the whole pause; a client shows the bar for the last event while its state is open. The failed turn still ends with `turn.failed`, so other consumers (goals, channels, REST) are unchanged.
- Command `usage.limit` `{ sessionId, action: schedule | cancel | snooze | resume | dismiss }`. Ack `{ state, resetsAt? }`; `target_mismatch` without an open pause, `unsupported` for `schedule` without a reset time, `busy` when the session could not start the turn (it stays `ready`). `cancel` on a pause that is not armed changes nothing. It changes state, so it is not in `READ_ONLY_COMMANDS`: a read-only peer is refused.
- The open pause is a row in the store (`usage_pauses`, one per session, removed with the session; `model` is the effective model when the turn stopped, added to older databases on open).

## Decisions

- D1: auto-resume is armed by default in every tier when the reset is known, with the safeguards above. No reset time means no automatic action.
- The minimal view shows one muted line and no bar; the bar tiers keep Resume (armed), Cancel and Snooze.
- A resume spends quota only at the reset, never into another model or over a draft you typed.
