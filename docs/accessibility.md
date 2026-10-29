# Accessibility and screen-reader mode

Screen-reader mode makes the terminal easy to follow with a screen reader or a braille display: linear output, nothing that moves, plain text.

Turn it on with any of:

- `/accessible on` (also `off` and `toggle`), or `/customize` > Terminal > Screen reader. Saved in the terminal profile.
- `mendcode --accessible` for one run.
- `MENDCODE_ACCESSIBLE=1` for every run of that shell (`MENDCODE_ACCESSIBLE=0` turns a saved setting off for that run).

There is no automatic detection: a terminal gives no reliable sign that a screen reader is running, so the mode is always asked for.

## What it does

| | |
|---|---|
| Inline screen | The chat stays in the terminal's own scrollback instead of the alternate screen, so finished output is written once, in order, and never repainted. Pages (`/help`, `/customize`, ...) still borrow the alternate screen while they are open. `--alt-screen` overrides it. |
| No mouse reporting | The terminal keeps its own selection and cursor review. |
| No animation | Reduced motion is forced on: no spinner frames, topbar or pet motion, a static intro. The pet is not shown. The working row drops its live elapsed clock; the phase word (thinking, running a tool, waiting for approval) stays. |
| Plain text | The presentation becomes `raw` (plain message rendering, reasoning expanded), the same look `/raw` gives. |
| Questions | The question card marks the highlighted answer with `>` and puts the terminal cursor on its row (in its text field while you type your own answer), so cursor review reads the answer in focus. Ticks are `[x]`. |

The inline screen and mouse change apply at the next launch; motion and the plain look apply at once. `/accessible off` puts the normal look back (`presentation auto`, full message rendering, reasoning auto) and the screen and mouse follow at the next launch. A run started with `--accessible` or the environment variable does not write its plain look into the saved profile.

The terminal bell and desktop notice (`/customize` > Terminal) are independent and useful here: they say when a turn ends or waits for an approval.

Other aids that are always on: the keyboard reaches every page, `Alt+Enter` or `Ctrl+J` insert a newline in any terminal, and `/doctor` lists what the terminal supports.

The first-run screen and `/tutorial` have a linear version in this mode. The first-run screen lists what was found, the model, tier and permission rows with the value of each and its one-line preview note, and the keys, as plain lines with no side-by-side panels. The tutorial opens each lesson as sentences (`Lesson 3 of 13: Attach a file with @.`, why, what to do, `Done:` / `To do:` for each step, the keys), then the practice chat below, and says that the practice chat is not real. Both use the same lessons and the same keys as the visual version; nothing is only drawn.
