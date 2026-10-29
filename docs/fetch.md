# `/fetch`

A neofetch-style card of the project and MendCode. Instant and offline: it reads a few local files and state the terminal client already holds, and sends nothing to the daemon.

```
  fetch                                                                esc

                       project    MendCodeV2
  ███▄        ▄███     branch     main
  ██▀██▄    ▄██▀██     languages  TypeScript 98% · Python 1% · Shell 1%
  ██  ▀██▄▄██▀  ██     sessions   14
  ██    ▀██▀    ██     model      gpt-5.6 · high
  ██     ▀▀     ██     usage      123K tokens · 12 calls · $1.23
  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌   pet        Dot
    m e n d c o d e    version    0.4.0
                       terminal   110x32
```

The card floats over the transcript above the prompt, the same way `/btw` does. `esc` closes it; typing goes on in the prompt underneath.

## Rows

A row is left out when its fact is not known.

| Row | Source |
| --- | --- |
| project | basename of the working directory |
| branch | `.git/HEAD`, found by walking up from the working directory (a worktree's `.git` file is followed). Detached HEAD shows the 7-character sha; no repository shows `no git` |
| languages | top 4 by file count, as a share of recognised source files. A `~` prefix means the scan stopped at its cap, so the shares are estimates |
| sessions | sessions the app has already listed (from `/sessions` or the palette) |
| model | the model and effort the next answer uses |
| usage | today's tokens, calls and cost, from the daemon's `usage.today` push |
| pet | the chosen pet's name |
| version | the CLI version |
| terminal | current size in columns x rows |

## Language scan

Bounded so it never stalls the UI: at most 5,000 files and 40 ms, breadth first (shallow files first). `node_modules`, `.git`, `dist`, `build` and `graft` are skipped. Data and prose files (json, yaml, toml, md) are counted as files seen but are not languages.

## Narrow terminals

The logo needs room next to the rows. When the card is too narrow for both, the logo is dropped and only the rows show. Below 34 columns, or with fewer than 5 rows above the prompt, no card is shown.

## Code

- `apps/cli/src/view/fetch-info.ts`: branch and language gathering; the file system and clock are injected.
- `apps/cli/src/view/fetch-card.ts`: the logo, rows and card layout (the `/btw` card's shape).
- `apps/cli/test/fetch.test.ts`: temp-dir tests for the gathering, card widths and the open/close flow.
