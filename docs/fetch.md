Use `/fetch` to see a neofetch-style card of your project and MendCode. It is instant and offline: it reads a few local files and state the terminal client already holds, and sends nothing to the daemon.

## `/fetch`

1. Run `/fetch`. The card floats over the transcript above the prompt, the same way `/btw` does.
2. Keep typing in the prompt underneath, or press `esc` to close the card.

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

The scan is bounded so it never stalls the UI. It visits files breadth first (shallow files first).

| Limit or file type | Scan behavior |
| --- | --- |
| Files and time | At most 5,000 files and 40 ms |
| Skipped directories | `node_modules`, `.git`, `dist`, `build` and `graft` |
| Data and prose files (json, yaml, toml, md) | Counted as files seen, but not as languages |

## Narrow terminals

The logo needs room next to the rows. What you see depends on the available space:

| Available space | What appears |
| --- | --- |
| Room for the logo and rows | Both appear |
| Card too narrow for both | Only the rows; the logo is dropped |
| Below 34 columns, or fewer than 5 rows above the prompt | No card |

## Code

| File | Holds |
| --- | --- |
| `apps/cli/src/view/fetch-info.ts` | Branch and language gathering; the file system and clock are injected |
| `apps/cli/src/view/fetch-card.ts` | The logo, rows and card layout (the `/btw` card's shape) |
| `apps/cli/test/fetch.test.ts` | Temp-dir tests for the gathering, card widths and the open/close flow |
