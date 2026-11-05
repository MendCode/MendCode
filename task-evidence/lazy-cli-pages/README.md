# Lazy terminal pages

Baseline: `1e37c0fe`, clean worktree. Bun 1.3.13, macOS arm64. No MendCode CLI or daemon was launched.

## Build comparison

Run at baseline, retain the metadata, then run the same build after the change:

```sh
bun build --splitting --minify --target=bun --metafile=dist/probe/meta.json --outdir dist/probe/split apps/cli/src/entry.ts
cp dist/probe/meta.json dist/probe/meta-before.json
```

After the change:

```sh
bun build --splitting --minify --target=bun --metafile=dist/probe/meta.json --outdir dist/probe/split apps/cli/src/entry.ts
bun task-evidence/lazy-cli-pages/compare.ts
```

The comparison traverses static output imports from entry, CLI main, app, screen, solo and daemon main. These include the
dynamic entrypoints required by a solo terminal, not optional pages. Chunks are counted once, including shared chunks;
dynamic edges are not followed. It does not import the product. This is a reproducible startup-graph proxy, not a trace of
every runtime import (profiles, pets, onboarding and session content can load more). Raw metadata remains in ignored
`dist/probe/`; output sizes below are decimal bytes/KB, not KiB.

| | Before | After | Reduction |
|---|---:|---:|---:|
| Static-closure chunks | 157 | 154 | 3 |
| Minified JS bytes | 5,527,419 | 5,471,647 | 55,772 |

Files removed from that closure (paths relative to `apps/cli/src/`):

| File | Original source bytes |
|---|---:|
| `github-args.ts` | 8,160 |
| `daemon-service.ts` | 16,026 |
| `help-text.ts` | 19,848 |
| `docs-args.ts` | 3,089 |
| `tsm-args.ts` | 4,869 |
| `view/environment-page.ts` | 12,445 |
| `view/help-page.ts` | 5,637 |
| `view/model-page.ts` | 26,923 |
| `view/tasks-page.ts` | 4,222 |
| `view/appearance-layout.ts` | 1,132 |
| **Total** | **102,351** |

The small `github-invocation.ts` and `view/task-usage.ts` helpers replace the eager parser/page dependencies. The minified
net reduction above already includes their cost and the lazy wrappers. Source bytes and minified bytes are different metrics;
neither is a measured memory saving.

## Behavior and checks

- `bun run typecheck`: passed after the final product edit.
- `bun test apps/cli/test/lazy-cli-pages.test.ts`: passed. Fresh module probes assert the pages and help text are absent
  before use, concurrent Help preload works, unrelated AI-config stays absent, and usage tabs appear only with Usage.
  A fake-screen app opens Help and returns from direct model search without drawing an unloaded renderer. The eager
  baseline violates the absence assertions. Two test-authoring failures (embedded escaping and an unsupported cleanup
  method) were corrected; both tests pass.
- Focused `bun test <file>` runs passed: `model-quick`, `model-page`, `model-page-layout`, `model-providers`, `environment`,
  `environment-paste`, `help-page`, `agents-app`, `startup-first-frame`, `cli-help`, `tsm`, `b06-b07-ui`, `page-nav`, `remote`,
  `home-profile`, `logo-fonts`, `lazy-pages-mascot` (all under `apps/cli/test/`, suffix `.test.ts`).
- `bun test apps/cli/test/footprint.test.ts -t 'page views|every lazily|provider pages|permissions and diagram'`: 4 passed.
- `bun test apps/cli/test/daemon-service.test.ts -t 'daemon lifecycle CLI'`: 10 passed, 2 live-process tests excluded.
- `bun test apps/cli/test/github.test.ts -t 'B48 parser|github install --hosted|GitHub help and lazy'`: 3 passed;
  daemon-backed cases excluded.

Existing AI-config, usage tabs, wizards and most pickers/pet modules were already lazy. Fonts remain available synchronously
for any saved home style; image geometry/detection helpers remain shared with first-frame rendering. The command catalog
also supplies dispatch and feature gating, so it is not slash-menu-only. No visual redesign or deferred first frame was added.
Live footprint, startup latency, CLI entry execution and visual terminal comparison remain unverified by request.
