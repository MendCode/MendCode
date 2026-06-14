Last release: v0.1.7
Target ref: v0.1.8

## Usage Insights
### Bugfixes
- Show a real Usage Insights loading state instead of zeroed metrics while cached stats are still loading.
- Reuse the global TUI stats cache on the Usage Insights page without warming session messages during normal chat startup.
- Keep the weather location in the global TUI config and simplify the stats shortcuts by removing the manual refresh action.

## Installer
### Bugfixes
- Fix the installer version check so a same-version global `mendcode` on `PATH` cannot falsely satisfy a clean `$HOME/.mendcode/bin` install.
