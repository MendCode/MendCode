# Contributing

Thanks for helping. MendCode is maintained by a small team, so a focused change with real evidence is the one that lands.

## Before you start

- **Bugs:** open an [issue](https://github.com/MendCode/MendCode/issues/new/choose) with the version (`mendcode --version`), the
  platform, what you expected, what happened, and the smallest steps that show it.
- **Features and behavior changes:** open an issue describing the problem first and wait for a maintainer to agree on the
  direction. A pull request for a feature nobody agreed on may be closed without review.
- **Small, obvious fixes** (a typo, a crash with a clear cause, a wrong message) can go straight to a pull request.
- **Security problems:** never in a public issue; see [SECURITY.md](SECURITY.md).

## Set up

You need Bun 1.3.13 and pnpm 11.17.0.

```sh
pnpm install --frozen-lockfile --config.minimumReleaseAge=10080
bun apps/cli/src/entry.ts --dir "$(mktemp -d)"   # run the checkout with throwaway data
```

Always pass a throwaway `--dir` while developing, so your real sessions (`~/.mendcode-v2`) are never touched.

## Check your change

```sh
bun run typecheck
bun scripts/test-fast.ts --all --jobs 6        # the whole suite, skipping files unchanged since they last passed
bun test ./path/to/one.test.ts                 # one file
bun scripts/self-knowledge.ts                  # after changing docs: regenerates what the model knows about MendCode
bun apps/cli/test/views-scenarios.ts --write   # after an intended change to how the terminal draws
```

Do not run a bare `bun test` from the root: it starts every suite in one process.

## What a good pull request looks like

- **One problem per pull request**, with the smallest change that solves it. Unrelated cleanup goes in its own.
- **A test that fails without the change** for every fix, and tests for every new behavior, including its error states.
- **Docs in the same pull request** when behavior changes: `docs/` is what users and the model read.
- **Evidence in the description:** the commands you ran and what they printed; a screenshot or frame for a visual change.
- No new dependencies without discussing them first. Keep `apps/cli` free of network and process calls; the daemon does that work.
- Follow the code around you: naming, comment density, the module layout. Write code and UI text in English.

Commits use plain imperative or descriptive subjects (`cli: a held queue says why`). Pull requests are merged by a maintainer
once CI is green and the review is done.

## License

By contributing you agree that your contribution is released under the [MIT License](LICENSE).
