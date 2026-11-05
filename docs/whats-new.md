# What's new for you

Every MendCode version lists its changes in [CHANGELOG.md](../CHANGELOG.md). Three places read it, all from the same parser
and the same one-line highlights (`packages/protocol/src/changelog.ts`, also used by `scripts/release-notes.ts`):

| Where | What it shows | Model call | Tier |
|---|---|---|---|
| The GitHub release page (beta, stable, the Nightly) | the notes, then a prompt to copy into any session | none | every tier |
| `/changelog` | each version's highlights, what is new since your last look marked, the same prompt at the end | none | balanced, full (no tier: listed) |
| `/whatsnew` | the changes since your last look, and the ones that fit what you do, each with an action | one | balanced, full (`whats_new`) |
| `/whatsnew all` | every change of the bundled changelog, searchable | none | balanced, full (`whats_new`) |

The changelog is packed into the build: nothing is fetched to show it. Minimalist has no `/whatsnew`; the prompt on the release
page is its way to the same answer.

## The copyable prompt

The last block of every release page, and of `/changelog`, is a short request in English to paste into any MendCode session:

```text
MendCode v0.0.3 is installed. The changes are on https://github.com/MendCode/MendCode/releases/tag/v0.0.3.
From my memories, my past sessions and my MendCode settings, tell me which of these changes I should use, know about or configure, given what I usually do.
Read only: do not change any setting unless I ask. Be brief.
Answer in my language.
```

The session answers in your language and changes nothing unless you ask it to afterwards (a settings change still goes through
`mendcode_settings`, which shows it and waits for your Apply). The release notes add the block themselves, so CHANGELOG.md
carries no copy of it per version.

## `/whatsnew`

Bare, it opens a page with two parts:

- **For you**: at most five picks from one model call, each one line on the change and why it fits you. While the call runs the
  page shows the model and the estimated tokens; when it ends, the tokens the provider counted (input and output) and the cost
  when it is known. The call is counted in `/usage` under the `whatsNew` role.
- **The changes since your last look**, grouped by version (`Unreleased · in <build>` for a nightly or local build). With nothing
  new, or on a first look, it takes the newest section. The call carries one line per change, at most 80 lines; the page says
  how many more were left out.

The call runs on the `aside` role when one is set (`/model roles`), else on the session's model, on the native engine.
`/whatsnew all` lists every change of every version and calls nothing.

### Actions

A pick can carry one action. Enter on it shows the action; a second Enter does it; Esc leaves everything as it is.

- **A settings change**: shown as `key: before → after`, validated first the way `mendcode_settings propose` validates one. Enter
  saves it with `settings.set`, so every terminal gets it. A change that is not valid, would change nothing, or touches spend
  limits (`budgets`) loses its action and keeps its text.
- **A command to try**: Enter puts it in the prompt. It does not run until you press Enter there.

### Keys

The page standard ([pages](layout.md#pages-one-set-of-keys)): `/` filters picks and changes, `↑` `↓` move, Enter previews a pick
or opens a change in full, `g` `G` go to the ends, Esc clears the box first and then goes back.

## What is read and where it goes

`/whatsnew` reads, on this machine only: the project's saved memories (none when memory is off for the project), the settings in
effect with secrets hidden (as `mendcode_settings get` shows them) and the titles of the project's recent sessions. Those, the
copyable prompt and the list of changes go to the provider of the model the call runs on, and nowhere else. Nothing is stored.
A remote terminal cannot ask (`/whatsnew all` still works there).

## New since your last look

The terminal keeps `<data dir>/tui/changelog-seen`: the newest version it showed and short ids of the `Unreleased` items it
showed (a nightly's changes have no version of their own). `/changelog` and `/whatsnew` both update it. The notice
`Updated to the new build`, shown once after a restart into a new build, names `/whatsnew` where the tier has it.

## Turning it off

`/tier whats_new off` (or `features.whats_new: false`) removes `/whatsnew` and its mention. Without a tier it is on, as the other
features that existed before tiers.
