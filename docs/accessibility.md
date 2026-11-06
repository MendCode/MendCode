# Accessibility and screen-reader mode

Screen-reader mode makes the terminal easy to follow with a screen reader or a braille display: linear output, nothing that moves, plain text.

## Turn on screen-reader mode

Choose how long you want the mode to apply:

| Use | Does |
|---|---|
| `/accessible on`, or `/customize` > Advanced > Screen reader | Turns the mode on and saves it in the terminal settings. The command also accepts `off` and `toggle`. |
| `mendcode --accessible` | Turns the mode on for one run. |
| `MENDCODE_ACCESSIBLE=1` | Turns the mode on for every run of that shell. |
| `MENDCODE_ACCESSIBLE=0` | Turns a saved setting off for that run. |

There is no automatic detection: a terminal gives no reliable sign that a screen reader is running, so you always turn the mode on explicitly.

## What it does

| Change | What you get |
|---|---|
| Inline screen | The chat stays in the terminal's own scrollback instead of the alternate screen, so finished output is written once, in order, and never repainted. Pages (`/help`, `/customize`, ...) still borrow the alternate screen while they are open. `--alt-screen` overrides it. |
| No mouse reporting | The terminal keeps its own selection and cursor review. |
| No animation | Reduced motion is forced on: no spinner frames, topbar or pet motion, a static intro. The pet is not shown. The working row drops its live elapsed clock; the phase word (thinking, running a tool, waiting for approval) stays. |
| Plain text | The presentation becomes `raw` (plain message rendering, reasoning expanded), the same look `/raw` gives. |
| Questions | The question card marks the highlighted answer with `>` and puts the terminal cursor on its row (in its text field while you type your own answer), so cursor review reads the answer in focus. Ticks are `[x]`. |

### When changes apply

| Change | When it applies |
|---|---|
| Inline screen and mouse reporting | At the next launch. |
| Motion and the plain look | At once. |
| `/accessible off` | Puts the normal look back (`presentation auto`, full message rendering, reasoning auto); the screen and mouse follow at the next launch. |

A run started with `--accessible` or the environment variable does not write its plain look into the saved profile.

## Notifications and keyboard aids

The terminal bell and desktop notice (`/customize` > Terminal) are independent and useful here: they say when a turn ends or waits for an approval.

These other aids are always on:

| Aid | Does |
|---|---|
| Keyboard navigation | Reaches every page. |
| `Alt+Enter` or `Ctrl+J` | Inserts a newline in any terminal. |
| `/doctor` | Lists what the terminal supports. |

## First-run screen and tutorial

The first-run screen and `/tutorial` have a linear version in this mode. Both use the same lessons and the same keys as the visual version; nothing is only drawn.

### First-run screen

The first-run screen uses plain lines with no side-by-side panels. It lists:

- What was found.
- The model, tier and permission rows, with the value of each and its one-line preview note.
- The keys.

### Tutorial

The tutorial opens each lesson as sentences, then puts the practice chat below. It says that the practice chat is not real.

Each lesson gives you:

- The lesson title, such as `Lesson 3 of 13: Attach a file with @.`.
- Why and what to do.
- `Done:` / `To do:` for each step.
- The keys.
