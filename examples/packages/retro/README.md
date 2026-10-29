# Retro

A full reskin of MendCode in phosphor amber, as one package. It is the reference for `docs/packages.md`: every file below changes
one thing, and enabling the package applies them together as an overlay. Disabling or removing it puts everything back; nothing is
written into your settings.

```sh
mendcode package check examples/packages/retro
mendcode package install examples/packages/retro
```

`/packages` then shows what it overrides (`o`), turns it off (`d`) and lets you keep one of your own settings (`k`).

| File | What it changes |
|---|---|
| `mendcode-package.json` | `activate`: the theme, the profile keys, the keybindings file and which modules draw which view |
| `themes/retro.json` | the color theme |
| `extensions/message-assistant.ts` | assistant messages: a rail and a `[ASSISTANT]` tag |
| `extensions/tool-card.ts` | tool calls as line-printer entries, foldable by clicking the tag |
| `activate.tuiProfile` | home screen (split layout, wordmark, tagline), prompt box, density, a columns slash menu with `/retro-crt` pinned, and the cards of a two-card right panel (it opens with `alt+g`; a narrow terminal keeps its transcript) |
| `commands/retro-crt.md` | the `/retro-crt` command |
| `skills/retro-style/SKILL.md` | a skill for terse answers |
| `keybindings.json` | `alt+g` shows or hides the right panel, `alt+m` opens the message list |
| `workflows/retro-review.js` | a script workflow: `/workflows run retro-review` |

## What it cannot change

The engine and provider transport, permission and trust state, the prompt editor, the dock and the live compaction panel, and
page bodies as typed data. Its two view modules are code: they run in the terminal with your permissions, so read them before
you enable the package (they are short).
