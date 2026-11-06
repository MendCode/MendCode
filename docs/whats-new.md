# What's new for you

Use the release notes, `/changelog` or `/whatsnew` to find changes you can use or configure. Every MendCode version lists its changes in [CHANGELOG.md](../CHANGELOG.md).

Choose where to read them:

| Where | What it shows | Model call | Tier |
|---|---|---|---|
| The GitHub release page (beta, stable, the Nightly) | the notes, then a prompt to copy into any session | none | every tier |
| `/changelog` | each version's highlights, what is new since your last look marked, the same prompt at the end | none | balanced, full (no tier: listed) |
| `/whatsnew` | the changes since your last look, and the ones that fit what you do, each with an action | one | balanced, full (`whats_new`) |
| `/whatsnew all` | every change of the bundled changelog, searchable | none | balanced, full (`whats_new`) |

The changelog is packed into the build: nothing is fetched to show it.

Minimalist has no `/whatsnew`; use the prompt on the release page to get the same answer.

## The copyable prompt

1. Find the short English request right under Install on a release page, before the folded details, or at the end of `/changelog`.
2. Copy it into any MendCode session. On a release page it also updates an older build first, with that channel's command:

```text
MendCode v0.0.3 is out. The changes are on https://github.com/MendCode/MendCode/releases/tag/v0.0.3.
If the MendCode I run is older (`mendcode --version`), update it first with `mendcode upgrade --channel stable`.
From my memories, my past sessions and my MendCode settings, tell me which of these changes I should use, know about or configure, given what I usually do.
Read only: do not change any setting unless I ask. Be brief.
Answer in my language.
```

The session answers in your language and changes nothing unless you ask it to afterwards. A settings change still goes through `mendcode_settings`, which shows it and waits for your Apply.

The release notes add the block themselves, so CHANGELOG.md carries no copy of it per version.

## `/whatsnew`

Run `/whatsnew` without arguments to open a page with two parts:

| Part | What you see |
|---|---|
| **For you** | At most five picks from one model call, each one line on the change and why it fits you. |
| **The changes since your last look** | Changes grouped by version (`Unreleased · in <build>` for a nightly or local build). With nothing new, or on a first look, it takes the newest section. |

The call carries one line per change, at most 80 lines; the page says how many more were left out.

While the call runs, the page shows the model and estimated tokens. When it ends, it shows the tokens the provider counted (input and output) and the cost when known.

The call is counted in `/usage` under the `whatsNew` role. It runs on the `aside` role when one is set (`/model roles`), else on the session's model, on the native engine.

Use `/whatsnew all` to list every change of every version without a model call.

### Actions

A pick can carry one action:

1. Press Enter on the pick to see its action.
2. Press Enter again to do it, or Esc to leave everything as it is.

| Action | What confirmation does |
|---|---|
| **A settings change** | Shows `key: before → after`, validated first the way `mendcode_settings propose` validates one. Enter saves it with `settings.set`, so every terminal gets it. |
| **A command to try** | Enter puts it in the prompt. It does not run until you press Enter there. |

A settings change that is not valid, would change nothing, or touches spend limits (`budgets`) loses its action and keeps its text.

### Keys

The page follows the standard [pages](layout.md#pages-one-set-of-keys) keys:

| Key | Does |
|---|---|
| `/` | Filter picks and changes. |
| `↑`, `↓` | Move. |
| Enter | Preview a pick or open a change in full. |
| `g`, `G` | Go to the ends. |
| Esc | Clear the box first, then go back. |

## What is read and where it goes

`/whatsnew` reads these sources on this machine only:

| Source | What is read |
|---|---|
| Project memory | The project's saved memories; none when memory is off for the project. |
| Settings | The settings in effect with secrets hidden, as `mendcode_settings get` shows them. |
| Recent sessions | The titles of the project's recent sessions. |

Those sources, the copyable prompt and the list of changes go to the provider of the model the call runs on, and nowhere else. Nothing is stored.

A remote terminal cannot ask; `/whatsnew all` still works there.

## New since your last look

The terminal keeps `<data dir>/tui/changelog-seen`: the newest version it showed and short ids of the `Unreleased` items it showed. A nightly's changes have no version of their own.

Both `/changelog` and `/whatsnew` update it. The notice `Updated to the new build`, shown once after a restart into a new build, names `/whatsnew` where the tier has it.

## Turning it off

Use `/tier whats_new off` (or `features.whats_new: false`) to remove `/whatsnew` and its mention.

Without a tier it is on, as the other features that existed before tiers.

## How it works

The three places use the same parser and the same one-line highlights: `packages/protocol/src/changelog.ts`, also used by `scripts/release-notes.ts`.
